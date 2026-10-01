import { pool, type Db } from "./db";

/** Who did something, plus where from. `actor` is "scim", "user:<email>" or "anonymous". */
export type Actor = { actor: string; ip: string | null };

export const userActor = (email: string, ip: string | null): Actor => ({ actor: `user:${email}`, ip });

/**
 * Writes one audit entry. Pass the transaction client when logging a data change, so
 * the change and its audit entry commit (or roll back) together: a change can't
 * happen without its record.
 */
export async function audit(db: Db, who: Actor, action: string, target: string | null, metadata: Record<string, unknown> = {}) {
  await db.query("insert into audit_log (actor, action, target, metadata) values ($1, $2, $3, $4)", [
    who.actor,
    action,
    target,
    who.ip ? { ...metadata, ip: who.ip } : metadata,
  ]);
}

export type AuditQuery = {
  actor?: string;
  action?: string; // prefix match: "scim." returns every SCIM event
  target?: string;
  since?: string;
  until?: string;
  before?: number; // cursor: only entries with id < before
  limit?: number;
};

export type AuditEntry = { id: number; occurredAt: string; actor: string; action: string; target: string | null; metadata: Record<string, unknown> };

const MAX_LIMIT = 500;

/** Newest first, keyset-paginated on id (stable while new rows are appended). */
export async function queryAudit(q: AuditQuery): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (q.actor) add("actor = ?", q.actor);
  if (q.action) add("action like ? || '%'", q.action.replace(/[\\%_]/g, "\\$&"));
  if (q.target) add("target = ?", q.target);
  if (q.since) add("occurred_at >= ?::timestamptz", q.since);
  if (q.until) add("occurred_at < ?::timestamptz", q.until);
  if (q.before) add("id < ?", q.before);
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? 100));

  const { rows } = await pool.query(
    `select id, occurred_at, actor, action, target, metadata from audit_log
     ${where.length ? `where ${where.join(" and ")}` : ""} order by id desc limit ${limit + 1}`,
    args,
  );
  const page = rows.slice(0, limit).map((r) => ({
    id: Number(r.id),
    occurredAt: r.occurred_at.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target,
    metadata: r.metadata,
  }));
  return { entries: page, nextBefore: rows.length > limit ? page.at(-1)!.id : null };
}
