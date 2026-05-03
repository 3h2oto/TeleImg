import { json, methodNotAllowed, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramAllowedUpdates, getTelegramWebhookInfo, setTelegramWebhook } from '../../../_lib/telegram.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

function resolvePublicOrigin(request, config) {
  if (config.PUBLIC_BASE_URL) {
    return config.PUBLIC_BASE_URL;
  }

  const url = new URL(request.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return null;
  }

  return url.origin;
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const config = await getRuntimeConfig(context.env);
  if (!config.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const origin = resolvePublicOrigin(context.request, config);
  if (!origin) {
    return json({ error: 'Cannot auto-configure Telegram webhook from a local dev origin. Set PUBLIC_BASE_URL or call this endpoint on the deployed site.' }, { status: 400 });
  }

  const webhookUrl = new URL('/api/telegram/webhook', origin).toString();
  const result = await setTelegramWebhook(context.env, webhookUrl, {
    token: config.TG_Bot_Token,
    secretToken: config.TG_WEBHOOK_SECRET || undefined,
    dropPendingUpdates: false,
    allowedUpdates: getTelegramAllowedUpdates()
  });

  if (!result.ok) {
    return json({ error: result.description, webhookUrl }, { status: 502 });
  }

  const info = await getTelegramWebhookInfo(context.env, { token: config.TG_Bot_Token });
  return json({
    success: true,
    webhookUrl,
    webhookInfo: info.ok ? info.result : { error: info.description }
  });
}
