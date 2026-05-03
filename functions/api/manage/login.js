import { redirect } from '../../_lib/http.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  return redirect(`${url.origin}/admin`);
}
