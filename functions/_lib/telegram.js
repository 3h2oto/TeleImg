import { sanitizeFileName } from './kv.js';
import { getRuntimeConfig } from './runtime-config.js';

const TELEGRAM_PREFIX_RE = /^[A-Za-z0-9_-]{40,}$/;
const TELEGRAM_ALLOWED_UPDATES = ['message', 'channel_post', 'edited_message', 'edited_channel_post'];

function withoutExtension(key) {
  const index = key.lastIndexOf('.');
  return index > 0 ? key.slice(0, index) : key;
}

function sanitizePart(input) {
  return String(input || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

export function inferExtension(file) {
  const original = typeof file?.name === 'string' ? file.name : '';
  const extension = original.includes('.') ? original.split('.').pop() : '';
  const cleaned = String(extension || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned || inferExtensionFromMime(file?.type);
}

export function inferExtensionFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

function inferExtensionFromTelegramMedia(kind, media) {
  const original = typeof media?.file_name === 'string' ? media.file_name : '';
  const extension = original.includes('.') ? original.split('.').pop() : '';
  const cleaned = String(extension || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (cleaned) {
    return cleaned;
  }

  if (media?.mime_type) {
    return inferExtensionFromMime(media.mime_type);
  }

  switch (kind) {
    case 'photo':
      return 'jpg';
    case 'video':
    case 'video_note':
    case 'animation':
      return 'mp4';
    case 'audio':
      return 'mp3';
    case 'voice':
      return 'ogg';
    case 'sticker':
      return media?.is_animated ? 'tgs' : media?.is_video ? 'webm' : 'webp';
    default:
      return 'bin';
  }
}

export function selectUploadEndpoint(file) {
  if (file.type.startsWith('image/')) return ['photo', 'sendPhoto'];
  if (file.type.startsWith('audio/')) return ['audio', 'sendAudio'];
  if (file.type.startsWith('video/')) return ['video', 'sendVideo'];
  return ['document', 'sendDocument'];
}

export function extractUploadedFileId(response) {
  if (!response?.ok || !response?.result) {
    return null;
  }

  const payload = response.result;
  if (Array.isArray(payload.photo) && payload.photo.length > 0) {
    return payload.photo.reduce((largest, current) => {
      return (largest.file_size || 0) > (current.file_size || 0) ? largest : current;
    }).file_id;
  }

  return payload.document?.file_id || payload.video?.file_id || payload.audio?.file_id || payload.animation?.file_id || null;
}

export function extractUploadedMessage(response) {
  return response?.ok && response?.result ? response.result : null;
}

export function isTelegramFileKey(key) {
  return TELEGRAM_PREFIX_RE.test(withoutExtension(key));
}

export function buildLegacyTelegraphUrl(key, search = '') {
  return `https://telegra.ph/file/${encodeURIComponent(key)}${search}`;
}

async function resolveTelegramToken(env, explicitToken) {
  if (explicitToken) {
    return explicitToken;
  }

  const config = await getRuntimeConfig(env);
  return config?.TG_Bot_Token || '';
}

export async function callTelegramApi(env, method, params = {}, { useFormData = false, token } = {}) {
  const botToken = await resolveTelegramToken(env, token);
  if (!botToken) {
    return {
      ok: false,
      status: 503,
      description: 'TG_Bot_Token is required.'
    };
  }

  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const init = { method: 'POST' };

  if (useFormData) {
    const form = new FormData();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        form.append(key, String(value));
      }
    });
    init.body = form;
  } else {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(params);
  }

  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({ ok: false, description: `Telegram API ${method} returned invalid JSON.` }));

  return {
    ok: Boolean(payload?.ok),
    status: response.status,
    result: payload?.result,
    description: payload?.description || response.statusText || 'Telegram API error',
    errorCode: payload?.error_code,
    raw: payload
  };
}

export async function lookupTelegramFilePath(env, fileId) {
  const result = await callTelegramApi(env, 'getFile', { file_id: fileId });
  return result.ok ? result.result?.file_path ?? null : null;
}

export async function lookupTelegramFile(env, fileId) {
  const result = await callTelegramApi(env, 'getFile', { file_id: fileId });
  return {
    ok: result.ok,
    status: result.status,
    errorCode: result.errorCode,
    description: result.description,
    filePath: result.ok ? result.result?.file_path ?? null : null
  };
}

export async function getTelegramWebhookInfo(env, options = {}) {
  return callTelegramApi(env, 'getWebhookInfo', {}, options);
}

export async function getTelegramMe(env, options = {}) {
  return callTelegramApi(env, 'getMe', {}, options);
}

export async function getTelegramChat(env, chatId, options = {}) {
  return callTelegramApi(env, 'getChat', { chat_id: chatId }, options);
}

export async function getTelegramUpdates(env, { offset, limit = 100, timeout = 0, allowedUpdates = TELEGRAM_ALLOWED_UPDATES, token } = {}) {
  return callTelegramApi(env, 'getUpdates', {
    offset,
    limit,
    timeout,
    allowed_updates: allowedUpdates
  }, { token });
}

