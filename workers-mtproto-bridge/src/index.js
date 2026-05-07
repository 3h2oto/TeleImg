import { connect } from 'cloudflare:sockets';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import bigInt from 'big-integer';

import { Api, TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import {
  buildMtprotoBridgePayload,
  buildMtprotoBridgeUploadPayload,
  verifyMtprotoBridgePayload,
  verifyMtprotoBridgeUploadPayload
} from '../../shared/mtproto-bridge.js';

const DEFAULT_REQUEST_SIZE = 256 * 1024;
const BIG_FILE_THRESHOLD = 10 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;
const CLOSE_ERROR = new Error('Cloudflare socket was closed');
const ACCEPT_RANGES = 'bytes';

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

function text(body, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  return new Response(body, { ...init, headers });
}

function inferContentType(fileName = '') {
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
  return 'application/octet-stream';
}

function sanitizeFileName(name, fallback) {
  const cleaned = String(name || fallback || '')
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/]+/g, '-')
    .slice(0, 240);
  return cleaned || fallback || 'telegram-file';
}

function decodeHeaderFileName(value, fallback = 'upload.bin') {
  if (!value) {
    return fallback;
  }

  try {
    return sanitizeFileName(decodeURIComponent(String(value)), fallback);
  } catch {
    return sanitizeFileName(String(value), fallback);
  }
}

function toNumericChatCandidates(chatId) {
  const raw = String(chatId || '').trim();
  const values = [raw];
  const asNumber = Number(raw);
  if (Number.isSafeInteger(asNumber)) {
    values.push(asNumber);
  }
  try {
    values.push(BigInt(raw));
  } catch {
    // ignore
  }
  return values;
}

