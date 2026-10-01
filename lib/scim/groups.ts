import { audit, type Actor } from "../audit";
import { pool, tx, type Db } from "../db";
import { ScimError, isUuid } from "./http";
import { parsePatch, type PatchOp } from "./patch";
import { excludes, listResponse, parseEqFilter, parsePaging } from "./query";

const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

type GroupRow = {
  id: string;
  external_id: string | null;
  display_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};
type Member = { value: string; display: string };

export function toScimGroup(g: GroupRow, members: Member[] | null, base: string) {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.external_id && { externalId: g.external_id }),
    displayName: g.display_name,
    ...(members && { members: members.map((m) => ({ ...m, $ref: `${base}/Users/${m.value}` })) }),
    meta: {
      resourceType: "Group",
      created: g.created_at.toISOString(),
      lastModified: g.updated_at.toISOString(),
      location: `${base}/Groups/${g.id}`,
      version: `W/"${g.version}"`,
    },
  };
}

// ---------- reading ----------

async function membersFor(db: Db, groupIds: string[]): Promise<Map<string, Member[]>> {
  const map = new Map<string, Member[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return map;
  const { rows } = await db.query(
    `select gm.group_id, u.id, coalesce(u.display_name, u.user_name) as display
     from group_members gm join users u on u.id = gm.user_id
     where gm.group_id = any($1::uuid[]) order by u.user_name`,
    [groupIds],
  );
  for (const r of rows) map.get(r.group_id)!.push({ value: r.id, display: r.display });
  return map;
}

async function findRow(db: Db, id: string, lock = false): Promise<GroupRow> {
  if (!isUuid(id)) throw new ScimError(404, `Group ${id} not found`);
  const { rows } = await db.query(`select * from groups where id = $1${lock ? " for update" : ""}`, [id]);
  if (!rows[0]) throw new ScimError(404, `Group ${id} not found`);
  return rows[0];
}

export async function getGroup(id: string, base: string, withMembers = true) {
  const row = await findRow(pool, id);
  return toScimGroup(row, withMembers ? (await membersFor(pool, [id])).get(id)! : null, base);
}

const FILTERS: Record<string, string> = {
  displayName: "lower(display_name) = lower($1)",
  externalId: "external_id = $1",
};

export async function listGroups(url: URL, base: string) {
  const { startIndex, count, offset } = parsePaging(url);
  const f = parseEqFilter(url.searchParams.get("filter"), Object.keys(FILTERS));
  const where = f ? `where ${FILTERS[f.attr]}` : "";
  const args = f ? [f.value] : [];
  const total = Number((await pool.query(`select count(*) from groups ${where}`, args)).rows[0].count);
  const { rows } = await pool.query<GroupRow>(
    `select * from groups ${where} order by created_at, id limit ${count} offset ${offset}`,
    args,
  );
  const members = excludes(url, "members") ? null : await membersFor(pool, rows.map((r) => r.id));
  return listResponse(rows.map((r) => toScimGroup(r, members?.get(r.id) ?? null, base)), total, startIndex);
}

// ---------- writing ----------

function memberIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ScimError(400, "members must be an array", "invalidValue");
  return value.map((m) => m?.value).filter(isUuid);
}

// ON CONFLICT DO NOTHING makes a retried "add member" a no-op. Ids that don't match a
// user are skipped: the IdP may push a group before it has finished pushing its users.
async function addMembers(db: Db, groupId: string, ids: string[]) {
  if (ids.length === 0) return;
  await db.query(
    `insert into group_members (group_id, user_id)
     select $1, id from users where id = any($2::uuid[]) on conflict do nothing`,
    [groupId, ids],
  );
}

async function removeMembers(db: Db, groupId: string, ids: string[] | "all") {
  if (ids === "all") await db.query("delete from group_members where group_id = $1", [groupId]);
  else if (ids.length) await db.query("delete from group_members where group_id = $1 and user_id = any($2::uuid[])", [groupId, ids]);
}

function requireName(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new ScimError(400, "displayName is required", "invalidValue");
  return v.trim();
}

// ---------- auditing ----------

type Snapshot = { name: string; members: Set<string> };

async function snapshot(c: Db, id: string): Promise<Snapshot> {
  const row = await findRow(c, id, true);
  const { rows } = await c.query("select user_id from group_members where group_id = $1", [id]);
  return { name: row.display_name, members: new Set(rows.map((r) => r.user_id)) };
}

/**
 * Records what a write actually changed. Membership changes are logged per user
 * (target "user:<id>"), because joining a group can grant a role: a user's audit trail
 * then shows exactly when they gained or lost each privilege. No-op retries log nothing.
 */
