import { withSession } from "@/lib/auth/guard";
import { listRoles } from "@/lib/authz/roles";

export const GET = withSession(async () => Response.json(await listRoles()), "admin:roles");
