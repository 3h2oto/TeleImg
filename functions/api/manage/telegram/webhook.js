import { json, methodNotAllowed, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramAllowedUpdates, getTelegramWebhookInfo, setTelegramWebhook } from '../../../_lib/telegram.js';

function resolvePublicOrigin(request, env) {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL;
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

  if (!context.env.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const origin = resolvePublicOrigin(context.request, context.env);
  if (!origin) {
    return json({ error: 'Cannot auto-configure Telegram webhook from a local dev origin. Set PUBLIC_BASE_URL or call this endpoint on the deployed site.' }, { status: 400 });
  }

  const webhookUrl = new URL('/api/telegram/webhook', origin).toString();
  const result = await setTelegramWebhook(context.env, webhookUrl, {
    secretToken: context.env.TG_WEBHOOK_SECRET || undefined,
    dropPendingUpdates: false,
    allowedUpdates: getTelegramAllowedUpdates()
  });

  if (!result.ok) {
    return json({ error: result.description, webhookUrl }, { status: 502 });
  }

  const info = await getTelegramWebhookInfo(context.env);
  return json({
    success: true,
    webhookUrl,
    webhookInfo: info.ok ? info.result : { error: info.description }
  });
}
