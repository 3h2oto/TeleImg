import { getDavBaseName, getDavEntry, getDavParentPath, listDavChildren, materializeProjectedDavEntries, normalizeDavPath } from '../../../_lib/dav.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { getEnrichedRecord } from '../../../_lib/kv.js';

function normalizeRequestedPath(input) {
  const value = typeof input === 'string' && input.trim() ? input.trim() : '/';
  const pathname = value.startsWith('/') ? `/dav${value}` : `/dav/${value}`;
  return normalizeDavPath(pathname, '/dav');
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed('GET');
  }

  const url = new URL(context.request.url);
  const davPath = normalizeRequestedPath(url.searchParams.get('path'));

  if (davPath === '/') {
    await materializeProjectedDavEntries(context.env);
  }

  const entry = await getDavEntry(context.env, davPath);
  if (!entry || entry.kind !== 'collection') {
    return json({ error: 'Folder not found.' }, { status: 404 });
  }

  const children = await listDavChildren(context.env, davPath);
  const folders = children
    .filter((child) => child.kind === 'collection')
    .map((child) => ({
      path: child.path,
      name: child.name || getDavBaseName(child.path) || '/',
      createdAt: child.createdAt || 0,
      updatedAt: child.updatedAt || 0
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const fileRecords = await Promise.all(children
    .filter((child) => child.kind === 'file' && child.storageKey)
    .map(async (child) => {
      const record = await getEnrichedRecord(context.env, child.storageKey);
      if (!record) {
        return null;
      }

      return {
        ...record,
        davPath: child.path,
        davName: child.name || getDavBaseName(child.path) || record.metadata?.fileName || record.name,
        contentType: child.contentType || ''
      };
    }));

  const files = fileRecords
    .filter(Boolean)
    .sort((left, right) => right.metadata.TimeStamp - left.metadata.TimeStamp);

  return json({
    path: davPath,
    name: davPath === '/' ? '/' : (entry.name || getDavBaseName(davPath)),
    parentPath: getDavParentPath(davPath),
    folders,
    files,
    counts: {
      folders: folders.length,
      files: files.length
    }
  });
}
