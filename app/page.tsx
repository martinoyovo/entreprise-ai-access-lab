import { cookies } from "next/headers";
import { accessFor } from "@/lib/authz/access";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth/session";
import { toolsFor } from "@/lib/tools/registry";
import Chat from "./chat";

export const dynamic = "force-dynamic"; // depends on the session cookie

export default async function Home() {
  const session = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <main>
        <h1>Enterprise AI Access Lab</h1>
        <p>Access is managed by your company&apos;s identity provider.</p>
        <a href="/auth/saml/login">Sign in with Okta</a>
      </main>
    );
  }

  const access = await accessFor(session.user.id);
  const tools = toolsFor(access.capabilities).map((t) => t.definition.name);

  return (
    <main>
      <h1>Enterprise AI Access Lab</h1>
      <p>
        Signed in as <strong>{session.user.displayName ?? session.user.email}</strong> ({session.user.email})
      </p>
      <ul style={{ fontSize: 14 }}>
        <li>Groups (from SCIM): {session.groups.join(", ") || "none"}</li>
        <li>Roles: {access.roles.join(", ") || "none"}</li>
        <li>Capabilities: {[...access.capabilities].sort().join(", ") || "none"}</li>
        <li>Tools Claude can use for you: {tools.join(", ") || "none (chat only)"}</li>
      </ul>
      {access.capabilities.has("admin:audit") && <p><a href="/admin/audit">Audit log</a></p>}
      <form method="post" action="/auth/logout">
        <button type="submit">Sign out</button>
      </form>
      <hr />
      {access.capabilities.has("chat") ? (
        <Chat />
      ) : (
        <p>Your groups don&apos;t map to any role with chat access. Ask an admin to add you to a group in Okta.</p>
      )}
    </main>
  );
}
