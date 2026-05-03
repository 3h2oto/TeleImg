import { badRequest, json } from '../../../_lib/http.js';

export async function onRequest(context) {
  if (!context.params?.id) {
    return badRequest('Missing id.');
  }

  await context.env.img_url.delete(context.params.id);
  return json({ success: true, id: context.params.id });
}
