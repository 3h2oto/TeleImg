import { json, methodNotAllowed, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramAllowedUpdates, getTelegramUpdates } from '../../../_lib/telegram.js';
import { getTelegramSyncState, processTelegramUpdates } from '../../../_lib/telegram-sync.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const config = await getRuntimeConfig(context.env);
  if (!config.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const current = await getTelegramSyncState(context.env);
  const url = new URL(context.request.url);
  const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 100));
  const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '', 10);
  const offset = Number.isFinite(requestedOffset) ? requestedOffset : current.offset;

  const updates = await getTelegramUpdates(context.env, {
    offset,
    limit,
    timeout: 0,
    token: config.TG_Bot_Token,
    allowedUpdates: getTelegramAllowedUpdates()
  });

  if (!updates.ok) {
    const status = updates.status === 409 ? 409 : 502;
    return json({
      error: updates.description,
      offset,
      hint: updates.status === 409
        ? 'getUpdates cannot be used while a webhook is active. If webhook is already configured, direct uploads should arrive automatically.'
        : 'Telegram getUpdates failed.'
    }, { status });
  }

  const summary = await processTelegramUpdates(context.env, updates.result || [], {
    mode: 'poll',
    source: 'telegram-app'
  });

  return json({
    success: true,
    fetched: (updates.result || []).length,
    ...summary
  });
}
