type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): T {
  const safeTtlSeconds = Math.max(1, Math.floor(ttlSeconds));
  store.set(key, {
    value,
    expiresAt: Date.now() + safeTtlSeconds * 1000,
  });
  return value;
}

export function cacheDel(key: string): void {
  store.delete(key);
}

export function cacheDelPrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

export function cacheWrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) return Promise.resolve(cached);

  return loader().then((value) => cacheSet(key, value, ttlSeconds));
}
