import { json, methodNotAllowed, unauthorized } from '../../_lib/http.js';
import { processTelegramUpdates } from '../../_lib/telegram-sync.js';
import { getRuntimeConfig } from '../../_lib/runtime-config.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const config = await getRuntimeConfig(context.env);
  if (config.TG_WEBHOOK_SECRET) {
    const header = context.request.headers.get('x-telegram-bot-api-secret-token');
    if (header !== config.TG_WEBHOOK_SECRET) {
      return unauthorized('Invalid Telegram webhook secret.', 'Telegram Webhook');
    }
  }

  const update = await context.request.json().catch(() => null);
  if (!update) {
    return json({ error: 'Invalid Telegram update payload.' }, { status: 400 });
  }

  const summary = await processTelegramUpdates(context.env, [update], {
    mode: 'webhook',
    source: 'telegram-app'
  });

  return json({ ok: true, ...summary });
}
