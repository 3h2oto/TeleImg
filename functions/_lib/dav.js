import { INTERNAL_KEY_PREFIX, isInternalKey, normalizeMetadata, readInternalJson, updateMetadata, writeInternalJson } from './kv.js';

export const DAV_ENTRY_PREFIX = `${INTERNAL_KEY_PREFIX}dav/entries`;

function escapeSegment(segment) {
  return segment.replace(/\\/g, '/');
}

export function normalizeDavPath(pathname, basePath = '/dav') {
  const path = pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname || '/';
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part).trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error('Invalid DAV path.');
    }
  }

  return parts.length === 0 ? '/' : `/${parts.map(escapeSegment).join('/')}`;
}

export function getDavEntryKey(davPath) {
  return davPath === '/' ? `${DAV_ENTRY_PREFIX}/` : `${DAV_ENTRY_PREFIX}${davPath}`;
}

export function getDavParentPath(davPath) {
  if (davPath === '/') {
    return null;
  }

  const index = davPath.lastIndexOf('/');
  return index <= 0 ? '/' : davPath.slice(0, index);
}

export function getDavBaseName(davPath) {
  if (davPath === '/') {
    return '';
  }

  return davPath.slice(davPath.lastIndexOf('/') + 1);
}

export function buildDavHref(davPath, isCollection) {
  const encodedPath = davPath === '/'
    ? ''
    : davPath.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
  const href = encodedPath ? `/dav/${encodedPath}` : '/dav';
  return isCollection ? `${href}/` : href;
}

function sanitizeDavLeafName(name, fallback) {
  const candidate = String(name || fallback || '')
    .trim()
    .replace(/[\\\/]+/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
  return candidate || fallback || 'file';
}

function appendStableSuffix(name, storageKey, counter = '') {
  const suffix = `__${String(storageKey || 'item').slice(0, 12)}${counter ? `_${counter}` : ''}`;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  }
  return `${name}${suffix}`;
}

function inferDavContentType(fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

async function loadStorageRecord(env, storageKey, cache) {
  if (!storageKey) {
    return null;
  }

  if (cache?.has(storageKey)) {
    return cache.get(storageKey);
  }

  const record = await env.img_url.getWithMetadata(storageKey).catch(() => null);
  const normalized = record
    ? {
        ...record,
        metadata: record.metadata ? normalizeMetadata(storageKey, record.metadata) : null
      }
    : null;

  cache?.set(storageKey, normalized);
  return normalized;
}

function pickPreferredAlias(current, candidate, preferredFileName = '') {
  const currentMatchesPreferred = getDavBaseName(current.path) === preferredFileName;
  const candidateMatchesPreferred = getDavBaseName(candidate.path) === preferredFileName;

  if (currentMatchesPreferred !== candidateMatchesPreferred) {
    return candidateMatchesPreferred ? candidate : current;
  }

  const currentUpdatedAt = Number(current.updatedAt || 0);
  const candidateUpdatedAt = Number(candidate.updatedAt || 0);
  if (currentUpdatedAt !== candidateUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
  }

  const currentCreatedAt = Number(current.createdAt || 0);
  const candidateCreatedAt = Number(candidate.createdAt || 0);
  if (currentCreatedAt !== candidateCreatedAt) {
    return candidateCreatedAt > currentCreatedAt ? candidate : current;
  }

  return candidate.path.localeCompare(current.path) < 0 ? candidate : current;
}

export function createDavEtag(entry) {
  const base = [
    entry.kind,
    entry.storageKey || '',
    entry.updatedAt || 0,
    entry.size || 0
  ].join(':');
  return `"${base}"`;
}

export function serializeDavDate(value) {
  return new Date(Number(value || Date.now())).toUTCString();
}

export async function getDavEntry(env, davPath) {
  if (davPath === '/') {
    return {
      kind: 'collection',
      path: '/',
      name: '',
      createdAt: 0,
      updatedAt: 0
    };
  }

  const entry = await readInternalJson(env, getDavEntryKey(davPath));
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.kind === 'file') {
    if (!entry.storageKey) {
      await deleteDavEntry(env, davPath);
      return null;
    }

    const record = await env.img_url.getWithMetadata(entry.storageKey).catch(() => null);
    if (!record) {
      await deleteDavEntry(env, davPath);
      return null;
    }
  }

  return entry;
}

