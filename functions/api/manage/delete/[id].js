import { badRequest, json, methodNotAllowed } from '../../../_lib/http.js';
import { deleteTelegramMessage } from '../../../_lib/telegram.js';
import { getRecord, normalizeMetadata } from '../../../_lib/kv.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

function resolveKey(context) {
  const raw = context.params?.id;
  if (!raw) {
    return '';
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function loadTelegramMetadata(env, key) {
  const record = await getRecord(env, key);
  if (!record.metadata) {
    return null;
  }

  if (record.metadata.telegram?.chatId && record.metadata.telegram?.messageId) {
    return record.metadata;
  }

  const page = await env.img_url.list({ prefix: key, limit: 10 });
  const exact = (page.keys || []).find((entry) => entry.name === key);
  if (exact?.metadata) {
    return normalizeMetadata(key, exact.metadata);
  }

  return record.metadata;
}

export async function onRequest(context) {
  if (context.request.method !== 'POST' && context.request.method !== 'GET') {
    return methodNotAllowed(['GET', 'POST']);
  }

  const key = resolveKey(context);
  if (!key) {
    return badRequest('Missing id.');
  }
  const metadata = await loadTelegramMetadata(context.env, key);
  if (!metadata) {
    return json({ error: `Record ${key} was not found.` }, { status: 404 });
  }

  const config = await getRuntimeConfig(context.env);
  const telegram = metadata.telegram;
  let telegramDeleted = false;
  let warning = '';

  if (telegram?.chatId && telegram?.messageId) {
    const result = await deleteTelegramMessage(context.env, telegram.chatId, telegram.messageId, { token: config.TG_Bot_Token });
    if (!result.ok) {
      return json({
        error: `Failed to delete Telegram message ${telegram.messageId}: ${result.description}`,
        telegramDeleted: false,
        kvDeleted: false,
        id: key
      }, { status: 502 });
    }

    telegramDeleted = true;
  } else {
    warning = 'Missing Telegram chat/message metadata, so only the KV record can be deleted.';
  }

  await context.env.img_url.delete(key);

  return json({
    success: true,
    id: key,
    telegramDeleted,
    kvDeleted: true,
    warning
  });
}