async function auditChanges(c: Db, id: string, before: Snapshot | null, after: Snapshot, who: Actor) {
  const group = { groupId: id, group: after.name };
  if (!before) await audit(c, who, "scim.group.create", `group:${id}`, { displayName: after.name });
  else if (before.name !== after.name) await audit(c, who, "scim.group.rename", `group:${id}`, { from: before.name, to: after.name });
  for (const u of after.members) if (!before?.members.has(u)) await audit(c, who, "scim.group.member_add", `user:${u}`, group);
  for (const u of before?.members ?? []) if (!after.members.has(u)) await audit(c, who, "scim.group.member_remove", `user:${u}`, group);
}

// ---------- writes ----------

export async function createGroup(body: Record<string, unknown>, base: string, who: Actor) {
  const id = await tx(async (c) => {
    const { rows } = await c.query(
      "insert into groups (display_name, external_id) values ($1, $2) returning id",
      [requireName(body.displayName), body.externalId ?? null],
    );
    await addMembers(c, rows[0].id, memberIds(body.members));
    await auditChanges(c, rows[0].id, null, await snapshot(c, rows[0].id), who);
    return rows[0].id as string;
  });
  return getGroup(id, base);
}

/** PUT is a full replace, so an absent `members` means "no members" (RFC 7644 §3.5.1). */
export async function replaceGroup(id: string, body: Record<string, unknown>, base: string, who: Actor) {
  await tx(async (c) => {
    const before = await snapshot(c, id);
    await c.query(
      "update groups set display_name = $2, external_id = $3, version = version + 1, updated_at = now() where id = $1",
      [id, requireName(body.displayName), body.externalId ?? null],
    );
    await removeMembers(c, id, "all");
    await addMembers(c, id, memberIds(body.members));
    await auditChanges(c, id, before, await snapshot(c, id), who);
  });
  return getGroup(id, base);
}

export async function patchGroup(id: string, body: Record<string, unknown>, who: Actor) {
  const ops = parsePatch(body);
  await tx(async (c) => {
    const before = await snapshot(c, id); // also takes the row lock
    for (const op of ops) await applyOp(c, id, op);
    await c.query("update groups set version = version + 1, updated_at = now() where id = $1", [id]);
    await auditChanges(c, id, before, await snapshot(c, id), who);
  });
}

async function applyOp(c: Db, id: string, op: PatchOp) {
  // No path: value is a map. Okta renames with {"op":"replace","value":{"id":..,"displayName":..}}.
  if (!op.path) {
    if (!op.value || typeof op.value !== "object") throw new ScimError(400, "PATCH without path needs an object value", "invalidValue");
    for (const [k, v] of Object.entries(op.value)) {
      if (k.toLowerCase() !== "id") await applyOp(c, id, { op: op.op, path: k, value: v });
    }
    return;
  }
  const p = op.path.toLowerCase();

  if (p === "displayname") {
    if (op.op === "remove") throw new ScimError(400, "displayName cannot be removed", "mutability");
    await c.query("update groups set display_name = $2 where id = $1", [id, requireName(op.value)]);
  } else if (p === "externalid") {
    await c.query("update groups set external_id = $2 where id = $1", [id, op.op === "remove" ? null : op.value]);
  } else if (p === "members") {
    if (op.op === "add") await addMembers(c, id, memberIds(op.value));
    else if (op.op === "replace") {
      await removeMembers(c, id, "all");
      await addMembers(c, id, memberIds(op.value));
    }
    // Entra removes with {"path":"members","value":[{"value":id}]}; no value means remove all.
    else await removeMembers(c, id, op.value === undefined ? "all" : memberIds(op.value));
  } else {
    // Okta removes with {"path":"members[value eq \"<id>\"]"}.
    const m = /^members\[value eq "([^"]+)"\]$/i.exec(op.path);
    if (!m) throw new ScimError(400, `Unsupported path "${op.path}"`, "invalidPath");
    if (op.op !== "remove") throw new ScimError(400, `Only remove is supported on ${op.path}`, "invalidPath");
    await removeMembers(c, id, isUuid(m[1]) ? [m[1]] : []);
  }
}

/** Removing a group also drops its memberships (FK cascade). 404 on repeat, like users. */
export async function deleteGroup(id: string, who: Actor) {
  await tx(async (c) => {
    const before = await snapshot(c, id);
    await auditChanges(c, id, before, { name: before.name, members: new Set() }, who);
    await audit(c, who, "scim.group.delete", `group:${id}`, { displayName: before.name, memberCount: before.members.size });
    await c.query("delete from groups where id = $1", [id]);
  });
}
