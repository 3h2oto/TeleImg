import { requireDashboardAccess } from '../_lib/auth.js';
import { deleteTelegramBackedRecord } from '../_lib/telegram-delete.js';
import {
  buildDavHref,
  createDavEtag,
  deleteDavEntry,
  ensureDavCollections,
  getDavBaseName,
  getDavEntry,
  listDavChildren,
  moveDavTree,
  normalizeDavPath,
  putDavEntry
} from '../_lib/dav.js';
import { json, methodNotAllowed, serviceUnavailable, text } from '../_lib/http.js';
import { getRuntimeConfig } from '../_lib/runtime-config.js';
import { uploadFileToTelegram } from '../_lib/telegram-upload.js';

const DAV_ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function davHeaders(extra = {}) {
  return {
    DAV: '1',
    Allow: DAV_ALLOW,
    'MS-Author-Via': 'DAV',
    ...extra
  };
}

function toHttpDate(value) {
  return new Date(Number(value || Date.now())).toUTCString();
}

function propfindResponseXml(entries) {
  const rows = entries.map((entry) => {
    const isCollection = entry.kind === 'collection';
    const resourceType = isCollection ? '<D:collection/>' : '';
    const contentLength = isCollection ? '' : `<D:getcontentlength>${Number(entry.size || 0)}</D:getcontentlength>`;
    const contentType = !isCollection && entry.contentType ? `<D:getcontenttype>${xmlEscape(entry.contentType)}</D:getcontenttype>` : '';
    const etag = !isCollection ? `<D:getetag>${xmlEscape(createDavEtag(entry))}</D:getetag>` : '';
    return `
      <D:response>
        <D:href>${xmlEscape(buildDavHref(entry.path, isCollection))}</D:href>
        <D:propstat>
          <D:prop>
            <D:displayname>${xmlEscape(entry.name || (entry.path === '/' ? 'dav' : getDavBaseName(entry.path)))}</D:displayname>
            <D:resourcetype>${resourceType}</D:resourcetype>
            ${contentLength}
            ${contentType}
            ${etag}
            <D:getlastmodified>${xmlEscape(toHttpDate(entry.updatedAt))}</D:getlastmodified>
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>
    `;
  }).join('');

  return `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
${rows}
</D:multistatus>`;
}

async function deleteDavTree(env, entry) {
  if (entry.kind === 'collection') {
    const children = await listDavChildren(env, entry.path);
    for (const child of children) {
      if (child) {
        await deleteDavTree(env, child);
      }
    }
    await deleteDavEntry(env, entry.path);
    return;
  }

  if (entry.storageKey) {
    const deleted = await deleteTelegramBackedRecord(env, entry.storageKey);
    if (!deleted.success && deleted.status !== 404) {
      throw new Error(deleted.error || `Failed to delete ${entry.storageKey}.`);
    }
  }

  await deleteDavEntry(env, entry.path);
}

async function proxyFileRequest(request, requestUrl, storageKey) {
  const proxyUrl = new URL(`/file/${encodeURIComponent(storageKey)}`, requestUrl.origin);
  const headers = new Headers();
  for (const name of ['accept', 'range', 'if-modified-since', 'if-none-match']) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set('x-teleimg-admin-preview', '1');

  return fetch(proxyUrl, {
    method: request.method,
    headers
  });
}

function resolveDavPath(request) {
  const url = new URL(request.url);
  return normalizeDavPath(url.pathname, '/dav');
}