export async function putDavEntry(env, davPath, entry) {
  const now = Date.now();
  const normalized = {
    kind: entry.kind,
    path: davPath,
    name: getDavBaseName(davPath),
    storageKey: entry.storageKey || '',
    size: Number.isFinite(entry.size) ? entry.size : 0,
    contentType: entry.contentType || '',
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
    updatedAt: now
  };
  await writeInternalJson(env, getDavEntryKey(davPath), normalized);
  return normalized;
}

export async function deleteDavEntry(env, davPath) {
  if (davPath === '/') {
    return;
  }
  await env.img_url.delete(getDavEntryKey(davPath));
}

export async function ensureDavCollections(env, davPath) {
  let current = getDavParentPath(davPath);
  const stack = [];
  while (current && current !== '/') {
    stack.push(current);
    current = getDavParentPath(current);
  }

  while (stack.length > 0) {
    const next = stack.pop();
    const existing = await getDavEntry(env, next);
    if (!existing) {
      await putDavEntry(env, next, {
        kind: 'collection',
        createdAt: Date.now()
      });
    }
  }
}

export async function listDavChildren(env, davPath) {
  const prefix = davPath === '/' ? `${DAV_ENTRY_PREFIX}/` : `${DAV_ENTRY_PREFIX}${davPath}/`;
  const seen = new Set();
  const children = [];
  let cursor;
  let done = false;

  while (!done) {
    const page = await env.img_url.list({ prefix, cursor, limit: 1000 });
    cursor = page.cursor;

    for (const item of page.keys || []) {
      const remainder = item.name.slice(prefix.length);
      if (!remainder) {
        continue;
      }

      const [segment] = remainder.split('/');
      const childPath = davPath === '/' ? `/${segment}` : `${davPath}/${segment}`;
      if (seen.has(childPath)) {
        continue;
      }
      seen.add(childPath);
      const entry = await getDavEntry(env, childPath);
      children.push(entry || {
        kind: 'collection',
        path: childPath,
        name: getDavBaseName(childPath),
        createdAt: 0,
        updatedAt: 0
      });
    }

    done = page.list_complete;
  }

  children.sort((left, right) => left.path.localeCompare(right.path));
  return children;
}

export async function listAllDavEntries(env) {
  const entries = [];
  let cursor;
  let done = false;

  while (!done) {
    const page = await env.img_url.list({ prefix: DAV_ENTRY_PREFIX, cursor, limit: 1000 });
    cursor = page.cursor;

    for (const item of page.keys || []) {
      const entry = await readInternalJson(env, item.name);
      if (entry?.path && entry.path !== '/') {
        entries.push(entry);
      }
    }

    done = page.list_complete;
  }

  return entries;
}

