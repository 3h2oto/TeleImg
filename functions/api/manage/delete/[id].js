import { badRequest, json, methodNotAllowed } from '../../../_lib/http.js';
import { deleteTelegramBackedRecord } from '../../../_lib/telegram-delete.js';

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

export async function onRequest(context) {
  if (context.request.method !== 'POST' && context.request.method !== 'GET') {
    return methodNotAllowed(['GET', 'POST']);
  }

  const key = resolveKey(context);
  if (!key) {
    return badRequest('Missing id.');
  }
  const result = await deleteTelegramBackedRecord(context.env, key);
  if (!result.success) {
    return json({
      error: result.error,
      telegramDeleted: result.telegramDeleted ?? false,
      kvDeleted: result.kvDeleted ?? false,
      id: key
    }, { status: result.status || 500 });
  }

  return json(result);
}
