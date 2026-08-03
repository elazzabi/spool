import { piEnvironmentAllowlist } from './pi.js';

export const piModelProbeArgs = ['--offline', '--no-extensions', '--list-models'] as const;

export function hasPiModelRow(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/i.test(line),
  );
  if (headerIndex < 0) return false;
  return lines
    .slice(headerIndex + 1)
    .some((line) => /^\S+\s+\S+\s+\S+\s+\S+\s+(?:yes|no)\s+(?:yes|no)$/i.test(line));
}

export function piStoredAuthGuidance(ambientCredentialExcluded = false): string {
  return ambientCredentialExcluded
    ? 'no configured models under the runtime credential boundary; sign in with Pi to create stored Pi auth in its config directory (ambient provider credentials are not inherited)'
    : 'no configured models found; sign in with Pi to create stored Pi auth in its config directory';
}

export function hasExcludedPiAmbientCredential(environment: NodeJS.ProcessEnv): boolean {
  const allowed = new Set<string>(piEnvironmentAllowlist);
  return Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      value !== '' &&
      !allowed.has(name) &&
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN)$/i.test(name),
  );
}
