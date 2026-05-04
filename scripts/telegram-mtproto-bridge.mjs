import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import {
  getMtprotoBridgeRoutePath,
  isMtprotoBridgeRequestExpired,
  verifyMtprotoBridgePayload
} from '../shared/mtproto-bridge.js';

const host = process.env.TG_MT_BRIDGE_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.TG_MT_BRIDGE_PORT || '8788', 10);
const apiId = Number.parseInt(process.env.TG_USER_API_ID || '', 10);
const apiHash = String(process.env.TG_USER_API_HASH || '').trim();
const sessionString = String(process.env.TG_USER_SESSION || '').trim();
const bridgeSecret = String(process.env.TG_MT_BRIDGE_SECRET || '').trim();
const tempDir = path.join(os.tmpdir(), 'teleimg-mtproto-bridge');

let clientPromise;

function json(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

function text(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(body);
}

function requiredConfigError() {
  const missing = [
    Number.isFinite(apiId) ? null : 'TG_USER_API_ID',
    apiHash ? null : 'TG_USER_API_HASH',
    sessionString ? null : 'TG_USER_SESSION',
    bridgeSecret ? null : 'TG_MT_BRIDGE_SECRET'
  ].filter(Boolean);

  return missing.length > 0 ? `Missing required env vars: ${missing.join(', ')}` : null;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const configError = requiredConfigError();
      if (configError) {
        throw new Error(configError);
      }

      const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false
      });

      await client.connect();
      const authorized = await client.isUserAuthorized();
      if (!authorized) {
        throw new Error('TG_USER_SESSION is not authorized.');
      }

      return client;
    })().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }

  return clientPromise;
}

function decodeFileName(name, fallback) {
  const safe = String(name || fallback || 'telegram-file')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 240);
  return safe || fallback || 'telegram-file';
}

function encodeContentDisposition(name) {
  return `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function detectContentType(message, fileName) {
  const documentMime = message?.media?.document?.mimeType || message?.media?.document?.mime_type;
  if (documentMime) {
    return documentMime;
  }

  const lowerName = String(fileName || '').toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.mp4')) return 'video/mp4';
  if (lowerName.endsWith('.webm')) return 'video/webm';
  if (lowerName.endsWith('.mov')) return 'video/quicktime';
  if (lowerName.endsWith('.mp3')) return 'audio/mpeg';
  if (lowerName.endsWith('.ogg')) return 'audio/ogg';
  if (lowerName.endsWith('.m4a')) return 'audio/mp4';
  if (message?.media instanceof Api.MessageMediaPhoto) return 'image/jpeg';
  return 'application/octet-stream';
}

async function resolveEntity(client, chatId) {
  const candidates = [chatId];

  const numberValue = Number(chatId);
  if (Number.isSafeInteger(numberValue)) {
    candidates.push(numberValue);
  }

  try {
    candidates.push(BigInt(chatId));
  } catch {
    // ignore
  }

  let lastError;
  for (const candidate of candidates) {
    try {
      return await client.getInputEntity(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to resolve Telegram chat ${chatId}.`);
}

async function fetchMessage(client, chatId, messageId) {
  const entity = await resolveEntity(client, chatId);
  const numericId = Number.parseInt(String(messageId), 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error(`Invalid Telegram message id: ${messageId}`);
  }

  const messages = await client.getMessages(entity, { ids: [numericId] });
  const message = messages?.[0];
  if (!message) {
    throw new Error(`Message ${messageId} was not found in chat ${chatId}.`);
  }

  if (!(message.media instanceof Api.MessageMediaDocument) && !(message.media instanceof Api.MessageMediaPhoto)) {
    throw new Error(`Message ${messageId} does not contain downloadable media.`);
  }

  return message;
}

async function cleanupFile(filePath) {
  if (!filePath) {
    return;
  }

  await rm(filePath, { force: true }).catch(() => {});
}

async function downloadToTempFile(client, message, fileName) {
  await mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(fileName)}`);
  const result = await client.downloadMedia(message, { outputFile: tempPath });
  return typeof result === 'string' ? result : tempPath;
}

async function handleSignedDownload(response, url) {
  const payload = {
    chatId: url.searchParams.get('chatId') || '',
    messageId: url.searchParams.get('messageId') || '',
    key: url.searchParams.get('key') || '',
    name: url.searchParams.get('name') || '',
    expires: url.searchParams.get('expires') || ''
  };
  const signature = url.searchParams.get('sig') || '';

  if (!payload.chatId || !payload.messageId || !payload.key || !payload.name || !payload.expires || !signature) {
    return json(response, 400, { error: 'Missing signed download parameters.' });
  }

  if (isMtprotoBridgeRequestExpired(payload)) {
    return json(response, 410, { error: 'Signed download URL has expired.' });
  }

  const verified = await verifyMtprotoBridgePayload(bridgeSecret, payload, signature);
  if (!verified) {
    return json(response, 403, { error: 'Invalid signed download signature.' });
  }

  const client = await getClient();
  const message = await fetchMessage(client, payload.chatId, payload.messageId);
  const fileName = decodeFileName(payload.name, payload.key);
  const tempPath = await downloadToTempFile(client, message, fileName);

  try {
    const info = await stat(tempPath);
    response.writeHead(200, {
      'content-type': detectContentType(message, fileName),
      'content-length': String(info.size),
      'content-disposition': encodeContentDisposition(fileName),
      'cache-control': 'private, no-store'
    });

    const stream = createReadStream(tempPath);
    const finish = async () => cleanupFile(tempPath);
    stream.on('error', async (error) => {
      console.error('stream error', error);
      if (!response.headersSent) {
        json(response, 500, { error: 'Failed to read downloaded file.' });
      } else {
        response.destroy(error);
      }
      await cleanupFile(tempPath);
    });
    response.on('close', finish);
    response.on('finish', finish);
    stream.pipe(response);
  } catch (error) {
    await cleanupFile(tempPath);
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end('Method Not Allowed');
      return;
    }

    if (url.pathname === '/healthz') {
      const configError = requiredConfigError();
      return json(response, configError ? 503 : 200, {
        ok: !configError,
        error: configError,
        route: getMtprotoBridgeRoutePath()
      });
    }

    if (url.pathname !== getMtprotoBridgeRoutePath()) {
      return json(response, 404, { error: 'Not found.' });
    }

    if (request.method === 'HEAD') {
      return text(response, 405, 'Use GET for signed MTProto downloads.');
    }

    await handleSignedDownload(response, url);
  } catch (error) {
    console.error(error);
    return json(response, 502, {
      error: error instanceof Error ? error.message : 'MTProto bridge failed.'
    });
  }
});

server.listen(port, host, () => {
  console.log(`TeleImg MTProto bridge listening on http://${host}:${port}`);
});
