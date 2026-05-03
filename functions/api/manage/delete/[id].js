import { badRequest, json } from '../../../_lib/http.js';
import { deleteTelegramMessage } from '../../../_lib/telegram.js';
import { getRecord } from '../../../_lib/kv.js';

export async function onRequest(context) {
  if (!context.params?.id) {
    return badRequest('Missing id.');
  }

  const key = context.params.id;
  const record = await getRecord(context.env, key);
  if (!record.metadata) {
    return json({ error: `Record ${key} was not found.` }, { status: 404 });
  }

  const telegram = record.metadata.telegram;
  let telegramDeleted = false;
  let warning = '';

  if (telegram?.chatId && telegram?.messageId && context.env.TG_Bot_Token) {
    const result = await deleteTelegramMessage(context.env, telegram.chatId, telegram.messageId);
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
