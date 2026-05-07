import { ensureDavCollections, getDavBaseName, getDavEntry, normalizeDavPath, putDavEntry } from './dav.js';
import { INTERNAL_KEY_PREFIX, findRecordByTelegramMessage, readInternalJson, updateMetadata, writeInternalJson } from './kv.js';

export const MTPROTO_UPLOAD_TARGET_PREFIX = `${INTERNAL_KEY_PREFIX}mtproto-upload-target`;
const MTPROTO_UPLOAD_TARGET_TTL_MS = 30 * 60 * 1000;

function sanitizeDavLeafName(name, fallback = 'upload.bin') {
  const candidate = String(name || fallback || '')
    .trim()
    .replace(/[\\\/]+/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
  return candidate || fallback;
}

function appendStableSuffix(name, storageKey, counter = '') {
  const suffix = `__${String(storageKey || 'item').slice(0, 12)}${counter ? `_${counter}` : ''}`;
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  }
  return `${name}${suffix}`;
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
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function normalizeFolderPath(input) {
  const value = typeof input === 'string' && input.trim() ? input.trim() : '/';
  const pathname = value.startsWith('/') ? `/dav${value}` : `/dav/${value}`;
  return normalizeDavPath(pathname, '/dav');
}

function buildPendingKey(chatId, messageId) {
  return `${MTPROTO_UPLOAD_TARGET_PREFIX}/${encodeURIComponent(String(chatId || ''))}/${encodeURIComponent(String(messageId || ''))}`;
}

function joinDavPath(folderPath, fileName) {
  const normalizedFolder = normalizeFolderPath(folderPath);
  const safeFileName = sanitizeDavLeafName(fileName, 'upload.bin');
  return normalizedFolder === '/' ? `/${safeFileName}` : `${normalizedFolder}/${safeFileName}`;
}

async function readTarget(env, chatId, messageId) {
  const target = await readInternalJson(env, buildPendingKey(chatId, messageId));
  if (!target || typeof target !== 'object') {
    return null;
  }

  if (target.expiresAt && Number(target.expiresAt) <= Date.now()) {
    await deleteMtprotoUploadTarget(env, chatId, messageId);
    return null;
  }

  return target;
}

async function reserveDavPath(env, desiredPath, storageKey) {
  const normalized = normalizeFolderPath(desiredPath);
  const existing = await getDavEntry(env, normalized);
  if (!existing) {
    return normalized;
  }

  const baseName = getDavBaseName(normalized) || 'upload.bin';
  const slash = normalized.lastIndexOf('/');
  const parentPath = slash <= 0 ? '/' : normalized.slice(0, slash);
  let counter = 0;

  while (true) {
    const nextName = appendStableSuffix(baseName, storageKey, counter || '');
    const candidate = parentPath === '/' ? `/${nextName}` : `${parentPath}/${nextName}`;
    if (!(await getDavEntry(env, candidate))) {
      return candidate;
    }
    counter += 1;
  }
}

export function buildMtprotoDesiredDavPath(folderPath, fileName) {
  return joinDavPath(folderPath, fileName);
}

export async function saveMtprotoUploadTarget(env, { chatId, messageId, folderPath, fileName, contentType, ttlMs = MTPROTO_UPLOAD_TARGET_TTL_MS } = {}) {
  const normalizedChatId = String(chatId || '').trim();
  const normalizedMessageId = Number.parseInt(String(messageId || ''), 10);
  if (!normalizedChatId || !Number.isFinite(normalizedMessageId) || normalizedMessageId <= 0) {
    return null;
  }

  const createdAt = Date.now();
  const target = {
    chatId: normalizedChatId,
    messageId: normalizedMessageId,
    folderPath: normalizeFolderPath(folderPath),
    fileName: sanitizeDavLeafName(fileName, 'upload.bin'),
    davPath: buildMtprotoDesiredDavPath(folderPath, fileName),
    contentType: String(contentType || '').trim(),
    createdAt,
    expiresAt: createdAt + ttlMs
  };

  await writeInternalJson(env, buildPendingKey(normalizedChatId, normalizedMessageId), target);
  return target;
}

export async function deleteMtprotoUploadTarget(env, chatId, messageId) {
  await env.img_url.delete(buildPendingKey(chatId, messageId));
}

export async function claimMtprotoUploadTarget(env, storageKey, metadata) {
  const chatId = metadata?.telegram?.chatId;
  const messageId = metadata?.telegram?.messageId;
  if (!chatId || !messageId) {
    return { applied: false, reason: 'missing-telegram-identifiers' };
  }

  const target = await readTarget(env, chatId, messageId);
  if (!target) {
    return { applied: false, reason: 'missing-pending-target' };
  }

  const davPath = await reserveDavPath(env, target.davPath, storageKey);
  await ensureDavCollections(env, davPath);
  await putDavEntry(env, davPath, {
    kind: 'file',
    storageKey,
    size: Number(metadata?.fileSize || 0),
    contentType: target.contentType || inferContentType(target.fileName || metadata?.fileName || storageKey),
    createdAt: Number(metadata?.TimeStamp || target.createdAt || Date.now())
  });

  await updateMetadata(env, storageKey, (current) => ({
    ...current,
    source: 'mtproto-upload'
  }));
  await deleteMtprotoUploadTarget(env, chatId, messageId);

  return {
    applied: true,
    davPath
  };
}

export async function claimMtprotoUploadTargetByMessage(env, chatId, messageId) {
  const match = await findRecordByTelegramMessage(env, chatId, messageId);
  if (!match) {
    return { applied: false, reason: 'record-not-found' };
  }

  return claimMtprotoUploadTarget(env, match.key, match.metadata);
}
