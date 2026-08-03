import { watch, type FSWatcher } from 'chokidar';

export class VaultWatcher {
  readonly #vaults: readonly string[];
  readonly #wake: () => void;
  readonly #stabilityThresholdMs: number;
  #watcher: FSWatcher | null = null;
  #coalesced = false;

  constructor(options: {
    vaults: readonly string[];
    wake: () => void;
    stabilityThresholdMs?: number;
  }) {
    this.#vaults = [...options.vaults];
    this.#wake = options.wake;
    this.#stabilityThresholdMs = options.stabilityThresholdMs ?? 200;
  }

  async start(): Promise<void> {
    if (this.#watcher) return;
    const watcher = watch([...this.#vaults], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.#stabilityThresholdMs,
        pollInterval: Math.min(100, this.#stabilityThresholdMs),
      },
    });
    this.#watcher = watcher;
    watcher.on('all', () => this.#queueWake());
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
  }

  async close(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (watcher) await watcher.close();
  }

  #queueWake(): void {
    if (this.#coalesced) return;
    this.#coalesced = true;
    queueMicrotask(() => {
      this.#coalesced = false;
      this.#wake();
    });
  }
}
