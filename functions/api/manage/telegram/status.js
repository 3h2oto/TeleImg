import { json, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramMe, getTelegramWebhookInfo } from '../../../_lib/telegram.js';
import { getTelegramSyncState } from '../../../_lib/telegram-sync.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

export async function onRequest(context) {
  const config = await getRuntimeConfig(context.env);
  if (!config.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const [me, webhook, syncState] = await Promise.all([
    getTelegramMe(context.env, { token: config.TG_Bot_Token }),
    getTelegramWebhookInfo(context.env, { token: config.TG_Bot_Token }),
    getTelegramSyncState(context.env)
  ]);

  return json({
    success: true,
    bot: me.ok ? {
      id: me.result?.id,
      username: me.result?.username,
      canReadAllGroupMessages: me.result?.can_read_all_group_messages ?? null,
      supportsInlineQueries: me.result?.supports_inline_queries ?? null
    } : null,
    webhook: webhook.ok ? webhook.result : { error: webhook.description, status: webhook.status },
    syncState
  });
}
