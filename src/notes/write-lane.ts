const lanes = new Map<string, Promise<void>>();

export async function inNoteWriteLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  lanes.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (lanes.get(key) === queued) {
      lanes.delete(key);
    }
  }
}
