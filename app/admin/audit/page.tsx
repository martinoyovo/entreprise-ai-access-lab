import { cookies, headers } from "next/headers";
import { audit, queryAudit, userActor } from "@/lib/audit";
import { auditQueryFrom } from "@/lib/audit-params";
import { accessFor } from "@/lib/authz/access";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function AuditPage({ searchParams }: Props) {
  const session = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return <p>Not signed in. <a href="/auth/saml/login?returnTo=/admin/audit">Sign in</a></p>;
  if (!(await accessFor(session.user.id)).capabilities.has("admin:audit")) return <p>You need the admin:audit capability to view this page.</p>;

  const params = await searchParams;
  const query = auditQueryFrom((k) => params[k]);
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0].trim() || null;
  await audit(pool, userActor(session.user.email, ip), "admin.audit.view", null, { query });
  const { entries, nextBefore } = await queryAudit(query);
  const cell = { padding: "4px 8px", borderBottom: "1px solid #ddd", verticalAlign: "top" } as const;
  const next = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)), before: String(nextBefore) } as Record<string, string>);

  return (
    <main style={{ maxWidth: "none" }}>
      <p><a href="/">← Home</a></p>
      <h1>Audit log</h1>
      <p style={{ fontSize: 14 }}>Append-only. Newest first. Action filters match by prefix (e.g. <code>scim.</code>).</p>
      <form style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input name="actor" placeholder="actor (user:ada@…, scim)" defaultValue={params.actor} />
        <input name="action" placeholder="action prefix (scim.user.)" defaultValue={params.action} />
        <input name="target" placeholder="target (user:<id>)" defaultValue={params.target} />
        <input name="since" type="date" defaultValue={params.since} />
        <button type="submit">Filter</button>
        <a href="/admin/audit">Clear</a>
      </form>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
        <thead>
          <tr>{["Time (UTC)", "Actor", "Action", "Target", "Details"].map((h) => <th key={h} style={{ ...cell, textAlign: "left" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td style={cell}>{e.occurredAt.replace("T", " ").slice(0, 19)}</td>
              <td style={cell}><a href={`?actor=${encodeURIComponent(e.actor)}`}>{e.actor}</a></td>
              <td style={cell}>{e.action}</td>
              <td style={cell}>{e.target && <a href={`?target=${encodeURIComponent(e.target)}`}>{e.target}</a>}</td>
              <td style={cell}><code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(e.metadata)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && <p>No entries match.</p>}
      {nextBefore && <p><a href={`?${next}`}>Older →</a></p>}
    </main>
  );
}
