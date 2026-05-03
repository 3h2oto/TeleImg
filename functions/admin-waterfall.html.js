import { requireDashboardAccess } from './_lib/auth.js';
import { redirect } from './_lib/http.js';

export async function onRequest(context) {
  const access = requireDashboardAccess(context);
  if (access) {
    return access;
  }

  const url = new URL(context.request.url);
  return redirect(`${url.origin}/admin?view=waterfall`);
}
