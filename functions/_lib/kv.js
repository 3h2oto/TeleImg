const DEFAULT_LABEL = 'None';
const DEFAULT_LIST_TYPE = 'None';
export const INTERNAL_KEY_PREFIX = '__teleimg_internal__/';
export const TELEGRAM_SYNC_STATE_KEY = `${INTERNAL_KEY_PREFIX}telegram-sync-state`;

export function sanitizeFileName(input, fallback) {
  const value = String(input || fallback || '').trim();
  return value.length > 0 ? value.slice(0, 240) : fallback;
}

function sanitizeText(input) {
  const value = String(input || '').trim();
  return value.length > 0 ? value.slice(0, 500) : '';
}

function normalizeUploader(uploader) {
  if (!uploader || typeof uploader !== 'object') {
    return null;
  }

  const id = uploader.id == null ? '' : String(uploader.id);
  const username = sanitizeText(uploader.username);
  const firstName = sanitizeText(uploader.firstName || uploader.first_name);
  const lastName = sanitizeText(uploader.lastName || uploader.last_name);
  const title = sanitizeText(uploader.title);
  const displayName = sanitizeText(
    uploader.displayName
      || [firstName, lastName].filter(Boolean).join(' ')
      || title
      || username
      || id
  );

  if (!id && !displayName && !username && !title) {
    return null;
  }

  return {
    id,
    username,
    firstName,
    lastName,
    title,
    displayName,
    isBot: Boolean(uploader.isBot || uploader.is_bot)
  };
}

function normalizeTelegramMetadata(telegram, metadata = {}) {
  const source = telegram && typeof telegram === 'object' ? telegram : {};
  const fallback = metadata && typeof metadata === 'object' ? metadata : {};

  const normalized = {
    chatId: source.chatId != null ? String(source.chatId) : (fallback.telegramChatId != null ? String(fallback.telegramChatId) : ''),
    chatTitle: sanitizeText(source.chatTitle || fallback.telegramChatTitle),
    chatType: sanitizeText(source.chatType || fallback.telegramChatType),
    messageId: Number.isFinite(source.messageId) ? source.messageId : (Number.isFinite(fallback.telegramMessageId) ? fallback.telegramMessageId : undefined),
    updateId: Number.isFinite(source.updateId) ? source.updateId : (Number.isFinite(fallback.telegramUpdateId) ? fallback.telegramUpdateId : undefined),
    fileId: sanitizeText(source.fileId || fallback.telegramFileId),
    fileUniqueId: sanitizeText(source.fileUniqueId || fallback.telegramFileUniqueId),
    mediaKind: sanitizeText(source.mediaKind || fallback.telegramMediaKind),
    mediaGroupId: sanitizeText(source.mediaGroupId || fallback.telegramMediaGroupId),
    date: Number.isFinite(source.date) ? source.date : (Number.isFinite(fallback.telegramDate) ? fallback.telegramDate : undefined),
    source: sanitizeText(source.source || fallback.telegramSource),
    viaWebhook: source.viaWebhook !== undefined ? Boolean(source.viaWebhook) : Boolean(fallback.telegramViaWebhook)
  };

  if (!normalized.chatId && !normalized.fileId && !normalized.messageId) {
    return null;
  }

  return normalized;
}

export function normalizeMetadata(key, metadata = {}) {
  const telegram = normalizeTelegramMetadata(metadata?.telegram, metadata);
  const uploader = normalizeUploader(metadata?.uploader);
  const caption = sanitizeText(metadata?.caption);
  const source = sanitizeText(metadata?.source);

  return {
    TimeStamp: Number.isFinite(metadata?.TimeStamp) ? metadata.TimeStamp : Date.now(),
    ListType: typeof metadata?.ListType === 'string' && metadata.ListType.length > 0 ? metadata.ListType : DEFAULT_LIST_TYPE,
    Label: typeof metadata?.Label === 'string' && metadata.Label.length > 0 ? metadata.Label : DEFAULT_LABEL,
    liked: Boolean(metadata?.liked),
    fileName: sanitizeFileName(metadata?.fileName, key),
    fileSize: Number.isFinite(metadata?.fileSize) ? metadata.fileSize : 0,
    source: source || 'unknown',
    caption,
    telegram,
    uploader
  };
}

