import { audit, queryAudit, userActor } from "@/lib/audit";
import { auditQueryFrom } from "@/lib/audit-params";
import { clientIp } from "@/lib/auth/http";
import { withSession } from "@/lib/auth/guard";
import { pool } from "@/lib/db";

// Read-only by design: there is no route that edits or deletes audit entries.
// GET /api/admin/audit?actor=&action=<prefix>&target=&since=&until=&limit=&before=<id>
export const GET = withSession(async (req, { session }) => {
  const url = new URL(req.url);
  const query = auditQueryFrom((k) => url.searchParams.get(k));
  // Reading the audit log is itself an admin action worth recording.
  await audit(pool, userActor(session.user.email, clientIp(req)), "admin.audit.query", null, { query });
  return Response.json(await queryAudit(query));
}, "admin:audit");
