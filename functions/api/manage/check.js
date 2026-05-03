import { json, text } from '../../_lib/http.js';
import { isBasicAuthEnabled, isDashboardEnabled } from '../../_lib/auth.js';

export async function onRequest(context) {
  if (!isDashboardEnabled(context.env)) {
    return json({ enabled: false, auth: false, message: 'Dashboard is disabled.' }, { status: 503 });
  }

  if (!await isBasicAuthEnabled(context.env)) {
    return text('Not using basic auth.');
  }

  return text('true');
}