export function isInternalKey(key) {
  return typeof key === 'string' && key.startsWith(INTERNAL_KEY_PREFIX);
}

export async function getRecord(env, key) {
  const record = await env.img_url.getWithMetadata(key);
  return {
    value: record?.value ?? '',
    metadata: record?.metadata ? normalizeMetadata(key, record.metadata) : null
  };
}

export async function getOrCreateMetadata(env, key) {
  const record = await getRecord(env, key);
  if (record.metadata) {
    return record.metadata;
  }

  const metadata = normalizeMetadata(key, {});
  await env.img_url.put(key, record.value ?? '', { metadata });
  return metadata;
}

export async function updateMetadata(env, key, updater) {
  const current = await getOrCreateMetadata(env, key);
  const next = normalizeMetadata(key, await updater({ ...current }));
  await env.img_url.put(key, '', { metadata: next });
  return next;
}

export async function readInternalJson(env, key) {
  const raw = await env.img_url.get(key).catch(() => null);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeInternalJson(env, key, value) {
  await env.img_url.put(key, JSON.stringify(value));
  return value;
}

function matchesSearch(entry, search) {
  if (!search) {
    return true;
  }

  const haystacks = [
    entry.name,
    entry.metadata?.fileName,
    entry.metadata?.caption,
    entry.metadata?.uploader?.displayName,
    entry.metadata?.telegram?.chatTitle,
    entry.metadata?.telegram?.mediaKind,
    entry.metadata?.source
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return haystacks.some((value) => value.includes(search));
}

export async function getEnrichedRecord(env, key, fallbackEntry = null) {
  const fresh = await env.img_url.getWithMetadata(key).catch(() => null);
  if (!fresh) {
    return null;
  }

  const metadata = normalizeMetadata(key, fresh.metadata ?? fallbackEntry?.metadata);
  return {
    ...(fallbackEntry || { name: key }),
    name: key,
    metadata,
    url: `/file/${encodeURIComponent(key)}`,
    canDeleteTelegram: Boolean(metadata.telegram?.chatId && metadata.telegram?.messageId)
  };
}

export async function listRecords(env, { limit = 100, cursor, prefix, search } = {}) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 100, 200));
  const normalizedSearch = typeof search === 'string' && search.trim().length > 0
    ? search.trim().toLowerCase()
    : '';
  const pageSize = normalizedSearch ? 1000 : Math.max(200, safeLimit * 3);
  const maxScanned = 5000;
  let currentCursor = cursor;
  let scanned = 0;
  let done = false;
  const matches = [];

  while (!done && matches.length < safeLimit && scanned < maxScanned) {
    const page = await env.img_url.list({ limit: pageSize, cursor: currentCursor, prefix });
    currentCursor = page.cursor;
    scanned += page.keys.length;

    const enrichedEntries = await Promise.all(page.keys.map((entry) => getEnrichedRecord(env, entry.name, entry)));

    for (const enriched of enrichedEntries) {
      if (!enriched) {
        continue;
      }

      if (isInternalKey(enriched.name)) {
        continue;
      }

      if (matchesSearch(enriched, normalizedSearch)) {
        matches.push(enriched);
        if (matches.length >= safeLimit) {
          break;
        }
      }
    }

    done = page.list_complete;
  }

  matches.sort((left, right) => right.metadata.TimeStamp - left.metadata.TimeStamp);

  return {
    keys: matches,
    list_complete: done || !currentCursor,
    cursor: done ? undefined : currentCursor,
    scanned
  };
}