export async function materializeProjectedDavEntries(env) {
  const existingEntries = await listAllDavEntries(env);
  const recordCache = new Map();
  const stalePaths = new Set();
  const dedupedEntries = [];
  const fileEntriesByStorageKey = new Map();

  for (const entry of existingEntries) {
    if (entry.kind !== 'file') {
      dedupedEntries.push(entry);
      continue;
    }

    if (!entry.storageKey) {
      stalePaths.add(entry.path);
      continue;
    }

    const record = await loadStorageRecord(env, entry.storageKey, recordCache);
    if (!record) {
      stalePaths.add(entry.path);
      continue;
    }

    const current = fileEntriesByStorageKey.get(entry.storageKey);
    if (!current) {
      fileEntriesByStorageKey.set(entry.storageKey, entry);
      continue;
    }

    const preferred = pickPreferredAlias(current, entry, record.metadata?.fileName || '');
    const stale = preferred === entry ? current : entry;
    stalePaths.add(stale.path);
    fileEntriesByStorageKey.set(entry.storageKey, preferred);
  }

  for (const entry of fileEntriesByStorageKey.values()) {
    dedupedEntries.push(entry);
  }

  for (const stalePath of stalePaths) {
    await deleteDavEntry(env, stalePath);
  }

  const mappedStorageKeys = new Set(dedupedEntries.filter((entry) => entry.kind === 'file' && entry.storageKey).map((entry) => entry.storageKey));
  const occupiedPaths = new Set(dedupedEntries.map((entry) => entry.path));
  const records = [];

  let cursor;
  let done = false;
  while (!done) {
    const page = await env.img_url.list({ cursor, limit: 1000 });
    cursor = page.cursor;

    for (const item of page.keys || []) {
      if (isInternalKey(item.name)) {
        continue;
      }

      if (mappedStorageKeys.has(item.name)) {
        continue;
      }

      const metadata = normalizeMetadata(item.name, item.metadata);
      records.push({
        storageKey: item.name,
        fileName: sanitizeDavLeafName(metadata.fileName, item.name),
        size: metadata.fileSize,
        updatedAt: metadata.TimeStamp
      });
    }

    done = page.list_complete;
  }

  records.sort((left, right) => left.storageKey.localeCompare(right.storageKey));

  for (const record of records) {
    let candidate = `/${record.fileName}`;
    if (occupiedPaths.has(candidate)) {
      let nextName = appendStableSuffix(record.fileName, record.storageKey);
      candidate = `/${nextName}`;
      let counter = 1;
      while (occupiedPaths.has(candidate)) {
        nextName = appendStableSuffix(record.fileName, record.storageKey, counter);
        candidate = `/${nextName}`;
        counter += 1;
      }
    }

    occupiedPaths.add(candidate);
    mappedStorageKeys.add(record.storageKey);
    await putDavEntry(env, candidate, {
      kind: 'file',
      storageKey: record.storageKey,
      size: record.size,
      contentType: inferDavContentType(record.fileName),
      createdAt: record.updatedAt
    });
  }
}

export async function renameDavBackedFile(env, storageKey, fileName) {
  if (!storageKey || !fileName) {
    return null;
  }

  return updateMetadata(env, storageKey, (current) => ({
    ...current,
    fileName
  }));
}

export async function moveDavTree(env, fromPath, toPath) {
  const source = await getDavEntry(env, fromPath);
  if (!source) {
    return { success: false, status: 404, error: 'Source path not found.' };
  }

  if (await getDavEntry(env, toPath)) {
    return { success: false, status: 412, error: 'Destination already exists.' };
  }

  await ensureDavCollections(env, toPath);

  const prefix = fromPath === '/' ? `${DAV_ENTRY_PREFIX}/` : `${DAV_ENTRY_PREFIX}${fromPath}`;
  const replacements = [];
  let cursor;
  let done = false;

  while (!done) {
    const page = await env.img_url.list({ prefix, cursor, limit: 1000 });
    cursor = page.cursor;
    for (const item of page.keys || []) {
      const entry = await readInternalJson(env, item.name);
      if (!entry?.path) {
        continue;
      }
      const nextPath = entry.path === fromPath ? toPath : `${toPath}${entry.path.slice(fromPath.length)}`;
      replacements.push({ oldPath: entry.path, nextPath, entry });
    }
    done = page.list_complete;
  }

  if (replacements.length === 0) {
    replacements.push({ oldPath: fromPath, nextPath: toPath, entry: source });
  }

  for (const item of replacements) {
    await putDavEntry(env, item.nextPath, {
      ...item.entry,
      createdAt: item.entry.createdAt
    });
  }

  for (const item of replacements) {
    await deleteDavEntry(env, item.oldPath);
  }

  return { success: true };
}
