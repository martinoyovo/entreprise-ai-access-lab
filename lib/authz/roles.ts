import { audit, type Actor } from "../audit";
import { pool, tx, type Db } from "../db";
import { HttpError } from "../auth/guard";
import { CAPABILITIES, isCapability } from "./capabilities";

export type RoleInput = { description?: string | null; capabilities: string[]; groups: string[] };

export async function listRoles() {
  const { rows } = await pool.query(
    `select r.name, r.description,
       coalesce((select array_agg(capability order by capability) from role_capabilities where role_id = r.id), '{}') as capabilities,
       coalesce((select array_agg(group_name order by group_name) from group_role_mappings where role_id = r.id), '{}') as groups
     from roles r order by r.name`,
  );
  return { roles: rows, capabilityCatalog: CAPABILITIES };
}

export function parseRoleInput(body: unknown): RoleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = (v: unknown, field: string) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) throw new HttpError(400, `${field} must be an array of strings`);
    return [...new Set(v.map((x: string) => x.trim()))];
  };
  const capabilities = list(b.capabilities, "capabilities");
  const unknown = capabilities.filter((c) => !isCapability(c));
  if (unknown.length) throw new HttpError(400, `Unknown capabilities: ${unknown.join(", ")}`);
  return { description: typeof b.description === "string" ? b.description : null, capabilities, groups: list(b.groups ?? [], "groups") };
}

async function roleState(c: Db, name: string) {
  const { rows } = await c.query(
    `select r.description,
       coalesce((select array_agg(capability order by capability) from role_capabilities where role_id = r.id), '{}') as capabilities,
       coalesce((select array_agg(group_name order by group_name) from group_role_mappings where role_id = r.id), '{}') as groups
     from roles r where r.name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

/** Creates or fully replaces a role (its capabilities and group mappings). Audited with before/after. */
export async function putRole(name: string, input: RoleInput, who: Actor) {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(name)) throw new HttpError(400, "Role names are 2-40 chars: lowercase letters, digits, - or _");
  await tx(async (c) => {
    const before = await roleState(c, name);
    const { rows } = await c.query(
      `insert into roles (name, description) values ($1, $2)
       on conflict (name) do update set description = excluded.description, updated_at = now() returning id`,
      [name, input.description ?? null],
    );
    const id = rows[0].id;
    await c.query("delete from role_capabilities where role_id = $1", [id]);
    await c.query("delete from group_role_mappings where role_id = $1", [id]);
    await c.query("insert into role_capabilities (role_id, capability) select $1, unnest($2::text[])", [id, input.capabilities]);
    await c.query("insert into group_role_mappings (group_name, role_id) select unnest($2::text[]), $1", [id, input.groups]);
    await assertAdminsRemain(c);
    await audit(c, who, before ? "role.update" : "role.create", `role:${name}`, { before, after: await roleState(c, name) });
  });
}

export async function deleteRole(name: string, who: Actor) {
  await tx(async (c) => {
    const before = await roleState(c, name);
    const { rowCount } = await c.query("delete from roles where name = $1", [name]);
    if (!rowCount) throw new HttpError(404, `No role named ${name}`);
    await assertAdminsRemain(c);
    await audit(c, who, "role.delete", `role:${name}`, { before });
  });
}

/**
 * Lockout guard: some group must still map to a role with admin:roles, or nobody
 * could fix the configuration from inside the app. Runs inside the transaction,
 * so a failing check rolls the change back.
 */
async function assertAdminsRemain(c: { query: typeof pool.query }) {
  const { rowCount } = await c.query(
    `select 1 from role_capabilities rc join group_role_mappings m on m.role_id = rc.role_id
     where rc.capability = 'admin:roles' limit 1`,
  );
  if (!rowCount) throw new HttpError(409, "This change would leave no group with admin:roles");
}
