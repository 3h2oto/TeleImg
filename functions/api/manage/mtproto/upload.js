import { describeBridgeConfig } from '../../../_lib/bridge-health.js';
import { json, methodNotAllowed, serviceUnavailable } from '../../../_lib/http.js';
import { claimMtprotoUploadTargetByMessage, saveMtprotoUploadTarget } from '../../../_lib/mtproto-upload.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';
import { buildMtprotoBridgeUploadUrl } from '../../../../shared/mtproto-bridge.js';

const WORKERS_DIRECT_UPLOAD_LIMIT = 95 * 1024 * 1024;
const WORKERS_CHUNK_SIZE = 8 * 1024 * 1024;
const WORKERS_PARALLEL_CHUNK_UPLOADS = 3;

function sanitizeRequestedFileName(input) {
  const value = String(input || '')
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\\/]+/g, '-')
    .slice(0, 240);
  return value || 'upload.bin';
}

function sanitizeContentType(input) {
  const value = String(input || '').trim();
  return value.slice(0, 160) || 'application/octet-stream';
}

function parseSize(input) {
  const size = Number.parseInt(String(input || ''), 10);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return size;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClaim(env, chatId, messageId) {
  let claim = await claimMtprotoUploadTargetByMessage(env, chatId, messageId);
  if (claim.applied) {
    return claim;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(200);
    claim = await claimMtprotoUploadTargetByMessage(env, chatId, messageId);
    if (claim.applied) {
      break;
    }
  }

  return claim;
}

async function prepareUpload(context, config) {
  if (!config.TG_MT_BRIDGE_URL || !config.TG_MT_BRIDGE_SECRET) {
    return serviceUnavailable('MTProto bridge is not configured.');
  }
  if (!config.TG_Chat_ID) {
    return serviceUnavailable('TG_Chat_ID is required for MTProto upload.');
  }

  const url = new URL(context.request.url);
  const folderPath = url.searchParams.get('path') || '/';
  const fileName = sanitizeRequestedFileName(url.searchParams.get('name'));
  const fileSize = parseSize(url.searchParams.get('size'));
  const contentType = sanitizeContentType(url.searchParams.get('type'));
  const requestedSessionId = typeof url.searchParams.get('session') === 'string'
    ? url.searchParams.get('session').trim()
    : '';
  if (!fileSize) {
    return json({ error: 'A positive file size is required.' }, { status: 400 });
  }

  const bridge = describeBridgeConfig(config);
  if (!bridge.configured) {
    return serviceUnavailable('MTProto bridge is not configured.');
  }

  const chunked = bridge.backend === 'workers-free' && fileSize > WORKERS_DIRECT_UPLOAD_LIMIT;
  const totalParts = chunked ? Math.max(1, Math.ceil(fileSize / WORKERS_CHUNK_SIZE)) : '';
  const uploadUrl = await buildMtprotoBridgeUploadUrl({
    baseUrl: config.TG_MT_BRIDGE_URL,
    secret: config.TG_MT_BRIDGE_SECRET,
    chatId: String(config.TG_Chat_ID),
    fileName,
    fileSize,
    contentType,
    sessionId: chunked ? (requestedSessionId || crypto.randomUUID()) : '',
    totalParts,
    chunked
  });
  const uploadParams = new URL(uploadUrl);

  return json({
    success: true,
    mode: chunked ? 'chunked' : 'direct',
    uploadUrl,
    sessionId: chunked ? (uploadParams.searchParams.get('session') || '') : '',
    expiresAt: Number.parseInt(uploadParams.searchParams.get('expires') || '0', 10) || null,
    fileName,
    fileSize,
    folderPath,
    contentType,
    bridge,
    chunkSize: chunked ? WORKERS_CHUNK_SIZE : null,
    totalParts: chunked ? totalParts : null,
    parallelChunks: chunked ? WORKERS_PARALLEL_CHUNK_UPLOADS : 1
  });
}

async function finalizeUpload(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid finalize payload.' }, { status: 400 });
  }

  const folderPath = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '/';
  const fileName = sanitizeRequestedFileName(body.fileName || body.upload?.fileName);
  const contentType = sanitizeContentType(body.contentType || body.upload?.contentType);
  const upload = body.upload && typeof body.upload === 'object' ? body.upload : null;
  if (!upload?.chatId || !upload?.messageId) {
    return json({ error: 'Finalize payload is missing upload.chatId/upload.messageId.' }, { status: 400 });
  }

  const target = await saveMtprotoUploadTarget(context.env, {
    chatId: upload.chatId,
    messageId: upload.messageId,
    folderPath,
    fileName,
    contentType
  });

  const claim = await waitForClaim(context.env, upload.chatId, upload.messageId);
  return json({
    success: true,
    upload,
    target,
    claimed: Boolean(claim?.applied),
    davPath: claim?.davPath || null,
    pending: !claim?.applied
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') {
    const config = await getRuntimeConfig(context.env);
    return prepareUpload(context, config);
  }

  if (context.request.method === 'POST') {
    return finalizeUpload(context);
  }

  return methodNotAllowed(['GET', 'POST']);
}

export const __test = {
  WORKERS_DIRECT_UPLOAD_LIMIT,
  WORKERS_CHUNK_SIZE,
  WORKERS_PARALLEL_CHUNK_UPLOADS
};
