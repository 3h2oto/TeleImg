import { json, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramMe, getTelegramWebhookInfo } from '../../../_lib/telegram.js';
import { getTelegramSyncState } from '../../../_lib/telegram-sync.js';

export async function onRequest(context) {
  if (!context.env.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const [me, webhook, syncState] = await Promise.all([
    getTelegramMe(context.env),
    getTelegramWebhookInfo(context.env),
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
