const BRIDGE_ROUTE_PATH = '/telegram/file';
const DEFAULT_TTL_SECONDS = 300;
const encoder = new TextEncoder();

function clean(value, fallback = '') {
  const text = String(value ?? fallback).trim();
  return text;
}

function sanitizeFileName(name, fallback) {
  const value = clean(name, fallback).replace(/[\r\n]+/g, ' ').slice(0, 240);
  return value || fallback;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');

  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}

async function signText(secret, input) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return toBase64Url(new Uint8Array(signature));
}

export function isTelegramLargeFileError(description) {
  return /file is too big/i.test(String(description || ''));
}

export function hasMtprotoBridgeConfig(config) {
  return Boolean(clean(config?.TG_MT_BRIDGE_URL) && clean(config?.TG_MT_BRIDGE_SECRET));
}

export function buildMtprotoBridgePayload({ key, fileName, telegram, expiresAt = Date.now() + DEFAULT_TTL_SECONDS * 1000 }) {
  const chatId = clean(telegram?.chatId);
  const messageId = clean(telegram?.messageId);
  if (!chatId || !messageId) {
    return null;
  }

  const expires = String(Math.max(1, Math.floor(expiresAt / 1000)));
  const safeKey = clean(key);
  const safeName = sanitizeFileName(fileName, safeKey);

  return {
    chatId,
    messageId,
    key: safeKey,
    name: safeName,
    expires
  };
}

export function serializeMtprotoBridgePayload(payload) {
  return [
    clean(payload?.chatId),
    clean(payload?.messageId),
    clean(payload?.key),
    clean(payload?.name),
    clean(payload?.expires)
  ].join('\n');
}

export async function signMtprotoBridgePayload(secret, payload) {
  const normalizedSecret = clean(secret);
  if (!normalizedSecret) {
    throw new Error('TG_MT_BRIDGE_SECRET is required.');
  }

  return signText(normalizedSecret, serializeMtprotoBridgePayload(payload));
}

export async function verifyMtprotoBridgePayload(secret, payload, signature) {
  const expected = await signMtprotoBridgePayload(secret, payload);
  return constantTimeEqual(expected, signature);
}

export async function buildMtprotoBridgeDownloadUrl({ baseUrl, secret, key, fileName, telegram, expiresAt }) {
  const payload = buildMtprotoBridgePayload({ key, fileName, telegram, expiresAt });
  if (!payload) {
    return null;
  }

  const signature = await signMtprotoBridgePayload(secret, payload);
  const url = new URL(BRIDGE_ROUTE_PATH, clean(baseUrl));
  Object.entries(payload).forEach(([field, value]) => url.searchParams.set(field, value));
  url.searchParams.set('sig', signature);
  return url.toString();
}

export function isMtprotoBridgeRequestExpired(payload, now = Date.now()) {
  const expiresSeconds = Number.parseInt(clean(payload?.expires), 10);
  if (!Number.isFinite(expiresSeconds) || expiresSeconds <= 0) {
    return true;
  }

  return now > expiresSeconds * 1000;
}

export function getMtprotoBridgeRoutePath() {
  return BRIDGE_ROUTE_PATH;
}
