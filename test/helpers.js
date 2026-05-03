export function createKv(entries = {}) {
  const store = new Map();

  for (const [key, metadata] of Object.entries(entries)) {
    store.set(key, { value: '', metadata: { ...metadata } });
  }

  return {
    async getWithMetadata(key) {
      const record = store.get(key);
      return record ? { value: record.value, metadata: { ...record.metadata } } : null;
    },
    async put(key, value, options = {}) {
      store.set(key, { value, metadata: options.metadata ? { ...options.metadata } : null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ limit = 1000, cursor, prefix } = {}) {
      const names = [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start, start + limit);
      const next = start + slice.length;
      return {
        keys: slice.map((name) => ({ name, metadata: { ...store.get(name).metadata } })),
        list_complete: next >= names.length,
        cursor: next >= names.length ? undefined : String(next)
      };
    },
    dump() {
      return store;
    }
  };
}