export async function setTelegramWebhook(env, webhookUrl, { secretToken, dropPendingUpdates = false, allowedUpdates = TELEGRAM_ALLOWED_UPDATES, token } = {}) {
  return callTelegramApi(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: secretToken,
    drop_pending_updates: dropPendingUpdates,
    allowed_updates: allowedUpdates
  }, { token });
}

export async function deleteTelegramWebhook(env, { dropPendingUpdates = false, token } = {}) {
  return callTelegramApi(env, 'deleteWebhook', {
    drop_pending_updates: dropPendingUpdates
  }, { token });
}

export async function deleteTelegramMessage(env, chatId, messageId, options = {}) {
  return callTelegramApi(env, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId
  }, options);
}

export function getTelegramFileId(key) {
  return withoutExtension(key);
}

function pickMessageCarrier(update) {
  for (const field of TELEGRAM_ALLOWED_UPDATES) {
    if (update?.[field]) {
      return {
        updateType: field,
        message: update[field]
      };
    }
  }

  return null;
}

export function extractTelegramMedia(message) {
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((left, right) => (right.file_size || 0) - (left.file_size || 0))[0];
    return { kind: 'photo', file_id: photo.file_id, file_unique_id: photo.file_unique_id, file_size: photo.file_size || 0, mime_type: 'image/jpeg' };
  }

  const pairs = [
    ['document', message?.document],
    ['video', message?.video],
    ['audio', message?.audio],
    ['animation', message?.animation],
    ['voice', message?.voice],
    ['video_note', message?.video_note],
    ['sticker', message?.sticker]
  ];

  for (const [kind, media] of pairs) {
    if (media?.file_id) {
      return { kind, ...media };
    }
  }

  return null;
}

function deriveTelegramFileName(message, media, extension) {
  if (typeof media?.file_name === 'string' && media.file_name.trim()) {
    return sanitizeFileName(media.file_name, `${media.file_id}.${extension}`);
  }

  const caption = sanitizePart(message?.caption || message?.text || '');
  const base = caption || `${media.kind || 'telegram'}-${message?.date || Date.now()}-${message?.message_id || 'file'}`;
  const suffix = base.toLowerCase().endsWith(`.${extension}`) ? '' : `.${extension}`;
  return sanitizeFileName(`${base}${suffix}`, `${media.file_id}.${extension}`);
}

function buildUploader(message) {
  const source = message?.from || message?.sender_chat;
  if (!source) {
    return null;
  }

  return {
    id: source.id,
    username: source.username,
    firstName: source.first_name,
    lastName: source.last_name,
    title: source.title,
    isBot: source.is_bot,
    displayName: [source.first_name, source.last_name].filter(Boolean).join(' ') || source.title || source.username || String(source.id)
  };
}

export function buildTelegramRecordFromUpdate(update, { source = 'telegram-app', viaWebhook = false } = {}) {
  const carrier = pickMessageCarrier(update);
  if (!carrier) {
    return null;
  }

  const media = extractTelegramMedia(carrier.message);
  if (!media?.file_id) {
    return null;
  }

  const extension = inferExtensionFromTelegramMedia(media.kind, media);
  const key = `${media.file_id}.${extension}`;
  const timestamp = Number.isFinite(carrier.message?.date) ? carrier.message.date * 1000 : Date.now();

  const telegram = {
    chatId: carrier.message?.chat?.id,
    chatTitle: carrier.message?.chat?.title || carrier.message?.sender_chat?.title || '',
    chatType: carrier.message?.chat?.type || '',
    messageId: carrier.message?.message_id,
    updateId: update?.update_id,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    mediaKind: media.kind,
    mediaGroupId: carrier.message?.media_group_id,
    date: carrier.message?.date,
    source: carrier.updateType,
    viaWebhook
  };

  return {
    key,
    metadata: {
      TimeStamp: timestamp,
      ListType: 'None',
      Label: 'None',
      liked: false,
      fileName: deriveTelegramFileName(carrier.message, media, extension),
      fileSize: Number.isFinite(media.file_size) ? media.file_size : 0,
      source,
      caption: carrier.message?.caption || '',
      uploader: buildUploader(carrier.message),
      telegram,
      telegramChatId: telegram.chatId,
      telegramChatTitle: telegram.chatTitle,
      telegramChatType: telegram.chatType,
      telegramMessageId: telegram.messageId,
      telegramUpdateId: telegram.updateId,
      telegramFileId: telegram.fileId,
      telegramFileUniqueId: telegram.fileUniqueId,
      telegramMediaKind: telegram.mediaKind,
      telegramMediaGroupId: telegram.mediaGroupId,
      telegramDate: telegram.date,
      telegramSource: telegram.source,
      telegramViaWebhook: telegram.viaWebhook
    }
  };
}

export function getTelegramAllowedUpdates() {
  return [...TELEGRAM_ALLOWED_UPDATES];
}
