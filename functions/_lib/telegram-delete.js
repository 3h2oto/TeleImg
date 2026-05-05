import { deleteTelegramMessage } from './telegram.js';
import { getRecord, normalizeMetadata } from './kv.js';
import { getRuntimeConfig } from './runtime-config.js';

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

export async function deleteTelegramBackedRecord(env, key) {
  const metadata = await loadTelegramMetadata(env, key);
  if (!metadata) {
    return {
      success: false,
      status: 404,
      error: `Record ${key} was not found.`
    };
  }

  const config = await getRuntimeConfig(env);
  const telegram = metadata.telegram;
  let telegramDeleted = false;
  let warning = '';

  if (telegram?.chatId && telegram?.messageId) {
    const result = await deleteTelegramMessage(env, telegram.chatId, telegram.messageId, { token: config.TG_Bot_Token });
    if (!result.ok) {
      return {
        success: false,
        status: 502,
        error: `Failed to delete Telegram message ${telegram.messageId}: ${result.description}`,
        telegramDeleted: false,
        kvDeleted: false
      };
    }

    telegramDeleted = true;
  } else {
    warning = 'Missing Telegram chat/message metadata, so only the KV record can be deleted.';
  }

  await env.img_url.delete(key);

  return {
    success: true,
    id: key,
    telegramDeleted,
    kvDeleted: true,
    warning,
    metadata
  };
}
