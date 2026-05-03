import { badRequest, json, methodNotAllowed } from '../../../_lib/http.js';

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

  await context.env.img_url.delete(key);

  return json({
    success: true,
    id: key,
    telegramDeleted: false,
    kvDeleted: true,
    warning: 'KV record deleted without touching Telegram message.'
  });
}
