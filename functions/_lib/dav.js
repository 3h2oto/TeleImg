import { INTERNAL_KEY_PREFIX, readInternalJson, writeInternalJson } from './kv.js';

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
