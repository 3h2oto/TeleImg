import { summarizeBridgeHealth } from '../../../_lib/bridge-health.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const config = await getRuntimeConfig(context.env);
  const bridge = await summarizeBridgeHealth(config);

  if (!bridge.configured) {
    return json({
      error: 'MTProto bridge is not configured.',
      bridge
    }, { status: 400 });
  }

  return json({
    success: true,
    bridge,
    message: bridge.ok ? '桥接自检完成：桥接在线。' : '桥接自检完成：桥接仍异常。'
  });
}
