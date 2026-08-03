import type { WorkspaceFingerprint, WorkspaceInspection } from './git.js';

export interface FingerprintDifference {
  field: string;
  before: unknown;
  after: unknown;
}

export interface WorkspaceQuarantineDetail {
  version: 1;
  code: 'workspace-changed' | 'sentinel-invalid' | 'release-failed';
  workspace: string;
  summary: string;
  differences: FingerprintDifference[];
  safetyReasons: WorkspaceInspection['reasons'];
  humanAction: string;
}

export function compareWorkspaceFingerprints(
  baseline: WorkspaceFingerprint,
  current: WorkspaceFingerprint | null,
): FingerprintDifference[] {
  if (!current) {
    return [{ field: 'workspace', before: baseline.canonicalWorkspace, after: null }];
  }

  const fields: ReadonlyArray<keyof WorkspaceFingerprint> = [
    'repository',
    'canonicalWorkspace',
    'workspaceIdentity',
    'gitDirectory',
    'gitDirectoryIdentity',
    'gitCommonDirectory',
    'gitCommonDirectoryIdentity',
    'branch',
    'detached',
    'head',
    'remotes',
    'originRepository',
    'status',
    'operations',
  ];
  const differences: FingerprintDifference[] = [];
  for (const field of fields) {
    if (stableJson(baseline[field]) !== stableJson(current[field])) {
      differences.push({ field, before: baseline[field], after: current[field] });
    }
  }
  return differences;
}

export function quarantineDetail(
  code: WorkspaceQuarantineDetail['code'],
  baseline: WorkspaceFingerprint,
  inspection: WorkspaceInspection,
  summary: string,
): WorkspaceQuarantineDetail {
  return {
    version: 1,
    code,
    workspace: baseline.canonicalWorkspace,
    summary,
    differences: compareWorkspaceFingerprints(baseline, inspection.fingerprint),
    safetyReasons: inspection.reasons,
    humanAction: `Inspect ${baseline.canonicalWorkspace}, make it safe without asking spool to clean it, then acknowledge the quarantine.`,
  };
}

export function serializeQuarantineDetail(detail: WorkspaceQuarantineDetail): string {
  return JSON.stringify(detail);
}

export function parseQuarantineDetail(value: string | null): WorkspaceQuarantineDetail | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceQuarantineDetail>;
    if (
      parsed.version !== 1 ||
      typeof parsed.code !== 'string' ||
      typeof parsed.workspace !== 'string' ||
      typeof parsed.summary !== 'string' ||
      !Array.isArray(parsed.differences) ||
      !Array.isArray(parsed.safetyReasons) ||
      typeof parsed.humanAction !== 'string'
    ) {
      return null;
    }
    return parsed as WorkspaceQuarantineDetail;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
