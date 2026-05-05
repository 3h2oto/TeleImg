import { json, serviceUnavailable } from '../../../_lib/http.js';
import { getTelegramMe, getTelegramWebhookInfo } from '../../../_lib/telegram.js';
import { getTelegramSyncState } from '../../../_lib/telegram-sync.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

async function fetchBridgeHealth(bridgeUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('bridge-health-timeout'), 4000);
  try {
    const response = await fetch(new URL('/healthz', bridgeUrl).toString(), {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });

    const payload = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequest(context) {
  const config = await getRuntimeConfig(context.env);
  if (!config.TG_Bot_Token) {
    return serviceUnavailable('TG_Bot_Token is required.');
  }

  const bridgeUrl = typeof config.TG_MT_BRIDGE_URL === 'string' && config.TG_MT_BRIDGE_URL.trim()
    ? config.TG_MT_BRIDGE_URL.trim()
    : '';
  const bridgePromise = bridgeUrl
    ? fetchBridgeHealth(bridgeUrl).catch((error) => ({
      ok: false,
      status: 502,
      payload: null,
      error: error instanceof Error ? error.message : 'Bridge health check failed.'
    }))
    : Promise.resolve(null);

  const [me, webhook, syncState, bridge] = await Promise.all([
    getTelegramMe(context.env, { token: config.TG_Bot_Token }),
    getTelegramWebhookInfo(context.env, { token: config.TG_Bot_Token }),
    getTelegramSyncState(context.env),
    bridgePromise
  ]);

  let bridgeSummary = {
    configured: false
  };

  if (bridgeUrl) {
    let host = '';
    try {
      host = new URL(bridgeUrl).host;
    } catch {
      host = bridgeUrl;
    }

    bridgeSummary = {
      configured: true,
      url: bridgeUrl,
      host,
      backend: bridge?.payload?.freePlanReady ? 'workers-free' : 'external',
      ok: Boolean(bridge?.ok && bridge?.payload?.ok),
      status: bridge?.status ?? null,
      health: bridge?.payload ?? null,
      error: bridge?.error || bridge?.payload?.error || null
    };
  }

  return json({
    success: true,
    bot: me.ok ? {
      id: me.result?.id,
      username: me.result?.username,
      canReadAllGroupMessages: me.result?.can_read_all_group_messages ?? null,
      supportsInlineQueries: me.result?.supports_inline_queries ?? null
    } : null,
    webhook: webhook.ok ? webhook.result : { error: webhook.description, status: webhook.status },
    syncState,
    bridge: bridgeSummary
  });
}
