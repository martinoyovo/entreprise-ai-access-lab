import { userActor } from "@/lib/audit";
import { clientIp } from "@/lib/auth/http";
import { withSession } from "@/lib/auth/guard";
import { deleteRole, listRoles, parseRoleInput, putRole } from "@/lib/authz/roles";

// PUT creates or replaces a custom role: { description?, capabilities: [...], groups: [...] }.
export const PUT = withSession(async (req, { params, session }) => {
  await putRole(params.name, parseRoleInput(await req.json().catch(() => null)), userActor(session.user.email, clientIp(req)));
  return Response.json(await listRoles());
}, "admin:roles");

export const DELETE = withSession(async (req, { params, session }) => {
  await deleteRole(params.name, userActor(session.user.email, clientIp(req)));
  return new Response(null, { status: 204 });
}, "admin:roles");
