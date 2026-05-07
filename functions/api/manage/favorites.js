import { getDavParentPath, listAllDavEntries, materializeProjectedDavEntries } from '../../_lib/dav.js';
import { json } from '../../_lib/http.js';
import { listFavoriteRecords } from '../../_lib/kv.js';

export async function onRequest(context) {
  await materializeProjectedDavEntries(context.env);

  const url = new URL(context.request.url);
  const limit = url.searchParams.get('limit') || '20';
  const records = await listFavoriteRecords(context.env, { limit });
  const entries = await listAllDavEntries(context.env);

  const davPathByStorageKey = new Map();
  for (const entry of entries) {
    if (entry?.kind !== 'file' || !entry.storageKey || davPathByStorageKey.has(entry.storageKey)) {
      continue;
    }
    davPathByStorageKey.set(entry.storageKey, entry.path);
  }

  const items = records.keys.map((record) => {
    const davPath = davPathByStorageKey.get(record.name) || null;
    return {
      ...record,
      davPath,
      folderPath: davPath ? (getDavParentPath(davPath) || '/') : '/'
    };
  });

  return json({
    items,
    count: items.length,
    scanned: records.scanned
  });
}