function encodeContentDisposition(fileName) {
  return `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function normalizeMediaSize(size) {
  if (size == null) {
    return null;
  }

  if (typeof size === 'number' && Number.isFinite(size)) {
    return size;
  }

  if (typeof size?.toJSNumber === 'function') {
    return size.toJSNumber();
  }

  const value = Number(size?.toString?.() ?? size);
  return Number.isFinite(value) ? value : null;
}

function create416(size) {
  return text('Requested Range Not Satisfiable', {
    status: 416,
    headers: {
      'cache-control': 'no-store',
      'accept-ranges': ACCEPT_RANGES,
      'content-range': `bytes */${size}`
    }
  });
}

function parseRangeHeader(header, size) {
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return { invalid: true };
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { invalid: true };
  }

  let start;
  let end;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    if (suffixLength >= size) {
      start = 0;
    } else {
      start = size - suffixLength;
    }
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start > end || start >= size) {
    return { invalid: true };
  }

  end = Math.min(end, size - 1);
  return {
    start,
    end,
    length: end - start + 1
  };
}

function createRangeStream(downloadIter, range) {
  const iterator = downloadIter[Symbol.asyncIterator]();
  let remaining = range.length;

  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        if (typeof downloadIter.close === 'function') {
          await downloadIter.close();
        }
        return;
      }

      const result = await iterator.next();
      if (result.done) {
        controller.close();
        if (typeof downloadIter.close === 'function') {
          await downloadIter.close();
        }
        return;
      }

      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      if (chunk.byteLength > remaining) {
        controller.enqueue(chunk.subarray(0, remaining));
        remaining = 0;
      } else {
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
      }

      if (remaining <= 0) {
        controller.close();
        if (typeof downloadIter.close === 'function') {
          await downloadIter.close();
        }
      }
    },
    async cancel() {
      if (typeof downloadIter.close === 'function') {
        await downloadIter.close();
      }
    }
  });
}

function createUploadFileId() {
  return bigInt(randomBytes(8).toString('hex') || '1', 16);
}

function parseContentLength(value) {
  const size = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return size;
}

function uploadCorsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400',
    ...extra
  };
}

function uploadJson(data, init = {}) {
  return json(data, {
    ...init,
    headers: uploadCorsHeaders(init.headers)
  });
}

function uploadText(body, init = {}) {
  return text(body, {
    ...init,
    headers: uploadCorsHeaders(init.headers)
  });
}

async function readUploadQueryPayload(url) {
  const rawSize = url.searchParams.get('size') || '';
  const payload = buildMtprotoBridgeUploadPayload({
    chatId: url.searchParams.get('chatId') || '',
    fileName: url.searchParams.get('name') || '',
    fileSize: rawSize,
    contentType: url.searchParams.get('type') || '',
    sessionId: url.searchParams.get('session') || '',
    totalParts: url.searchParams.get('parts') || '',
    expiresAt: Number.parseInt(url.searchParams.get('expires') || '0', 10) * 1000
  });

  if (!payload) {
    return null;
  }

  payload.expires = url.searchParams.get('expires') || '';
  payload.parts = url.searchParams.get('parts') || payload.parts || '';
  return payload;
}

function getUploadSizeFromHeaders(headers) {
  return parseContentLength(headers.get('content-length') || headers.get('x-teleimg-file-size'));
}

async function uploadRequestStream(client, body, size, fileName) {
  if (!body) {
    throw new Error('Upload body is missing.');
  }

  const partSize = utils.getAppropriatedPartSize(bigInt(size)) * 1024;
  const totalParts = Math.floor((size + partSize - 1) / partSize);
  const isLarge = size > BIG_FILE_THRESHOLD;
  const fileId = createUploadFileId();
  const md5 = isLarge ? null : createHash('md5');
  const reader = body.getReader();
  let partIndex = 0;
  let bytesRead = 0;
  let pending = Buffer.alloc(0);

  const sendPart = async (chunk) => {
    if (md5) {
      md5.update(chunk);
    }

    const request = isLarge
      ? new Api.upload.SaveBigFilePart({
          fileId,
          filePart: partIndex,
          fileTotalParts: totalParts,
          bytes: chunk
        })
      : new Api.upload.SaveFilePart({
          fileId,
          filePart: partIndex,
          bytes: chunk
        });

    const ok = await client.invoke(request);
    if (!ok) {
      throw new Error(`Telegram refused upload part ${partIndex}.`);
    }
    partIndex += 1;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(new Uint8Array(value));
    bytesRead += chunk.byteLength;
    pending = pending.byteLength ? Buffer.concat([pending, chunk]) : chunk;

    while (pending.byteLength >= partSize) {
      const current = pending.subarray(0, partSize);
      pending = pending.subarray(partSize);
      await sendPart(current);
    }
  }

  if (pending.byteLength > 0) {
    await sendPart(pending);
  }

  if (bytesRead !== size) {
    throw new Error(`Upload size mismatch: expected ${size} bytes, received ${bytesRead}.`);
  }

  if (partIndex !== totalParts) {
    throw new Error(`Upload part mismatch: expected ${totalParts}, sent ${partIndex}.`);
  }

  return isLarge
    ? new Api.InputFileBig({
        id: fileId,
        parts: totalParts,
        name: fileName
      })
    : new Api.InputFile({
        id: fileId,
        parts: totalParts,
        name: fileName,
        md5Checksum: md5.digest('hex')
      });
}

async function readQueryPayload(url) {
  const payload = buildMtprotoBridgePayload({
    key: url.searchParams.get('key') || '',
    fileName: url.searchParams.get('name') || '',
    telegram: {
      chatId: url.searchParams.get('chatId') || '',
      messageId: url.searchParams.get('messageId') || ''
    },
    expiresAt: Number.parseInt(url.searchParams.get('expires') || '0', 10) * 1000
  });

  if (!payload) {
    return null;
  }

  payload.expires = url.searchParams.get('expires') || '';
  return payload;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.MT_BRIDGE.get(env.MT_BRIDGE.idFromName('default'));

    if (url.pathname === '/healthz') {
      return stub.fetch('https://mtbridge.internal/internal/status');
    }

    if (url.pathname === '/telegram/upload' || url.pathname === '/telegram/upload/chunk') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: uploadCorsHeaders()
        });
      }

      if (request.method !== 'POST') {
        return uploadText('Method Not Allowed', {
          status: 405,
          headers: { allow: 'POST, OPTIONS', 'cache-control': 'no-store' }
        });
      }

      const usingLegacyHeaderAuth = url.pathname === '/telegram/upload'
        && request.headers.get('x-teleimg-bridge-secret') === env.TG_MT_BRIDGE_SECRET;

      if (!usingLegacyHeaderAuth) {
        const payload = await readUploadQueryPayload(url);
        const signature = url.searchParams.get('sig') || '';
        if (!payload || !signature) {
          return uploadJson({ error: 'Missing signed upload parameters.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
        }

        const expires = Number.parseInt(payload.expires, 10);
        if (!Number.isFinite(expires) || expires <= 0) {
          return uploadJson({ error: 'Invalid expires timestamp.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
        }

        if (Date.now() > expires * 1000) {
          return uploadJson({ error: 'Signed upload URL has expired.' }, { status: 410, headers: { 'cache-control': 'no-store' } });
        }

        const verified = await verifyMtprotoBridgeUploadPayload(env.TG_MT_BRIDGE_SECRET, payload, signature);
        if (!verified) {
          return uploadJson({ error: 'Invalid signed upload signature.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
        }
      }

      return stub.fetch(request);
    }

    if (url.pathname !== '/telegram/file') {
      return text('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' }
      });
    }

    const payload = await readQueryPayload(url);
    const signature = url.searchParams.get('sig') || '';
    if (!payload || !signature) {
      return json({ error: 'Missing signed download parameters.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }

    const expires = Number.parseInt(payload.expires, 10);
    if (!Number.isFinite(expires) || expires <= 0) {
      return json({ error: 'Invalid expires timestamp.' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }

    if (Date.now() > expires * 1000) {
      return json({ error: 'Signed download URL has expired.' }, { status: 410, headers: { 'cache-control': 'no-store' } });
    }

    const verified = await verifyMtprotoBridgePayload(env.TG_MT_BRIDGE_SECRET, payload, signature);
    if (!verified) {
      return json({ error: 'Invalid signed download signature.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
    }

    return stub.fetch(request);
  }
};

export class MtprotoBridgeDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.client = null;
    this.clientPromise = null;
    this.peerCache = new Map();
    this.uploadSessions = new Map();
    this.status = {
      connected: false,
      authorized: false,
      lastConnectedAt: null,
      lastDownloadAt: null,
      lastUploadAt: null,
      lastError: null,
      cachedPeers: 0
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/status') {
      await this.refreshHealth();
      return json({
        ok: this.status.connected && this.status.authorized,
        route: '/telegram/file',
        uploadRoute: '/telegram/upload',
        chunkUploadRoute: '/telegram/upload/chunk',
        freePlanReady: true,
        ...this.status
      }, {
        status: this.status.connected && this.status.authorized ? 200 : 503,
        headers: { 'cache-control': 'no-store' }
      });
    }

    if (url.pathname !== '/telegram/file' && url.pathname !== '/telegram/upload' && url.pathname !== '/telegram/upload/chunk') {
      return text('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    try {
      const response = url.pathname === '/telegram/upload/chunk'
        ? await this.handleChunkUpload(request, url)
        : url.pathname === '/telegram/upload'
          ? await this.handleUpload(request, url)
        : await this.handleDownload(request, url);
      if (url.pathname === '/telegram/upload' || url.pathname === '/telegram/upload/chunk') {
        this.status.lastUploadAt = Date.now();
      } else {
        this.status.lastDownloadAt = Date.now();
      }
      this.status.lastError = null;
      return response;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : 'Unknown bridge error';
      this.status.connected = false;
      return url.pathname.startsWith('/telegram/upload')
        ? uploadJson({ error: this.status.lastError }, { status: 502, headers: { 'cache-control': 'no-store' } })
        : json({ error: this.status.lastError }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  async refreshHealth() {
    try {
      await this.getClient();
      this.status.lastError = null;
    } catch (error) {
      this.status.connected = false;
      this.status.authorized = false;
      this.status.lastError = error instanceof Error ? error.message : 'Bridge health refresh failed.';
    }
  }

  async handleDownload(request, url) {
    const chatId = url.searchParams.get('chatId') || '';
    const messageId = Number.parseInt(url.searchParams.get('messageId') || '', 10);
    const fileName = sanitizeFileName(url.searchParams.get('name') || '', url.searchParams.get('key') || 'telegram-file');

    if (!chatId || !Number.isFinite(messageId) || messageId <= 0) {
      throw new Error('Invalid chatId or messageId.');
    }

    const client = await this.getClient();
    const entity = await this.resolveEntity(client, chatId);
    const messages = await client.getMessages(entity, { ids: messageId });
    const message = messages?.[0];
    if (!message?.media) {
      throw new Error(`Telegram message ${messageId} has no downloadable media.`);
    }

    const fileInfo = utils.getFileInfo(message.media);
    const fileSize = normalizeMediaSize(fileInfo?.size);
    const contentType = inferContentType(fileName);
    const baseHeaders = {
      'content-type': contentType,
      'content-disposition': encodeContentDisposition(fileName),
      'cache-control': 'private, no-store',
      'accept-ranges': ACCEPT_RANGES
    };

    const range = fileSize != null ? parseRangeHeader(request.headers.get('range'), fileSize) : null;
    if (range?.invalid && fileSize != null) {
      return create416(fileSize);
    }

    if (request.method === 'HEAD') {
      const headers = { ...baseHeaders };
      if (range && fileSize != null) {
        headers['content-range'] = `bytes ${range.start}-${range.end}/${fileSize}`;
        headers['content-length'] = String(range.length);
        return new Response(null, { status: 206, headers });
      }
      if (fileSize != null) {
        headers['content-length'] = String(fileSize);
      }
      return new Response(null, { status: 200, headers });
    }

    if (range && fileSize != null) {
      const downloadIter = client.iterDownload({
        file: message.media,
        offset: bigInt(range.start),
        requestSize: DEFAULT_REQUEST_SIZE,
        limit: Math.max(1, Math.ceil(range.length / DEFAULT_REQUEST_SIZE))
      });

      return new Response(createRangeStream(downloadIter, range), {
        status: 206,
        headers: {
          ...baseHeaders,
          'content-range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'content-length': String(range.length)
        }
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const writer = {
          async write(chunk) {
            controller.enqueue(chunk);
          },
          close() {
            controller.close();
          }
        };

        try {
          await client.downloadMedia(message, {
            outputFile: writer,
            progressCallback: undefined
          });
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: fileSize != null ? { ...baseHeaders, 'content-length': String(fileSize) } : baseHeaders
    });
  }

  async handleUpload(request, url) {
    const legacy = request.headers.get('x-teleimg-bridge-secret') === this.env.TG_MT_BRIDGE_SECRET;
    const signedPayload = legacy ? null : await readUploadQueryPayload(url);
    const chatId = signedPayload?.chatId || String(request.headers.get('x-teleimg-chat-id') || '').trim();
    const fileName = signedPayload?.name || decodeHeaderFileName(request.headers.get('x-teleimg-file-name'), 'upload.bin');
    const contentLength = parseContentLength(signedPayload?.size) || getUploadSizeFromHeaders(request.headers);
    const contentType = signedPayload?.type || request.headers.get('content-type') || inferContentType(fileName);

    if (!chatId) {
      throw new Error('Missing chatId.');
    }
    if (!contentLength) {
      throw new Error('Valid upload size is required.');
    }
    if (!request.body) {
      throw new Error('Upload body is missing.');
    }

    const client = await this.getClient();
    const entity = await this.resolveEntity(client, chatId);
    const uploaded = await uploadRequestStream(client, request.body, contentLength, fileName);
    const message = await client.sendFile(entity, {
      file: uploaded,
      caption: '',
      forceDocument: true,
      supportsStreaming: contentType.startsWith('video/')
    });

    return uploadJson({
      ok: true,
      upload: {
        chatId: message?.chatId?.toString?.() || chatId,
        messageId: Number(message?.id || 0),
        fileName,
        contentType,
        fileSize: contentLength,
        mediaKind: 'document'
      }
    }, {
      status: 201,
      headers: { 'cache-control': 'no-store' }
    });
  }

  async handleChunkUpload(request, url) {
    const payload = await readUploadQueryPayload(url);
    const chatId = payload?.chatId || '';
    const sessionId = payload?.session || '';
    const fileName = payload?.name || 'upload.bin';
    const contentType = payload?.type || inferContentType(fileName);
    const fileSize = parseContentLength(payload?.size);
    const totalParts = parseContentLength(payload?.parts);
    const part = Number.parseInt(url.searchParams.get('part') || '', 10);
    const isFinal = url.searchParams.get('final') === '1';

    if (!chatId || !sessionId || !fileSize || !totalParts || !Number.isFinite(part) || part < 0) {
      throw new Error('Invalid chunk upload parameters.');
    }
    if (!request.body) {
      throw new Error('Chunk upload body is missing.');
    }

    const chunkBuffer = Buffer.from(await request.arrayBuffer());
    const client = await this.getClient();
    const entity = await this.resolveEntity(client, chatId);
    const session = this.ensureUploadSession(sessionId, {
      chatId,
      fileName,
      contentType,
      fileSize,
      totalParts,
      entity
    });

    if (session.receivedParts !== part) {
      throw new Error(`Unexpected upload part ${part}; expected ${session.receivedParts}.`);
    }

    const ok = await client.invoke(new Api.upload.SaveBigFilePart({
      fileId: session.fileId,
      filePart: part,
      fileTotalParts: session.totalParts,
      bytes: chunkBuffer
    }));
    if (!ok) {
      throw new Error(`Telegram refused chunk ${part}.`);
    }

    session.receivedParts += 1;
    session.bytesReceived += chunkBuffer.byteLength;
    session.lastTouchedAt = Date.now();

    const complete = isFinal || session.receivedParts >= session.totalParts || session.bytesReceived >= session.fileSize;
    if (!complete) {
      return uploadJson({
        ok: true,
        complete: false,
        receivedParts: session.receivedParts,
        totalParts: session.totalParts,
        uploadedBytes: session.bytesReceived,
        fileSize: session.fileSize
      }, {
        status: 200,
        headers: { 'cache-control': 'no-store' }
      });
    }

    if (session.bytesReceived !== session.fileSize) {
      throw new Error(`Chunked upload size mismatch: expected ${session.fileSize}, received ${session.bytesReceived}.`);
    }

    const uploaded = new Api.InputFileBig({
      id: session.fileId,
      parts: session.totalParts,
      name: session.fileName
    });

    const message = await client.sendFile(session.entity, {
      file: uploaded,
      caption: '',
      forceDocument: true,
      supportsStreaming: session.contentType.startsWith('video/')
    });

    this.uploadSessions.delete(sessionId);
    return uploadJson({
      ok: true,
      complete: true,
      upload: {
        chatId: message?.chatId?.toString?.() || chatId,
        messageId: Number(message?.id || 0),
        fileName: session.fileName,
        contentType: session.contentType,
        fileSize: session.fileSize,
        mediaKind: 'document'
      }
    }, {
      status: 201,
      headers: { 'cache-control': 'no-store' }
    });
  }

  ensureUploadSession(sessionId, values) {
    const now = Date.now();
    for (const [key, session] of this.uploadSessions) {
      if (Number(session?.lastTouchedAt || 0) + UPLOAD_SESSION_TTL_MS < now) {
        this.uploadSessions.delete(key);
      }
    }

    const existing = this.uploadSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const session = {
      ...values,
      fileId: createUploadFileId(),
      receivedParts: 0,
      bytesReceived: 0,
      lastTouchedAt: now
    };
    this.uploadSessions.set(sessionId, session);
    return session;
  }

  async getClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }

    try {
      this.client = await this.clientPromise;
      return this.client;
    } finally {
      this.clientPromise = null;
    }
  }

  async createClient() {
    const apiId = Number.parseInt(this.env.TG_USER_API_ID || '', 10);
    const apiHash = String(this.env.TG_USER_API_HASH || '').trim();
    const sessionString = String(this.env.TG_MT_STRING_SESSION || '').trim();

    if (!Number.isFinite(apiId) || !apiHash || !sessionString) {
      throw new Error('TG_USER_API_ID, TG_USER_API_HASH, and TG_MT_STRING_SESSION are required.');
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 2,
      autoReconnect: true,
      requestRetries: 2,
      networkSocket: CloudflareTcpSocket
    });

    await client.connect();
    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      await client.disconnect().catch(() => {});
      throw new Error('TG_MT_STRING_SESSION is not authorized.');
    }

    this.status.connected = true;
    this.status.authorized = true;
    this.status.lastConnectedAt = Date.now();
    this.status.cachedPeers = this.peerCache.size;
    return client;
  }

  async resolveEntity(client, chatId) {
    if (this.peerCache.has(chatId)) {
      return this.peerCache.get(chatId);
    }

    for (const candidate of toNumericChatCandidates(chatId)) {
      try {
        const entity = await client.getEntity(candidate);
        this.peerCache.set(chatId, entity);
        this.status.cachedPeers = this.peerCache.size;
        return entity;
      } catch {
        // try fallback scan below
      }
    }

    const scanLimit = Math.max(20, Math.min(Number.parseInt(this.env.TG_MT_DIALOG_SCAN_LIMIT || '200', 10) || 200, 2000));
    const dialogs = await client.getDialogs({ limit: scanLimit });
    for (const dialog of dialogs) {
      const dialogId = dialog?.id?.toString?.();
      if (dialogId === String(chatId)) {
        const entity = dialog.inputEntity;
        this.peerCache.set(chatId, entity);
        this.status.cachedPeers = this.peerCache.size;
        return entity;
      }
    }

    throw new Error(`Unable to resolve Telegram chat ${chatId} from current user session.`);
  }
}

class CloudflareTcpSocket {
  constructor() {
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.closed = true;
    this.chunks = [];
    this.chunkLength = 0;
  }

  async connect(port, ip) {
    this.socket = connect({ hostname: ip, port });
    await this.socket.opened;
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.closed = false;
    return this;
  }

  async readExactly(number) {
    await this.fill(number);
    return this.consume(number);
  }

  async read(number) {
    await this.fill(1);
    return this.consume(Math.min(number, this.chunkLength));
  }

  async readAll() {
    await this.fill(1);
    return this.consume(this.chunkLength);
  }

  async fill(targetBytes) {
    if (this.closed) {
      throw CLOSE_ERROR;
    }

    while (this.chunkLength < targetBytes) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.closed = true;
        throw CLOSE_ERROR;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      this.chunks.push(chunk);
      this.chunkLength += chunk.byteLength;
    }
  }

  consume(targetBytes) {
    const output = Buffer.allocUnsafe(targetBytes);
    let written = 0;

    while (written < targetBytes && this.chunks.length > 0) {
      const current = this.chunks[0];
      const take = Math.min(current.byteLength, targetBytes - written);
      output.set(current.subarray(0, take), written);
      written += take;
      this.chunkLength -= take;

      if (take === current.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = current.subarray(take);
      }
    }

    return output;
  }

  async write(data) {
    if (this.closed) {
      throw CLOSE_ERROR;
    }

    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.writer.write(chunk);
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    try {
      await this.writer?.close?.();
    } catch {
      // ignore
    }
    try {
      this.reader?.releaseLock?.();
    } catch {
      // ignore
    }
    try {
      this.writer?.releaseLock?.();
    } catch {
      // ignore
    }
    try {
      this.socket?.close?.();
    } catch {
      // ignore
    }
  }

  toString() {
    return 'CloudflareTcpSocket';
  }
}
