import { getOrCreateMetadata } from '../_lib/kv.js';
import { buildLegacyTelegraphUrl, getTelegramFileId, isTelegramFileKey, lookupTelegramFilePath } from '../_lib/telegram.js';
import { redirect, serviceUnavailable } from '../_lib/http.js';
import { getRuntimeConfig } from '../_lib/runtime-config.js';

function isAdminPreview(request) {
  if (request.headers.get('x-teleimg-admin-preview') === '1') {
    return true;
  }

  const referer = request.headers.get('referer');
  if (!referer) {
    return false;
  }

  try {
    const refererUrl = new URL(referer);
    return refererUrl.pathname === '/admin' || refererUrl.pathname === '/admin.html';
  } catch {
    return false;
  }
}

function isWhitelistModeEnabled(config) {
  return String(config.WhiteList_Mode).toLowerCase() === 'true';
}

function copyForwardHeaders(request) {
  const forwarded = new Headers();
  for (const header of ['accept', 'if-modified-since', 'if-none-match', 'range']) {
    const value = request.headers.get(header);
    if (value) {
      forwarded.set(header, value);
    }
  }
  return forwarded;
}

async function resolveUpstreamUrl(config, env, key, search = '') {
  if (!isTelegramFileKey(key)) {
    return buildLegacyTelegraphUrl(key, search);
  }

  if (!config.TG_Bot_Token) {
    throw serviceUnavailable('TG_Bot_Token is required to serve Telegram-backed files.');
  }

  const filePath = await lookupTelegramFilePath({ ...env, TG_Bot_Token: config.TG_Bot_Token }, getTelegramFileId(key));
  if (!filePath) {
    return null;
  }

  return `https://api.telegram.org/file/bot${config.TG_Bot_Token}/${filePath}`;
}

async function moderateLegacyAsset(config, env, requestUrl, key, metadata) {
  if (!config.ModerateContentApiKey || isTelegramFileKey(key) || metadata.Label !== 'None') {
    return metadata;
  }

  const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${encodeURIComponent(config.ModerateContentApiKey)}&url=${encodeURIComponent(buildLegacyTelegraphUrl(key, ''))}`;
  const response = await fetch(moderateUrl);
  if (!response.ok) {
    return metadata;
  }

  const payload = await response.json().catch(() => null);
  if (!payload?.rating_label) {
    return metadata;
  }

  const next = {
    ...metadata,
    Label: payload.rating_label
  };

  await env.img_url.put(key, '', { metadata: next });

  if (payload.rating_label === 'adult') {
    throw redirect(`${requestUrl.origin}/block-img`);
  }

  return next;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const config = await getRuntimeConfig(env);
  const key = params.id;
  const url = new URL(request.url);

  let upstreamUrl;
  try {
    upstreamUrl = await resolveUpstreamUrl(config, env, key, url.search);
  } catch (response) {
    if (response instanceof Response) {
      return response;
    }
    throw response;
  }

  if (!upstreamUrl) {
    return new Response('File not found.', { status: 404 });
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: copyForwardHeaders(request)
  });

  if (!upstreamResponse.ok) {
    return upstreamResponse;
  }

  if (isAdminPreview(request) || !env.img_url) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers
    });
  }

  let metadata = await getOrCreateMetadata(env, key);

  if (metadata.ListType === 'Block' || metadata.Label === 'adult') {
    return redirect(`${url.origin}/block-img`);
  }

  if (metadata.ListType === 'White') {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers
    });
  }

  if (isWhitelistModeEnabled(config)) {
    return redirect(`${url.origin}/whitelist-on`);
  }

  try {
    metadata = await moderateLegacyAsset(config, env, url, key, metadata);
  } catch (response) {
    if (response instanceof Response) {
      return response;
    }
    throw response;
  }

  await env.img_url.put(key, '', { metadata });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers
  });
}
