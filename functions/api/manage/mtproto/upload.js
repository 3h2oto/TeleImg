import { json, methodNotAllowed, serviceUnavailable } from '../../../_lib/http.js';
import { claimMtprotoUploadTargetByMessage, saveMtprotoUploadTarget } from '../../../_lib/mtproto-upload.js';
import { getRuntimeConfig } from '../../../_lib/runtime-config.js';

function sanitizeRequestedFileName(input) {
  const value = String(input || '')
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\\/]+/g, '-')
    .slice(0, 240);
  return value || 'upload.bin';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  const config = await getRuntimeConfig(context.env);
  if (!config.TG_MT_BRIDGE_URL || !config.TG_MT_BRIDGE_SECRET) {
    return serviceUnavailable('MTProto bridge is not configured.');
  }
  if (!config.TG_Chat_ID) {
    return serviceUnavailable('TG_Chat_ID is required for MTProto upload.');
  }

  if (!context.request.body) {
    return json({ error: 'Missing upload body.' }, { status: 400 });
  }

  const requestUrl = new URL(context.request.url);
  const folderPath = requestUrl.searchParams.get('path') || '/';
  const requestedName = sanitizeRequestedFileName(requestUrl.searchParams.get('name') || context.request.headers.get('x-teleimg-file-name'));
  const contentType = context.request.headers.get('content-type') || 'application/octet-stream';
  const contentLength = context.request.headers.get('content-length') || context.request.headers.get('x-teleimg-file-size');

  const bridgeUrl = new URL('/telegram/upload', config.TG_MT_BRIDGE_URL);
  const bridgeHeaders = new Headers();
  bridgeHeaders.set('content-type', contentType);
  bridgeHeaders.set('x-teleimg-bridge-secret', config.TG_MT_BRIDGE_SECRET);
  bridgeHeaders.set('x-teleimg-chat-id', String(config.TG_Chat_ID));
  bridgeHeaders.set('x-teleimg-file-name', encodeURIComponent(requestedName));
  if (contentLength) {
    bridgeHeaders.set('x-teleimg-file-size', contentLength);
  }
  if (contentLength) {
    bridgeHeaders.set('content-length', contentLength);
  }

  const bridgeResponse = await fetch(bridgeUrl.toString(), {
    method: 'POST',
    headers: bridgeHeaders,
    body: context.request.body
  });

  const bridgePayload = await bridgeResponse.json().catch(async () => ({
    error: await bridgeResponse.text().catch(() => 'Unable to parse bridge response.')
  }));

  if (!bridgeResponse.ok) {
    return json({
      error: bridgePayload?.error || 'MTProto bridge upload failed.',
      bridge: bridgePayload || null
    }, {
      status: bridgeResponse.status >= 400 && bridgeResponse.status < 600 ? bridgeResponse.status : 502
    });
  }

  const upload = bridgePayload?.upload;
  if (!upload?.chatId || !upload?.messageId) {
    return json({ error: 'Bridge upload response is missing chatId/messageId.' }, { status: 502 });
  }

  const target = await saveMtprotoUploadTarget(context.env, {
    chatId: upload.chatId,
    messageId: upload.messageId,
    folderPath,
    fileName: upload.fileName || requestedName,
    contentType
  });

  let claim = await claimMtprotoUploadTargetByMessage(context.env, upload.chatId, upload.messageId);
  if (!claim.applied) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(200);
      claim = await claimMtprotoUploadTargetByMessage(context.env, upload.chatId, upload.messageId);
      if (claim.applied) {
        break;
      }
    }
  }

  return json({
    success: true,
    upload,
    target,
    claimed: Boolean(claim?.applied),
    davPath: claim?.davPath || null,
    pending: !claim?.applied
  });
}
