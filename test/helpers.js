export function createKv(entries = {}) {
  const store = new Map();

  for (const [key, metadata] of Object.entries(entries)) {
    if (metadata && typeof metadata === 'object' && 'value' in metadata) {
      store.set(key, {
        value: metadata.value,
        metadata: metadata.metadata ? { ...metadata.metadata } : null
      });
    } else {
      store.set(key, { value: '', metadata: { ...metadata } });
    }
  }

  return {
    async get(key) {
      const record = store.get(key);
      return record ? record.value : null;
    },
    async getWithMetadata(key) {
      const record = store.get(key);
      return record ? { value: record.value, metadata: record.metadata ? { ...record.metadata } : null } : null;
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
        keys: slice.map((name) => ({ name, metadata: store.get(name).metadata ? { ...store.get(name).metadata } : null })),
        list_complete: next >= names.length,
        cursor: next >= names.length ? undefined : String(next)
      };
    },
    dump() {
      return store;
    }
  };
}
