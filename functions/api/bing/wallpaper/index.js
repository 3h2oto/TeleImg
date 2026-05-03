import { json } from '../../../_lib/http.js';

export async function onRequest() {
  const response = await fetch('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
  const payload = await response.json();

  return json({
    status: true,
    message: 'ok',
    data: payload.images ?? []
  });
}
