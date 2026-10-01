import { pool } from "../db";
import { isCapability, type Capability } from "./capabilities";

export type Access = { roles: string[]; capabilities: Set<Capability> };

/**
 * Resolves user -> SCIM groups -> roles -> capabilities in one query.
 * Nothing is cached: it runs per request (and per tool-use turn), so a group change
 * pushed by SCIM takes effect on the very next check. A user whose groups map to no
 * role gets no capabilities at all (fail closed), not a default role. Neither does a
 * deactivated user, which also stops an in-flight chat from running more tools.
 */
export async function accessFor(userId: string): Promise<Access> {
  const { rows } = await pool.query<{ role: string; capability: string | null }>(
    `select r.name as role, rc.capability
     from users u
     join group_members gm on gm.user_id = u.id
     join groups g on g.id = gm.group_id
     join group_role_mappings m on lower(m.group_name) = lower(g.display_name)
     join roles r on r.id = m.role_id
     left join role_capabilities rc on rc.role_id = r.id
     where u.id = $1 and u.active  -- a deactivated user has no access, even mid-request`,
    [userId],
  );
  return {
    roles: [...new Set(rows.map((r) => r.role))].sort(),
    capabilities: new Set(rows.map((r) => r.capability).filter(isCapability)),
  };
}
