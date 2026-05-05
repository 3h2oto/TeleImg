import { json, methodNotAllowed, serviceUnavailable } from './_lib/http.js';
import { getRuntimeConfig } from './_lib/runtime-config.js';
import { uploadFileToTelegram } from './_lib/telegram-upload.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const { env, request } = context;
  const config = await getRuntimeConfig(env);
  if (!config.TG_Bot_Token || !config.TG_Chat_ID) {
    return serviceUnavailable('TG_Bot_Token and TG_Chat_ID must be configured before upload can work.');
  }

  const formData = await request.formData();
  const uploadFile = formData.get('file');
  if (!(uploadFile instanceof File)) {
    return json({ error: 'No file uploaded.' }, { status: 400 });
  }

  const result = await uploadFileToTelegram(env, config, uploadFile, {
    source: 'web-upload'
  });
  if (!result.success) {
    return json({ error: result.error }, { status: 502 });
  }

  return json([{ src: `/file/${result.key}` }]);
}
