export const SUPPORTED_NODE_RUNTIMES = [
  { nodeMajor: 24, nodeAbi: 137 },
  { nodeMajor: 26, nodeAbi: 147 },
] as const;

export const SUPPORTED_RELEASE_TUPLES = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const;

export const SUPPORTED_RUNTIME_DESCRIPTION =
  'macOS or Linux on x64/arm64 with Node 24 ABI 137 or Node 26 ABI 147';

export function isSupportedNodeRuntime(nodeMajor: number, nodeAbi: number): boolean {
  return SUPPORTED_NODE_RUNTIMES.some(
    (runtime) => runtime.nodeMajor === nodeMajor && runtime.nodeAbi === nodeAbi,
  );
}

export function isSupportedReleaseTuple(platform: string, architecture: string): boolean {
  return (SUPPORTED_RELEASE_TUPLES as readonly string[]).includes(`${platform}-${architecture}`);
}

export function releaseTargetKey(input: {
  platform: string;
  architecture: string;
  nodeMajor: number;
  nodeAbi: number;
}): string {
  return `node${String(input.nodeMajor)}-abi${String(input.nodeAbi)}-${input.platform}-${input.architecture}`;
}
