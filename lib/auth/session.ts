import { createHash, randomBytes } from "node:crypto";
import { pool, type Db } from "../db";

export const SESSION_COOKIE = "lab_session";
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 8); // absolute lifetime, like a workday

const hash = (token: string) => createHash("sha256").update(token).digest();

export type SessionUser = {
  sessionId: string;
  expiresAt: Date;
  user: { id: string; email: string; userName: string; displayName: string | null };
  groups: string[]; // from SCIM, read fresh on every request
};

export async function createSession(input: {
  userId: string;
  idpGroups: string[];
  sessionIndex: string | null;
  ip: string | null;
  userAgent: string | null;
}) {
  const token = randomBytes(32).toString("base64url"); // 256 bits: unguessable
  const { rows } = await pool.query(
    `insert into sessions (token_hash, user_id, idp_groups, saml_session_index, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7)) returning expires_at`,
    [hash(token), input.userId, input.idpGroups, input.sessionIndex, input.ip, input.userAgent, TTL_HOURS],
  );
  return { token, expiresAt: rows[0].expires_at as Date };
}

/**
 * Looks the session up on every request (no caching), so revoking it or deactivating
 * the user takes effect on the very next request.
 */
export async function getSessionUser(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    `update sessions s set last_seen_at = now()
     from users u
     where s.token_hash = $1 and u.id = s.user_id
       and s.revoked_at is null and s.expires_at > now() and u.active
     returning s.id, s.expires_at, u.id as user_id, u.email, u.user_name, u.display_name`,
    [hash(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const groups = await pool.query(
    "select g.display_name from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 order by 1",
    [r.user_id],
  );
  return {
    sessionId: r.id,
    expiresAt: r.expires_at,
    user: { id: r.user_id, email: r.email, userName: r.user_name, displayName: r.display_name },
    groups: groups.rows.map((g) => g.display_name),
  };
}

export async function revokeSession(token: string) {
  await pool.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hash(token)]);
}

/** Kills every live session for a user. Pass the transaction client to revoke atomically with a change. */
export async function revokeUserSessions(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
  return rowCount ?? 0;
}

export function tokenFromRequest(req: Request): string | null {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
  return m ? m[1] : null;
}

export function sessionCookie(token: string, expires: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true, // not readable by page scripts, so XSS can't steal it
    // Lax is enough: the cookie is set on the ACS response itself, and Lax stops other
    // sites from sending it on cross-site POSTs (basic CSRF protection for /auth/logout).
    sameSite: "lax" as const,
    secure: (process.env.APP_BASE_URL ?? "").startsWith("https://"),
    path: "/",
    expires,
  };
}
