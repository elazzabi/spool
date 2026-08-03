import type { ProviderAdapter } from './types.js';

export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: Iterable<ProviderAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    const key = normalizeName(adapter.name);
    if (this.#adapters.has(key)) {
      throw new Error(`Provider ${adapter.name} is already registered`);
    }
    this.#adapters.set(key, adapter);
  }

  get(name: string): ProviderAdapter | null {
    return this.#adapters.get(normalizeName(name)) ?? null;
  }

  require(name: string): ProviderAdapter {
    const adapter = this.get(name);
    if (!adapter) throw new Error(`Unknown provider: ${name}`);
    return adapter;
  }

  list(): readonly ProviderAdapter[] {
    return [...this.#adapters.values()];
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
    throw new Error(`Invalid provider name: ${name}`);
  }
  return normalized;
}
