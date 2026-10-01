import type { AuditQuery } from "./audit";

/** Reads audit filters from query-string params (shared by the API and the admin page). */
export function auditQueryFrom(get: (k: string) => string | null | undefined): AuditQuery {
  const s = (k: string) => get(k)?.trim() || undefined;
  const n = (k: string) => (s(k) && /^\d+$/.test(s(k)!) ? Number(s(k)) : undefined);
  const date = (k: string) => (s(k) && !Number.isNaN(Date.parse(s(k)!)) ? s(k) : undefined);
  return { actor: s("actor"), action: s("action"), target: s("target"), since: date("since"), until: date("until"), before: n("before"), limit: n("limit") };
}
