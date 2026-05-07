export async function fetchBridgeHealth(bridgeUrl) {
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

export function describeBridgeConfig(config) {
  const bridgeUrl = typeof config?.TG_MT_BRIDGE_URL === 'string' && config.TG_MT_BRIDGE_URL.trim()
    ? config.TG_MT_BRIDGE_URL.trim()
    : '';

  if (!bridgeUrl) {
    return {
      configured: false
    };
  }

  let host = '';
  try {
    host = new URL(bridgeUrl).host;
  } catch {
    host = bridgeUrl;
  }

  const backendHint = String(config?.TG_MT_BRIDGE_BACKEND || '').trim();
  const backend = backendHint === 'workers-free' || backendHint === 'external'
    ? backendHint
    : /\.workers\.dev$/i.test(host) || /\.pages\.dev$/i.test(host)
      ? 'workers-free'
      : 'external';

  return {
    configured: true,
    url: bridgeUrl,
    host,
    backend
  };
}

export async function summarizeBridgeHealth(config) {
  const bridgeConfig = describeBridgeConfig(config);
  if (!bridgeConfig.configured) {
    return bridgeConfig;
  }

  const bridge = await fetchBridgeHealth(bridgeConfig.url).catch((error) => ({
    ok: false,
    status: 502,
    payload: null,
    error: error instanceof Error ? error.message : 'Bridge health check failed.'
  }));

  return {
    ...bridgeConfig,
    backend: bridge?.payload?.freePlanReady ? 'workers-free' : bridgeConfig.backend,
    ok: Boolean(bridge?.ok && bridge?.payload?.ok),
    status: bridge?.status ?? null,
    health: bridge?.payload ?? null,
    error: bridge?.error || bridge?.payload?.error || null
  };
}
