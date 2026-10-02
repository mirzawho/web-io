/**
 * The "memory" driver: entries held in this process, keyed exactly like the Redis ones. It
 * needs no external dependency and is deliberately process-local, which is all an optional
 * response cache requires.
 */

const memoryEntries = new Map<string, { value: string; expiresAt: number }>();

export function memoryGet(key: string): string | null {
  const entry = memoryEntries.get(key);
  if (entry === undefined) return null;

  if (entry.expiresAt <= Date.now()) {
    // An expired entry is removed as it is found, so a key nobody reads again does not
    // stay in the map for the life of the process.
    memoryEntries.delete(key);
    return null;
  }

  return entry.value;
}

export function memorySet(key: string, value: string, ttlSeconds: number): void {
  memoryEntries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
}
