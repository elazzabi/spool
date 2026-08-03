export const defaultProviderEnvironmentAllowlist = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
] as const;

export function selectProviderEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of new Set(allowlist)) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

export function buildProviderEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  explicit: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...selectProviderEnvironment(source, allowlist), ...explicit };
}
