import { json } from '../../_lib/http.js';
import { listRecords } from '../../_lib/kv.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const result = await listRecords(context.env, {
    limit: url.searchParams.get('limit') ?? 100,
    cursor: url.searchParams.get('cursor') || undefined,
    prefix: url.searchParams.get('prefix') || undefined,
    search: url.searchParams.get('search') || undefined
  });

  return json(result);
}
