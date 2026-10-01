import { audit, type Actor } from "../audit";
import { revokeUserSessions } from "../auth/session";
import { pool, tx, type Db } from "../db";
import { ScimError, isUuid } from "./http";
import { parsePatch, toBool, type PatchOp } from "./patch";
import { listResponse, parseEqFilter, parsePaging } from "./query";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

type UserRow = {
  id: string;
  external_id: string | null;
  user_name: string;
  email: string;
  given_name: string | null;
  family_name: string | null;
  display_name: string | null;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
};

/** The writable subset of a user, in our own shape. PUT and PATCH both edit one of these. */
type UserFields = {
  externalId: string | null;
  userName: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  active: boolean;
};

type GroupRef = { value: string; display: string };

export function toScimUser(u: UserRow, groups: GroupRef[], base: string) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.external_id && { externalId: u.external_id }),
    userName: u.user_name,
    name: { givenName: u.given_name ?? undefined, familyName: u.family_name ?? undefined },
    displayName: u.display_name ?? undefined,
    emails: [{ value: u.email, type: "work", primary: true }],
    active: u.active,
    groups, // read-only in SCIM: membership is written via /Groups
    meta: {
      resourceType: "User",
      created: u.created_at.toISOString(),
      lastModified: u.updated_at.toISOString(),
      location: `${base}/Users/${u.id}`,
      version: `W/"${u.version}"`,
    },
  };
}

// ---------- reading ----------

