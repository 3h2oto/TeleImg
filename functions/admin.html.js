import { requireDashboardAccess } from './_lib/auth.js';

export async function onRequest(context) {
  return requireDashboardAccess(context) ?? context.next();
}
