import { unauthorized } from '../../_lib/http.js';

export async function onRequest() {
  return unauthorized('Logged out.', 'TeleImg Logout');
}
