import { requireDashboardAccess } from './_lib/auth.js';

export async function onRequest(context) {
  return await requireDashboardAccess(context) ?? context.next();
}
