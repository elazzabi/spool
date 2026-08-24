import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isSupportedNodeRuntime,
  isSupportedReleaseTuple,
  releaseTargetKey,
  SUPPORTED_NODE_RUNTIMES,
  SUPPORTED_RELEASE_TUPLES,
  SUPPORTED_RUNTIME_DESCRIPTION,
} from './runtime-support.js';

const RELEASE_MANIFEST_TIMEOUT_MS = 30_000;
const RELEASE_ARTIFACT_TIMEOUT_MS = 300_000;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;

export interface AcquiredRelease {
  candidateDirectory: string;
  version: string;
  releaseSource: string;
  artifactDigest: string;
  nodeAbi: number;
  cleanup(): void;
}

export interface ReleaseAcquisitionRequest {
  releaseBaseUrl: string;
  version?: string;
  runtimeIdentity?: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeMajor: number;
    nodeAbi: number;
  };
}

export class ReleaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseUnavailableError';
  }
}

export async function acquireRelease(request: ReleaseAcquisitionRequest): Promise<AcquiredRelease> {
  const runtime = request.runtimeIdentity ?? {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    nodeAbi: Number(process.versions.modules),
  };
  if (
    !isSupportedNodeRuntime(runtime.nodeMajor, runtime.nodeAbi) ||
    !isSupportedReleaseTuple(runtime.platform, runtime.architecture)
  ) {
    throw new ReleaseUnavailableError(`Managed updates require ${SUPPORTED_RUNTIME_DESCRIPTION}`);
  }
  const exactVersion = request.version;
  if (exactVersion && !/^\d+\.\d+\.\d+$/.test(exactVersion)) {
    throw new ReleaseUnavailableError(`Expected an exact stable version: ${exactVersion}`);
  }
  const releaseSource = exactVersion
    ? `${request.releaseBaseUrl}/download/v${exactVersion}`
    : `${request.releaseBaseUrl}/latest/download`;
  const manifest = await fetchJson(`${releaseSource}/release-manifest-v2.json`);
  const artifact = validateManifest(manifest, runtime, exactVersion);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'spool-update-'));
  try {
    const archivePath = path.join(temporaryRoot, artifact.filename);
    const archive = await fetchBuffer(
      `${releaseSource}/${artifact.filename}`,
      artifact.size,
      RELEASE_ARTIFACT_TIMEOUT_MS,
    );
    if (archive.length !== artifact.size) throw new Error('Release artifact size mismatch');
    if (createHash('sha256').update(archive).digest('hex') !== artifact.sha256) {
      throw new Error('Release artifact SHA-256 mismatch');
    }
    writeFileSync(archivePath, archive);
    assertSafeTarPaths(archivePath);
    const candidateDirectory = path.join(temporaryRoot, 'candidate');
    mkdirSync(candidateDirectory);
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', candidateDirectory], {
      encoding: 'utf8',
    });
    if (extracted.status !== 0) throw new Error(`Could not extract release: ${extracted.stderr}`);
    return {
      candidateDirectory,
      version: (manifest as { version: string }).version,
      releaseSource,
      artifactDigest: artifact.sha256,
      nodeAbi: artifact.nodeAbi,
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function deriveReleaseBaseUrl(releaseSource: string): string {
  const match = /^(.*\/releases)\/(?:latest\/download|download\/v\d+\.\d+\.\d+)$/.exec(
    releaseSource.replace(/\/$/, ''),
  );
  if (!match?.[1]) throw new ReleaseUnavailableError('Managed release source is not updateable');
  return match[1];
}

async function fetchJson(url: string): Promise<unknown> {
  const body = await fetchBuffer(url, MAX_RELEASE_MANIFEST_BYTES, RELEASE_MANIFEST_TIMEOUT_MS);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ReleaseUnavailableError('Release manifest is malformed');
  }
}

