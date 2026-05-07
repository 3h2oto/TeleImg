import { text } from './_lib/http.js';

export async function onRequest() {
  return text('Not found.', {
    status: 404,
    headers: {
      'cache-control': 'no-store'
    }
  });
}
