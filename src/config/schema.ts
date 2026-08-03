import { z } from 'zod';

export const dayNames = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const providerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  executable: z.string().trim().min(1, 'provider executable cannot be empty'),
  directive: z
    .string()
    .trim()
    .regex(/^@[A-Za-z][A-Za-z0-9_-]*$/, 'provider directive must look like @claude')
    .optional(),
  defaultArgs: z.array(z.string()).default([]),
});

const repositorySchema = z.strictObject({
  repository: z.string().trim().min(1),
  clones: z.array(z.string().trim().min(1)).min(1, 'repository pool needs at least one clone'),
});

export const rawConfigSchema = z.strictObject({
  vaults: z.array(z.string().trim().min(1)).min(1, 'at least one vault is required'),
  stateDirectory: z.string().trim().min(1),
  timeZone: z.string().trim().min(1),
  pollIntervalSeconds: z.number().int().min(1).max(45),
  dayAliases: z.partialRecord(z.enum(dayNames), z.array(z.string().trim().min(1))).default({}),
  providers: z
    .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), providerSchema)
    .refine((providers) => Object.keys(providers).length > 0, 'at least one provider is required'),
  repositories: z.array(repositorySchema).min(1, 'at least one repository mapping is required'),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

export interface ProviderConfig {
  name: string;
  enabled: boolean;
  executable: string;
  executableResolved: boolean;
  directive: string;
  defaultArgs: string[];
}

export interface RepositoryConfig {
  repository: string;
  clones: string[];
}

export interface SpoolConfig {
  configPath: string;
  vaults: string[];
  stateDirectory: string;
  timeZone: string;
  pollIntervalSeconds: number;
  dayAliases: Partial<Record<(typeof dayNames)[number], string[]>>;
  providers: ProviderConfig[];
  repositories: RepositoryConfig[];
}

const repositoryPart = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function normalizeGitHubRepository(value: string): string {
  const input = value.trim();
  let parts: string[];

  const sshMatch = /^git@github\.com:(.+)$/i.exec(input);
  if (sshMatch?.[1]) {
    parts = sshMatch[1].split('/');
  } else if (/^(?:https?|ssh|git):\/\//i.test(input) || /^github\.com\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(/^github\.com\//i.test(input) ? `https://${input}` : input);
    } catch {
      throw new Error(`Invalid GitHub repository identity: ${value}`);
    }
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) {
      throw new Error(`Expected a GitHub repository identity, received: ${value}`);
    }
    parts = url.pathname.split('/').filter(Boolean);
  } else {
    parts = input.split('/').filter(Boolean);
  }

  const owner = parts[0];
  const rawRepository = parts[1];
  const repository = rawRepository?.replace(/\.git$/i, '');
  if (!owner || !repository || !repositoryPart.test(owner) || !repositoryPart.test(repository)) {
    throw new Error(`Invalid GitHub repository identity: ${value}`);
  }

  return `${owner}/${repository}`.toLowerCase();
}

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
