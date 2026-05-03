import { badRequest, json, methodNotAllowed, serviceUnavailable } from '../../_lib/http.js';
import { writeInternalJson } from '../../_lib/kv.js';
import { getTelegramChat, getTelegramMe } from '../../_lib/telegram.js';
import { getRuntimeConfig, RUNTIME_CONFIG_KEY, sanitizeRuntimeInput } from '../../_lib/runtime-config.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  if (!context.env.img_url) {
    return serviceUnavailable('img_url KV binding is required.');
  }

  const existing = await getRuntimeConfig(context.env);
  if (existing.TG_Bot_Token || existing.BASIC_USER || existing.BASIC_PASS) {
    return json({ error: 'Runtime config already exists. Refusing to overwrite bootstrap config.' }, { status: 409 });
  }

  const body = await context.request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return badRequest('Invalid JSON body.');
  }

  const config = sanitizeRuntimeInput(body);
  if (!config.TG_Bot_Token || !config.TG_Chat_ID) {
    return badRequest('TG_Bot_Token and TG_Chat_ID are required.');
  }

  if (!config.PUBLIC_BASE_URL) {
    config.PUBLIC_BASE_URL = new URL(context.request.url).origin;
  }

  const me = await getTelegramMe(context.env, { token: config.TG_Bot_Token });
  if (!me.ok) {
    return json({ error: `Telegram bot token validation failed: ${me.description}` }, { status: 400 });
  }

  const chat = await getTelegramChat(context.env, config.TG_Chat_ID, { token: config.TG_Bot_Token });
  if (!chat.ok) {
    return json({ error: `Telegram chat validation failed: ${chat.description}` }, { status: 400 });
  }

  const stored = {
    ...config,
    bootstrappedAt: Date.now(),
    bot: {
      id: me.result?.id,
      username: me.result?.username
    },
    chat: {
      id: chat.result?.id,
      title: chat.result?.title,
      type: chat.result?.type,
      username: chat.result?.username || ''
    }
  };

  await writeInternalJson(context.env, RUNTIME_CONFIG_KEY, stored);

  return json({
    success: true,
    bot: stored.bot,
    chat: stored.chat,
    publicBaseUrl: stored.PUBLIC_BASE_URL
  });
}
