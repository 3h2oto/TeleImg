import { json, methodNotAllowed, serviceUnavailable } from './_lib/http.js';
import { extractUploadedFileId, extractUploadedMessage, extractTelegramMedia, inferExtension, selectUploadEndpoint } from './_lib/telegram.js';
import { normalizeMetadata, sanitizeFileName } from './_lib/kv.js';
import { getRuntimeConfig } from './_lib/runtime-config.js';

async function sendToTelegram(formData, apiEndpoint, env, botToken, retryCount = 0) {
  const maxRetries = 2;
  const apiUrl = `https://api.telegram.org/bot${botToken}/${apiEndpoint}`;

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
      return sendToTelegram(fallback, 'sendDocument', env, botToken, retryCount + 1);
    }

    return {
      success: false,
      error: responseData?.description || 'Upload to Telegram failed.'
    };
  } catch (error) {
    if (retryCount < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (retryCount + 1)));
      return sendToTelegram(formData, apiEndpoint, env, botToken, retryCount + 1);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error occurred.'
    };
  }
}

function buildTelegramInfo(uploadMessage, uploadFile) {
  const media = extractTelegramMedia(uploadMessage);
  return {
    chatId: uploadMessage?.chat?.id,
    chatTitle: uploadMessage?.chat?.title || '',
    chatType: uploadMessage?.chat?.type || '',
    messageId: uploadMessage?.message_id,
    fileId: media?.file_id,
    fileUniqueId: media?.file_unique_id,
    mediaKind: media?.kind || '',
    mediaGroupId: uploadMessage?.media_group_id,
    date: uploadMessage?.date,
    source: 'sendMessageResponse',
    viaWebhook: false,
    fileName: uploadFile?.name
  };
}

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

  const [fieldName, endpoint] = selectUploadEndpoint(uploadFile);
  const telegramFormData = new FormData();
  telegramFormData.append('chat_id', config.TG_Chat_ID);
  telegramFormData.append(fieldName, uploadFile, uploadFile.name);

  const result = await sendToTelegram(telegramFormData, endpoint, env, config.TG_Bot_Token);
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
    const uploadMessage = extractUploadedMessage(result.data);
    const metadata = normalizeMetadata(key, {
      fileName: sanitizeFileName(uploadFile.name, key),
      fileSize: uploadFile.size,
      liked: false,
      ListType: 'None',
      Label: 'None',
      TimeStamp: Date.now(),
      source: 'web-upload',
      caption: uploadMessage?.caption || '',
      telegram: buildTelegramInfo(uploadMessage, uploadFile)
    });

    await env.img_url.put(key, '', { metadata });
  }

  return json([{ src: `/file/${key}` }]);
}