async function groupsFor(db: Db, userIds: string[]): Promise<Map<string, GroupRef[]>> {
  const map = new Map<string, GroupRef[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return map;
  const { rows } = await db.query(
    `select gm.user_id, g.id, g.display_name from group_members gm join groups g on g.id = gm.group_id
     where gm.user_id = any($1::uuid[]) order by g.display_name`,
    [userIds],
  );
  for (const r of rows) map.get(r.user_id)!.push({ value: r.id, display: r.display_name });
  return map;
}

async function findRow(db: Db, id: string, lock = false): Promise<UserRow> {
  if (!isUuid(id)) throw new ScimError(404, `User ${id} not found`);
  const { rows } = await db.query(`select * from users where id = $1${lock ? " for update" : ""}`, [id]);
  if (!rows[0]) throw new ScimError(404, `User ${id} not found`);
  return rows[0];
}

export async function getUser(id: string, base: string) {
  const row = await findRow(pool, id);
  return toScimUser(row, (await groupsFor(pool, [id])).get(id)!, base);
}

// Filterable attributes and the SQL they compare against. userName/email are caseExact: false.
const FILTERS: Record<string, string> = {
  userName: "lower(user_name) = lower($1)",
  "emails.value": "lower(email) = lower($1)",
  externalId: "external_id = $1",
};

export async function listUsers(url: URL, base: string) {
  const { startIndex, count, offset } = parsePaging(url);
  const f = parseEqFilter(url.searchParams.get("filter"), Object.keys(FILTERS));
  const where = f ? `where ${FILTERS[f.attr]}` : "";
  const args = f ? [f.value] : [];
  const total = Number((await pool.query(`select count(*) from users ${where}`, args)).rows[0].count);
  const { rows } = await pool.query<UserRow>(
    `select * from users ${where} order by created_at, id limit ${count} offset ${offset}`,
    args,
  );
  const groups = await groupsFor(pool, rows.map((r) => r.id));
  return listResponse(rows.map((r) => toScimUser(r, groups.get(r.id)!, base)), total, startIndex);
}

// ---------- writing ----------

/** Maps a SCIM User body (POST/PUT) onto our fields. */
function fieldsFromBody(body: Record<string, unknown>): UserFields {
  const name = (body.name ?? {}) as Record<string, unknown>;
  const f: UserFields = {
    externalId: str(body.externalId),
    userName: str(body.userName) ?? "",
    email: pickEmail(body.emails),
    givenName: str(name.givenName),
    familyName: str(name.familyName),
    displayName: str(body.displayName),
    active: body.active === undefined ? true : toBool(body.active),
  };
  return f;
}

/** Prefer the primary email, then the first one listed. */
function pickEmail(emails: unknown): string | null {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const e = emails.find((x) => x?.primary === true || x?.primary === "true") ?? emails[0];
  return str(e?.value);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function validate(f: UserFields): Required<UserFields> & { email: string } {
  if (!f.userName) throw new ScimError(400, "userName is required", "invalidValue");
  // Email is how a SAML login finds this row, so a user without one could never sign in.
  // Okta and Entra both default userName to the email, so fall back to it.
  const email = f.email ?? (f.userName.includes("@") ? f.userName : null);
  if (!email) throw new ScimError(400, "An email (emails[].value, or an email-shaped userName) is required", "invalidValue");
  return { ...f, email: email.toLowerCase() };
}

const COLUMNS = `external_id, user_name, email, given_name, family_name, display_name, active`;
const values = (f: ReturnType<typeof validate>) =>
  [f.externalId, f.userName, f.email, f.givenName, f.familyName, f.displayName, f.active];

/**
 * POST. A retried create for an existing userName returns 409 uniqueness (RFC 7644 §3.3);
 * Okta and Entra react to that by looking the user up with a filter and continuing,
 * which is what makes provisioning retries safe.
 */
export async function createUser(body: Record<string, unknown>, base: string, who: Actor) {
  const f = validate(fieldsFromBody(body));
  const row = await tx(async (c) => {
    const { rows } = await c.query<UserRow>(`insert into users (${COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7) returning *`, values(f));
    await audit(c, who, "scim.user.create", `user:${rows[0].id}`, { userName: f.userName, email: f.email, active: f.active });
    return rows[0];
  });
  return toScimUser(row, [], base);
}

async function save(db: Db, id: string, f: ReturnType<typeof validate>) {
  await db.query(
    `update users set (${COLUMNS}) = ($2,$3,$4,$5,$6,$7,$8), version = version + 1, updated_at = now() where id = $1`,
    [id, ...values(f)],
  );
}

const rowToFields = (row: UserRow): UserFields => ({
  externalId: row.external_id,
  userName: row.user_name,
  email: row.email,
  givenName: row.given_name,
  familyName: row.family_name,
  displayName: row.display_name,
  active: row.active,
});

/**
 * Saves a PUT/PATCH result and records it. A true -> false change of `active` is how
 * Okta and Entra deprovision, so it also revokes every session in the same transaction:
 * the user's next request fails, and the revocation can't be lost if the save commits.
 */
async function saveAndAudit(c: Db, before: UserRow, next: ReturnType<typeof validate>, who: Actor, via: "put" | "patch") {
  const old = rowToFields(before);
  const changed = (Object.keys(next) as (keyof UserFields)[]).filter((k) => old[k] !== next[k]);
  if (changed.length === 0) return; // retried request: nothing to save or log
  await save(c, before.id, next);
  const target = `user:${before.id}`;
  await audit(c, who, "scim.user.update", target, { userName: next.userName, via, changed });
  if (old.active && !next.active) {
    const sessionsRevoked = await revokeUserSessions(c, before.id);
    await audit(c, who, "scim.user.deactivate", target, { userName: next.userName, sessionsRevoked });
  } else if (!old.active && next.active) {
    await audit(c, who, "scim.user.reactivate", target, { userName: next.userName });
  }
}

/** PUT replaces the whole resource. Sending the same body twice leaves the same state. */
export async function replaceUser(id: string, body: Record<string, unknown>, base: string, who: Actor) {
  await tx(async (c) => {
    const row = await findRow(c, id, true);
    await saveAndAudit(c, row, validate(fieldsFromBody(body)), who, "put");
  });
  return getUser(id, base);
}

export async function patchUser(id: string, body: Record<string, unknown>, base: string, who: Actor) {
  const ops = parsePatch(body);
  await tx(async (c) => {
    const row = await findRow(c, id, true); // row lock: concurrent PATCHes apply in order
    const f = rowToFields(row);
    for (const op of ops) applyOp(f, op);
    await saveAndAudit(c, row, validate(f), who, "patch");
  });
  return getUser(id, base);
}

function applyOp(f: UserFields, op: PatchOp) {
  if (op.path) return setAttr(f, op.path, op.op === "remove" ? null : op.value);
  // No path: `value` is a map of attributes. Okta deactivates with {"active": false};
  // Entra sends dotted keys like {"name.givenName": "Ada"}.
  if (!op.value || typeof op.value !== "object") throw new ScimError(400, "PATCH without path needs an object value", "invalidValue");
  for (const [k, v] of Object.entries(op.value)) setAttr(f, k, v);
}

/**
 * Applies one attribute path. Unknown paths (e.g. Entra's enterprise extension
 * attributes like department) are ignored rather than rejected, so one attribute we
 * don't store can't make the IdP's whole sync fail.
 */
function setAttr(f: UserFields, path: string, value: unknown) {
  const p = path.toLowerCase();
  if (p === "active") {
    if (value === null) throw new ScimError(400, "active cannot be removed", "mutability");
    f.active = toBool(value);
  } else if (p === "username") f.userName = str(value) ?? "";
  else if (p === "displayname") f.displayName = str(value);
  else if (p === "externalid") f.externalId = str(value);
  else if (p === "name.givenname") f.givenName = str(value);
  else if (p === "name.familyname") f.familyName = str(value);
  else if (p === "name") {
    const n = (value ?? {}) as Record<string, unknown>;
    f.givenName = str(n.givenName);
    f.familyName = str(n.familyName);
  } else if (p === "emails") f.email = pickEmail(value) ?? f.email;
  // Entra: emails[type eq "work"].value ; Okta: emails[primary eq true].value
  else if (/^emails\[.*\]\.value$/.test(p) && value !== null) f.email = str(value) ?? f.email;
}

/**
 * Hard delete. Sessions are revoked first (the FK cascade would also remove them) so
 * the audit entry records how many were cut off. A second DELETE returns 404, as
 * RFC 7644 §3.6 requires; Okta and Entra both treat that as "already gone".
 */
export async function deleteUser(id: string, who: Actor) {
  await tx(async (c) => {
    const row = await findRow(c, id, true);
    const sessionsRevoked = await revokeUserSessions(c, id);
    await audit(c, who, "scim.user.delete", `user:${id}`, { userName: row.user_name, email: row.email, sessionsRevoked });
    await c.query("delete from users where id = $1", [id]);
  });
}
