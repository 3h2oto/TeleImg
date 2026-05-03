const DEFAULT_LABEL = 'None';
const DEFAULT_LIST_TYPE = 'None';

export function sanitizeFileName(input, fallback) {
  const value = String(input || fallback || '').trim();
  return value.length > 0 ? value.slice(0, 240) : fallback;
}

export function normalizeMetadata(key, metadata = {}) {
  return {
    TimeStamp: Number.isFinite(metadata?.TimeStamp) ? metadata.TimeStamp : Date.now(),
    ListType: typeof metadata?.ListType === 'string' && metadata.ListType.length > 0 ? metadata.ListType : DEFAULT_LIST_TYPE,
    Label: typeof metadata?.Label === 'string' && metadata.Label.length > 0 ? metadata.Label : DEFAULT_LABEL,
    liked: Boolean(metadata?.liked),
    fileName: sanitizeFileName(metadata?.fileName, key),
    fileSize: Number.isFinite(metadata?.fileSize) ? metadata.fileSize : 0
  };
}

export async function getRecord(env, key) {
  const record = await env.img_url.getWithMetadata(key);
  return {
    value: record?.value ?? '',
    metadata: record?.metadata ? normalizeMetadata(key, record.metadata) : null
  };
}

export async function getOrCreateMetadata(env, key) {
  const record = await getRecord(env, key);
  if (record.metadata) {
    return record.metadata;
  }

  const metadata = normalizeMetadata(key, {});
  await env.img_url.put(key, record.value ?? '', { metadata });
  return metadata;
}

export async function updateMetadata(env, key, updater) {
  const current = await getOrCreateMetadata(env, key);
  const next = normalizeMetadata(key, await updater({ ...current }));
  await env.img_url.put(key, '', { metadata: next });
  return next;
}

function matchesSearch(entry, search) {
  if (!search) {
    return true;
  }

  const haystacks = [entry.name, entry.metadata?.fileName]
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  return haystacks.some((value) => value.includes(search));
}

function enrichKey(entry) {
  return {
    ...entry,
    metadata: normalizeMetadata(entry.name, entry.metadata),
    url: `/file/${encodeURIComponent(entry.name)}`
  };
}

export async function listRecords(env, { limit = 100, cursor, prefix, search } = {}) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 100, 200));
  const normalizedSearch = typeof search === 'string' && search.trim().length > 0
    ? search.trim().toLowerCase()
    : '';

  if (!normalizedSearch) {
    const result = await env.img_url.list({ limit: safeLimit, cursor, prefix });
    return {
      ...result,
      keys: result.keys.map(enrichKey).sort((left, right) => right.metadata.TimeStamp - left.metadata.TimeStamp)
    };
  }

  const pageSize = 1000;
  const maxScanned = 5000;
  let currentCursor = cursor;
  let scanned = 0;
  let done = false;
  const matches = [];

  while (!done && matches.length < safeLimit && scanned < maxScanned) {
    const page = await env.img_url.list({ limit: pageSize, cursor: currentCursor, prefix });
    currentCursor = page.cursor;
    scanned += page.keys.length;

    for (const entry of page.keys) {
      if (matchesSearch(entry, normalizedSearch)) {
        matches.push(enrichKey(entry));
        if (matches.length >= safeLimit) {
          break;
        }
      }
    }

    done = page.list_complete;
  }

  matches.sort((left, right) => right.metadata.TimeStamp - left.metadata.TimeStamp);

  return {
    keys: matches,
    list_complete: done || !currentCursor,
    cursor: done ? undefined : currentCursor,
    scanned
  };
}
