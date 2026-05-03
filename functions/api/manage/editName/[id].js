import { badRequest, json } from '../../../_lib/http.js';
import { sanitizeFileName, updateMetadata } from '../../../_lib/kv.js';

async function readRequestedName(request) {
  const url = new URL(request.url);
  const queryValue = url.searchParams.get('newName') || url.searchParams.get('name');
  if (queryValue) {
    return queryValue;
  }

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);
    return body?.newName || body?.name || '';
  }

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await request.formData().catch(() => null);
    return formData?.get('newName') || formData?.get('name') || '';
  }

  return '';
}

export async function onRequest(context) {
  if (!context.params?.id) {
    return badRequest('Missing id.');
  }

  const requestedName = sanitizeFileName(await readRequestedName(context.request), '');
  if (!requestedName) {
    return badRequest('newName is required.');
  }

  const metadata = await updateMetadata(context.env, context.params.id, (current) => ({
    ...current,
    fileName: requestedName
  }));

  return json({ success: true, fileName: metadata.fileName, metadata });
}