export async function onRequest(context) {
  const gate = await requireDashboardAccess(context);
  if (gate) {
    return gate;
  }

  if (!context.env.img_url) {
    return serviceUnavailable('img_url KV binding is required.');
  }

  const method = context.request.method.toUpperCase();
  const requestUrl = new URL(context.request.url);
  let davPath;
  try {
    davPath = resolveDavPath(context.request);
  } catch (error) {
    return text(error instanceof Error ? error.message : 'Invalid DAV path.', { status: 400, headers: davHeaders() });
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: davHeaders() });
  }

  if (method === 'PROPFIND') {
    const entry = await getDavEntry(context.env, davPath);
    if (!entry) {
      return text('Not found.', { status: 404, headers: davHeaders() });
    }

    const depth = context.request.headers.get('depth') || '0';
    if (!['0', '1'].includes(depth)) {
      return text('Depth not supported.', { status: 400, headers: davHeaders() });
    }

    const entries = [entry];
    if (depth === '1' && entry.kind === 'collection') {
      entries.push(...await listDavChildren(context.env, davPath));
    }

    return new Response(propfindResponseXml(entries), {
      status: 207,
      headers: davHeaders({ 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' })
    });
  }

  if (method === 'HEAD' || method === 'GET') {
    const entry = await getDavEntry(context.env, davPath);
    if (!entry) {
      return text('Not found.', { status: 404, headers: davHeaders() });
    }

    if (entry.kind !== 'file' || !entry.storageKey) {
      return text('Cannot download a collection.', { status: 405, headers: davHeaders() });
    }

    const response = await proxyFileRequest(context.request, requestUrl, entry.storageKey);
    const headers = new Headers(response.headers);
    Object.entries(davHeaders()).forEach(([key, value]) => headers.set(key, value));
    return new Response(method === 'HEAD' ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  if (method === 'MKCOL') {
    if (davPath === '/') {
      return text('Collection already exists.', { status: 405, headers: davHeaders() });
    }

    if (await getDavEntry(context.env, davPath)) {
      return text('Path already exists.', { status: 405, headers: davHeaders() });
    }

    await ensureDavCollections(context.env, davPath);
    await putDavEntry(context.env, davPath, {
      kind: 'collection',
      createdAt: Date.now()
    });

    return new Response(null, { status: 201, headers: davHeaders() });
  }

  if (method === 'PUT') {
    if (davPath === '/') {
      return text('Cannot write to root collection.', { status: 409, headers: davHeaders() });
    }

    const config = await getRuntimeConfig(context.env);
    if (!config.TG_Bot_Token || !config.TG_Chat_ID) {
      return serviceUnavailable('TG_Bot_Token and TG_Chat_ID must be configured before WebDAV PUT can work.');
    }

    const existing = await getDavEntry(context.env, davPath);
    if (existing?.kind === 'collection') {
      return text('Cannot overwrite a collection with a file.', { status: 409, headers: davHeaders() });
    }

    await ensureDavCollections(context.env, davPath);
    const body = await context.request.arrayBuffer();
    const contentType = context.request.headers.get('content-type') || 'application/octet-stream';
    const fileName = getDavBaseName(davPath) || 'upload.bin';
    const file = new File([body], fileName, { type: contentType });
    const upload = await uploadFileToTelegram(context.env, config, file, {
      fileName,
      source: 'webdav'
    });

    if (!upload.success) {
      return json({ error: upload.error }, { status: 502, headers: davHeaders() });
    }

    if (existing?.storageKey && existing.storageKey !== upload.key) {
      await deleteTelegramBackedRecord(context.env, existing.storageKey);
    }

    const entry = await putDavEntry(context.env, davPath, {
      kind: 'file',
      storageKey: upload.key,
      size: upload.metadata.fileSize,
      contentType: file.type,
      createdAt: existing?.createdAt || Date.now()
    });

    if (existing) {
      return new Response(null, {
        status: 204,
        headers: davHeaders({ ETag: createDavEtag(entry) })
      });
    }

    return json({
      success: true,
      path: davPath,
      storageKey: entry.storageKey
    }, {
      status: 201,
      headers: davHeaders({ ETag: createDavEtag(entry) })
    });
  }

  if (method === 'DELETE') {
    if (davPath === '/') {
      return text('Cannot delete root collection.', { status: 405, headers: davHeaders() });
    }

    const entry = await getDavEntry(context.env, davPath);
    if (!entry) {
      return text('Not found.', { status: 404, headers: davHeaders() });
    }

    if (entry.kind === 'collection') {
      await deleteDavTree(context.env, entry);
      return new Response(null, { status: 204, headers: davHeaders() });
    }

    try {
      await deleteDavTree(context.env, entry);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Delete failed.' }, { status: 502, headers: davHeaders() });
    }
    return new Response(null, { status: 204, headers: davHeaders() });
  }

  if (method === 'MOVE') {
    if (davPath === '/') {
      return text('Cannot move root collection.', { status: 405, headers: davHeaders() });
    }

    const destination = context.request.headers.get('destination');
    if (!destination) {
      return text('Missing Destination header.', { status: 400, headers: davHeaders() });
    }

    let destinationPath;
    try {
      const destinationUrl = new URL(destination, requestUrl);
      if (destinationUrl.origin !== requestUrl.origin || !destinationUrl.pathname.startsWith('/dav')) {
        return text('Destination must stay within /dav.', { status: 400, headers: davHeaders() });
      }
      destinationPath = normalizeDavPath(destinationUrl.pathname, '/dav');
    } catch {
      return text('Invalid Destination header.', { status: 400, headers: davHeaders() });
    }

    const moved = await moveDavTree(context.env, davPath, destinationPath);
    if (!moved.success) {
      return text(moved.error, { status: moved.status || 500, headers: davHeaders() });
    }

    return new Response(null, { status: 201, headers: davHeaders() });
  }

  return methodNotAllowed(DAV_ALLOW);
}
