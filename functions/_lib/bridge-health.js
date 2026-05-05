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

export async function summarizeBridgeHealth(config) {
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

  const bridge = await fetchBridgeHealth(bridgeUrl).catch((error) => ({
    ok: false,
    status: 502,
    payload: null,
    error: error instanceof Error ? error.message : 'Bridge health check failed.'
  }));

  return {
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
