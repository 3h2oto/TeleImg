import { badRequest, json } from '../../../_lib/http.js';
import { updateMetadata } from '../../../_lib/kv.js';

export async function onRequest(context) {
  if (!context.params?.id) {
    return badRequest('Missing id.');
  }

  const metadata = await updateMetadata(context.env, context.params.id, (current) => ({
    ...current,
    ListType: 'White'
  }));

  return json(metadata);
}
