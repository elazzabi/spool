export interface ProviderArgvRule {
  readonly names: readonly string[];
  readonly values?: readonly string[];
}

export interface ProviderArgvPolicy {
  readonly reservedArgs: readonly string[];
  readonly deniedRules: readonly ProviderArgvRule[];
}

export function redactSensitiveArgv(args: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const classified = classifySensitiveFlag(arg);
    if (classified?.inlinePrefix) {
      redacted.push(`${classified.inlinePrefix}=[REDACTED]`);
      continue;
    }
    redacted.push(arg);
    if (classified) redactNext = true;
  }
  return redacted;
}

export function assertNoSensitiveArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (classifySensitiveFlag(arg)) {
      throw new Error(
        'Provider flags must not contain credentials, authorization headers, tokens, keys, passwords, or secrets',
      );
    }
  }
}

export function assertAllowedProviderArgv(
  args: readonly string[],
  policy: ProviderArgvPolicy,
): void {
  if (args.some((arg) => arg.length === 0)) {
    throw new Error('Provider argument entries must not be empty');
  }
  assertNoSensitiveArgv(args);

  const reserved = new Set(policy.reservedArgs.map(normalizeComparableArg));
  for (const arg of args) {
    if (reserved.has(normalizeComparableArg(arg))) {
      throw new Error('Custom provider arguments must not replace spool-managed lifecycle flags');
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const parsed = parseFlag(args[index] ?? '');
    if (!parsed) continue;
    for (const rule of policy.deniedRules) {
      if (!rule.names.some((name) => normalizeFlagName(name) === parsed.name)) continue;
      if (rule.values === undefined) {
        throw new Error('Custom provider arguments must not bypass the warned access profile');
      }
      const value = parsed.inlineValue ?? args[index + 1];
      if (
        value !== undefined &&
        rule.values.some(
          (deniedValue) => normalizeFlagValue(deniedValue) === normalizeFlagValue(value),
        )
      ) {
        throw new Error('Custom provider arguments must not bypass the warned access profile');
      }
    }
  }
}

function classifySensitiveFlag(arg: string): { inlinePrefix: string | null } | null {
  const equalsIndex = arg.indexOf('=');
  const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
  const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  const sensitiveWord =
    /(?:^|[-_.])(?:token|key|secret|pass|password|credential|credentials|auth|authorization|header)(?:$|[-_.])/i;
  const compactSensitiveName =
    /^(?:api|access|auth|authorization|client|private)(?:token|key|secret|credential|credentials|password|header)$/i;
  if (
    !sensitiveWord.test(normalizedName) &&
    !compactSensitiveName.test(normalizedName.replace(/^--?/, ''))
  ) {
    return null;
  }
  return { inlinePrefix: equalsIndex >= 0 ? name : null };
}

function normalizeComparableArg(arg: string): string {
  const parsed = parseFlag(arg);
  return parsed?.name ?? arg.toLowerCase();
}

function parseFlag(arg: string): { name: string; inlineValue?: string } | null {
  if (!arg.startsWith('-') || arg === '-') return null;
  const equalsIndex = arg.indexOf('=');
  const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
  return {
    name: normalizeFlagName(name),
    ...(equalsIndex >= 0 ? { inlineValue: arg.slice(equalsIndex + 1) } : {}),
  };
}

function normalizeFlagName(name: string): string {
  return name.replaceAll('_', '-').toLowerCase();
}

function normalizeFlagValue(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}