async function fetchBuffer(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) {
      throw new ReleaseUnavailableError(`Release unavailable (${String(response.status)})`);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
      if (BigInt(declaredLength) > BigInt(maxBytes)) {
        throw new ReleaseUnavailableError('Release response exceeds its allowed size');
      }
    }
    if (!response.body) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const abortReader = () => {
      void reader.cancel(controller.signal.reason).catch(() => undefined);
    };
    controller.signal.addEventListener('abort', abortReader, { once: true });
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (result.done) break;
        receivedBytes += result.value.byteLength;
        if (receivedBytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new ReleaseUnavailableError('Release response exceeds its allowed size');
        }
        chunks.push(result.value);
      }
    } finally {
      controller.signal.removeEventListener('abort', abortReader);
      reader.releaseLock();
    }
    return Buffer.concat(chunks, receivedBytes);
  } catch (error) {
    if (error instanceof ReleaseUnavailableError) throw error;
    if (
      controller.signal.aborted ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      throw new ReleaseUnavailableError('Release download timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateManifest(
  value: unknown,
  runtime: { platform: string; architecture: string; nodeMajor: number; nodeAbi: number },
  exactVersion: string | undefined,
) {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.version !== 'string') {
    throw new ReleaseUnavailableError('Release manifest metadata is invalid');
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !/^[0-9a-f]{40}$/.test(String(value.sourceRevision))
  ) {
    throw new ReleaseUnavailableError('Release manifest version or revision is invalid');
  }
  if (exactVersion && value.version !== exactVersion) {
    throw new ReleaseUnavailableError(`Release manifest does not describe ${exactVersion}`);
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== SUPPORTED_RELEASE_TUPLES.length * SUPPORTED_NODE_RUNTIMES.length
  ) {
    throw new ReleaseUnavailableError('Release manifest matrix is incomplete');
  }
  const seen = new Set<string>();
  let selected: ReturnType<typeof artifactDescriptor> | undefined;
  for (const candidate of value.artifacts) {
    const artifact = artifactDescriptor(candidate, value.version);
    const target = releaseTargetKey(artifact);
    if (!isSupportedReleaseTuple(artifact.platform, artifact.architecture) || seen.has(target)) {
      throw new ReleaseUnavailableError(`Invalid release target: ${target}`);
    }
    seen.add(target);
    if (
      artifact.platform === runtime.platform &&
      artifact.architecture === runtime.architecture &&
      artifact.nodeMajor === runtime.nodeMajor &&
      artifact.nodeAbi === runtime.nodeAbi
    ) {
      selected = artifact;
    }
  }
  for (const supportedRuntime of SUPPORTED_NODE_RUNTIMES) {
    for (const tuple of SUPPORTED_RELEASE_TUPLES) {
      const [platform, architecture] = tuple.split('-') as [string, string];
      if (!seen.has(releaseTargetKey({ ...supportedRuntime, platform, architecture }))) {
        throw new ReleaseUnavailableError('Release manifest matrix is incomplete');
      }
    }
  }
  if (!selected) {
    throw new ReleaseUnavailableError('Release does not support the running Node ABI');
  }
  return selected;
}

function artifactDescriptor(value: unknown, version: string) {
  if (!isRecord(value)) throw new ReleaseUnavailableError('Invalid artifact descriptor');
  const platform = value.platform;
  const architecture = value.architecture;
  const nodeMajor = value.nodeMajor;
  const nodeAbi = value.nodeAbi;
  const filename = value.filename;
  const sha256 = value.sha256;
  const size = value.size;
  if (
    typeof platform !== 'string' ||
    typeof architecture !== 'string' ||
    typeof nodeMajor !== 'number' ||
    typeof nodeAbi !== 'number' ||
    !isSupportedNodeRuntime(nodeMajor, nodeAbi) ||
    typeof filename !== 'string' ||
    filename !==
      `spool-v${version}-node${String(nodeMajor)}-abi${String(nodeAbi)}-${platform}-${architecture}.tar.gz` ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(size) ||
    (size as number) <= 0
  ) {
    throw new ReleaseUnavailableError('Invalid artifact descriptor');
  }
  return { platform, architecture, nodeMajor, nodeAbi, filename, sha256, size: size as number };
}

function assertSafeTarPaths(archivePath: string) {
  const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`Could not inspect release archive: ${listed.stderr}`);
  for (const entry of listed.stdout.split('\n').filter(Boolean)) {
    if (path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
      throw new Error(`Release archive contains unsafe path: ${entry}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
