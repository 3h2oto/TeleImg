import { connect } from 'cloudflare:sockets';
import { Buffer } from 'node:buffer';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { buildMtprotoBridgePayload, verifyMtprotoBridgePayload } from '../../shared/mtproto-bridge.js';

const DEFAULT_REQUEST_SIZE = 256 * 1024;
const CLOSE_ERROR = new Error('Cloudflare socket was closed');

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

    if (url.pathname === '/healthz') {
      const stub = env.MT_BRIDGE.get(env.MT_BRIDGE.idFromName('default'));
      return stub.fetch('https://mtbridge.internal/internal/status');
    }

    if (url.pathname !== '/telegram/file') {
      return text('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    if (request.method !== 'GET') {
      return text('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET', 'cache-control': 'no-store' }
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

    const stub = env.MT_BRIDGE.get(env.MT_BRIDGE.idFromName('default'));
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
    this.status = {
      connected: false,
      authorized: false,
      lastConnectedAt: null,
      lastDownloadAt: null,
      lastError: null,
      cachedPeers: 0
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/status') {
      return json({
        ok: this.status.connected && this.status.authorized,
        route: '/telegram/file',
        freePlanReady: true,
        ...this.status
      }, {
        status: this.status.connected && this.status.authorized ? 200 : 503,
        headers: { 'cache-control': 'no-store' }
      });
    }

    if (url.pathname !== '/telegram/file') {
      return text('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    try {
      const response = await this.handleDownload(url);
      this.status.lastDownloadAt = Date.now();
      this.status.lastError = null;
      return response;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : 'Unknown bridge error';
      this.status.connected = false;
      return json({ error: this.status.lastError }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  async handleDownload(url) {
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

    const iterator = client.iterDownload({
      file: message.media,
      requestSize: DEFAULT_REQUEST_SIZE
    });

    const stream = new ReadableStream({
      async pull(controller) {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          if (typeof iterator.close === 'function') {
            await iterator.close();
          }
          return;
        }

        controller.enqueue(result.value);
      },
      async cancel() {
        if (typeof iterator.close === 'function') {
          await iterator.close();
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': inferContentType(fileName),
        'content-disposition': encodeContentDisposition(fileName),
        'cache-control': 'private, no-store'
      }
    });
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
