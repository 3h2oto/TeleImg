import { getOrCreateMetadata } from '../_lib/kv.js';
import { buildLegacyTelegraphUrl, getTelegramFileId, isTelegramFileKey, lookupTelegramFile } from '../_lib/telegram.js';
import { redirect, serviceUnavailable, text } from '../_lib/http.js';
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
    return { ok: true, upstreamUrl: buildLegacyTelegraphUrl(key, search) };
  }

  if (!config.TG_Bot_Token) {
    throw serviceUnavailable('TG_Bot_Token is required to serve Telegram-backed files.');
  }

  const lookup = await lookupTelegramFile({ ...env, TG_Bot_Token: config.TG_Bot_Token }, getTelegramFileId(key));
  if (!lookup.ok) {
    return {
      ok: false,
      status: lookup.description?.toLowerCase().includes('file is too big') ? 413 : 502,
      message: lookup.description?.toLowerCase().includes('file is too big')
        ? 'Telegram Bot API cannot serve this file because Telegram reported it is too big for bot download. The admin can show its metadata, but serving the binary requires external storage or a user-session/MTProto based fetch path.'
        : `Telegram getFile failed: ${lookup.description || 'unknown error'}.`,
      telegramError: lookup.description || 'unknown error'
    };
  }

  if (!lookup.filePath) {
    return { ok: false, status: 404, message: 'File not found.', telegramError: 'missing file_path' };
  }

  return {
    ok: true,
    upstreamUrl: `https://api.telegram.org/file/bot${config.TG_Bot_Token}/${lookup.filePath}`
  };
}

function telegramFailureResponse(key, resolution) {
  const headers = { 'cache-control': 'no-store' };
  const suffix = resolution?.telegramError && resolution?.message !== resolution?.telegramError
    ? `\nTelegram said: ${resolution.telegramError}`
    : '';
  const body = resolution?.status === 404
    ? 'File not found.'
    : (resolution?.message || `Cannot open Telegram-backed file ${key}.`) + suffix;
  const normalizedBody = body.endsWith('.') || body.endsWith('"') ? body : `${body}.`;
  return text(normalizedBody, {
    status: resolution?.status || 502,
    headers
  });
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
    const resolution = await resolveUpstreamUrl(config, env, key, url.search);
    if (!resolution.ok) {
      return telegramFailureResponse(key, resolution);
    }
    upstreamUrl = resolution.upstreamUrl;
  } catch (response) {
    if (response instanceof Response) {
      return response;
    }
    throw response;
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
