import { json, methodNotAllowed, serviceUnavailable } from './_lib/http.js';
import { extractUploadedFileId, inferExtension, selectUploadEndpoint } from './_lib/telegram.js';
import { normalizeMetadata, sanitizeFileName } from './_lib/kv.js';

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
  const maxRetries = 2;
  const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

  try {
    const response = await fetch(apiUrl, { method: 'POST', body: formData });
    const responseData = await response.json();

    if (response.ok) {
      return { success: true, data: responseData };
    }

    if (retryCount < maxRetries && apiEndpoint === 'sendPhoto') {
      const fallback = new FormData();
      fallback.append('chat_id', formData.get('chat_id'));
      fallback.append('document', formData.get('photo'));
      return sendToTelegram(fallback, 'sendDocument', env, retryCount + 1);
    }

    return {
      success: false,
      error: responseData?.description || 'Upload to Telegram failed.'
    };
  } catch (error) {
    if (retryCount < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (retryCount + 1)));
      return sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error occurred.'
    };
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const { env, request } = context;
  if (!env.TG_Bot_Token || !env.TG_Chat_ID) {
    return serviceUnavailable('TG_Bot_Token and TG_Chat_ID must be configured before upload can work.');
  }

  const formData = await request.formData();
  const uploadFile = formData.get('file');
  if (!(uploadFile instanceof File)) {
    return json({ error: 'No file uploaded.' }, { status: 400 });
  }

  const [fieldName, endpoint] = selectUploadEndpoint(uploadFile);
  const telegramFormData = new FormData();
  telegramFormData.append('chat_id', env.TG_Chat_ID);
  telegramFormData.append(fieldName, uploadFile, uploadFile.name);

  const result = await sendToTelegram(telegramFormData, endpoint, env);
  if (!result.success) {
    return json({ error: result.error }, { status: 502 });
  }

  const fileId = extractUploadedFileId(result.data);
  if (!fileId) {
    return json({ error: 'Failed to get file ID from Telegram response.' }, { status: 502 });
  }

  const extension = inferExtension(uploadFile);
  const key = `${fileId}.${extension}`;

  if (env.img_url) {
    const metadata = normalizeMetadata(key, {
      fileName: sanitizeFileName(uploadFile.name, key),
      fileSize: uploadFile.size,
      liked: false,
      ListType: 'None',
      Label: 'None',
      TimeStamp: Date.now()
    });

    await env.img_url.put(key, '', { metadata });
  }

  return json([{ src: `/file/${key}` }]);
}
