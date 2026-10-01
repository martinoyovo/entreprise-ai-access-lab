import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import * as users from "@/app/scim/v2/Users/route";
import * as user from "@/app/scim/v2/Users/[id]/route";
import * as groups from "@/app/scim/v2/Groups/route";
import * as group from "@/app/scim/v2/Groups/[id]/route";
import * as login from "@/app/auth/saml/login/route";
import * as acs from "@/app/auth/saml/acs/route";
import * as logout from "@/app/auth/logout/route";
import * as me from "@/app/api/me/route";
import * as chatRoute from "@/app/api/chat/route";
import * as auditRoute from "@/app/api/admin/audit/route";
import * as roleRoute from "@/app/api/admin/roles/[name]/route";
import { pool } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { runChat } from "@/lib/chat/run";
import { call, patch, userBody } from "./helpers";
import { requestIdFrom, samlResponse } from "./fake-idp";

const APP = "https://lab.example.com";
const noParams = { params: Promise.resolve({}) };

// ---------- helpers ----------

async function provision(email: string, groupName?: string) {
  const id = (await call(users.POST, { method: "POST", body: userBody(email) })).body.id as string;
  if (groupName) {
    const existing = await call(groups.GET, { path: `/Groups?filter=displayName eq "${groupName}"` });
    const gid = existing.body.Resources[0]?.id ?? (await call(groups.POST, { method: "POST", body: { displayName: groupName } })).body.id;
    await call(group.PATCH, { method: "PATCH", params: { id: gid }, body: patch({ op: "add", path: "members", value: [{ value: id }] }) });
  }
  return id;
}

async function cookieFor(userId: string) {
  const { token } = await createSession({ userId, idpGroups: [], sessionIndex: null, ip: null, userAgent: null });
  return `lab_session=${token}`;
}

const whoami = (cookie: string) => me.GET(new Request(`${APP}/api/me`, { headers: { cookie } }), noParams);
const deactivate = (id: string, body = patch({ op: "replace", value: { active: false } })) =>
  call(user.PATCH, { method: "PATCH", params: { id }, body });

async function entries(where = "true", args: unknown[] = []) {
  const { rows } = await pool.query(`select actor, action, target, metadata from audit_log where ${where} order by id`, args);
  return rows;
}
const actions = async () => (await entries()).map((e) => e.action);

// ---------- deprovisioning ----------

describe("deprovisioning revokes sessions immediately", () => {
  it("Okta-style PATCH active:false kills every live session", async () => {
    const id = await provision("ada@example.com", "Lab Users");
    const [a, b] = [await cookieFor(id), await cookieFor(id)]; // e.g. laptop and phone
    expect((await whoami(a)).status).toBe(200);

    await deactivate(id);
    expect((await whoami(a)).status).toBe(401);
    expect((await whoami(b)).status).toBe(401);
    const { rows } = await pool.query("select count(*)::int as n from sessions where user_id = $1 and revoked_at is null", [id]);
    expect(rows[0].n).toBe(0);
    const [entry] = await entries("action = 'scim.user.deactivate'");
    expect(entry).toMatchObject({ actor: "scim", target: `user:${id}`, metadata: { sessionsRevoked: 2 } });
  });

  it("Entra-style PATCH (string boolean) and PUT deactivate too", async () => {
    const entra = await provision("entra@example.com");
    const c1 = await cookieFor(entra);
    await deactivate(entra, patch({ op: "Replace", path: "active", value: "False" }));
    expect((await whoami(c1)).status).toBe(401);

    const put = await provision("put@example.com");
    const c2 = await cookieFor(put);
    await call(user.PUT, { method: "PUT", params: { id: put }, body: userBody("put@example.com", { active: false }) });
    expect((await whoami(c2)).status).toBe(401);
  });

  it("DELETE removes the user and their sessions, and records how many", async () => {
    const id = await provision("ada@example.com");
    const cookie = await cookieFor(id);
    await call(user.DELETE, { method: "DELETE", params: { id } });
    expect((await whoami(cookie)).status).toBe(401);
    const [entry] = await entries("action = 'scim.user.delete'");
    expect(entry.metadata).toMatchObject({ userName: "ada@example.com", email: "ada@example.com", sessionsRevoked: 1 });
  });

  it("the next /api/chat request fails", async () => {
    const id = await provision("ada@example.com", "Lab Users");
    const cookie = await cookieFor(id);
    await deactivate(id);
    const res = await chatRoute.POST(
      new Request(`${APP}/api/chat`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }),
      noParams,
    );
    expect(res.status).toBe(401);
  });

  it("an in-flight chat can't run tools after deactivation", async () => {
    const id = await provision("eng@example.com", "Engineering");
    const tool = { type: "tool_use", id: "t1", name: "github_search_issues", input: { repo: "acme/api", query: "saml" } };
    const replies = [
      async () => {
        await deactivate(id); // Okta deprovisions while Claude is generating
        return { role: "assistant", content: [tool], stop_reason: "tool_use" };
      },
      async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    ];
    const result = await runChat({
      userId: id, userName: "Eng", history: [{ role: "user", content: "hi" }], actor: { actor: "user:eng@example.com", ip: null },
      createMessage: async () => (await replies.shift()!()) as unknown as Anthropic.Beta.BetaMessage,
    });
    expect(result.toolCalls[0]).toMatchObject({ ok: false });
  });

  it("reactivating doesn't bring old sessions back", async () => {
    const id = await provision("ada@example.com");
    const cookie = await cookieFor(id);
    await deactivate(id);
    await call(user.PATCH, { method: "PATCH", params: { id }, body: patch({ op: "replace", value: { active: true } }) });
    expect((await whoami(cookie)).status).toBe(401);
    expect(await actions()).toContain("scim.user.reactivate");
  });

  it("a retried deactivation is logged once", async () => {
    const id = await provision("ada@example.com");
    await deactivate(id);
    await deactivate(id);
    expect((await actions()).filter((a) => a === "scim.user.deactivate")).toHaveLength(1);
  });
});

// ---------- what gets logged ----------

describe("audit coverage", () => {
  it("SCIM user and group changes, with membership changes filed under the user", async () => {
    const id = await provision("ada@example.com", "Engineering");
    const gid = (await call(groups.GET, { path: '/Groups?filter=displayName eq "Engineering"' })).body.Resources[0].id;
    await call(group.PATCH, { method: "PATCH", params: { id: gid }, body: patch({ op: "remove", path: `members[value eq "${id}"]` }) });
    await call(group.PATCH, { method: "PATCH", params: { id: gid }, body: patch({ op: "replace", path: "displayName", value: "Platform" }) });
    await call(group.DELETE, { method: "DELETE", params: { id: gid } });

    expect(await actions()).toEqual([
      "scim.user.create", "scim.group.create", "scim.group.member_add", "scim.group.member_remove", "scim.group.rename", "scim.group.delete",
    ]);
    const userTrail = await entries("target = $1", [`user:${id}`]);
    expect(userTrail.map((e) => e.action)).toEqual(["scim.user.create", "scim.group.member_add", "scim.group.member_remove"]);
    expect(userTrail[1].metadata).toMatchObject({ group: "Engineering", groupId: gid });
  });

  it("doesn't log no-op retries", async () => {
    const id = await provision("ada@example.com", "Engineering");
    const gid = (await call(groups.GET, { path: '/Groups?filter=displayName eq "Engineering"' })).body.Resources[0].id;
    const before = (await actions()).length;
    await call(group.PATCH, { method: "PATCH", params: { id: gid }, body: patch({ op: "add", path: "members", value: [{ value: id }] }) });
    await call(user.PUT, { method: "PUT", params: { id }, body: userBody("ada@example.com") });
    expect((await actions()).length).toBe(before);
  });

  it("a failed change leaves no audit entry (same transaction)", async () => {
    await provision("ada@example.com");
    const before = (await actions()).length;
    expect((await call(users.POST, { method: "POST", body: userBody("ada@example.com") })).status).toBe(409);
    expect((await actions()).length).toBe(before);
  });

  it("logins, failed logins and logouts", async () => {
    const id = await provision("ada@example.com");
    const start = async () => requestIdFrom((await login.GET(new Request(`${APP}/auth/saml/login`))).headers.get("location")!);
    const post = (r: string) => {
      const form = new FormData();
      form.set("SAMLResponse", r);
      return acs.POST(new Request(`${APP}/auth/saml/acs`, { method: "POST", body: form, headers: { "x-forwarded-for": "203.0.113.7" } }));
    };

    const ok = await post(samlResponse({ email: "ada@example.com", groups: ["Engineering"], inResponseTo: await start() }));
    await post(samlResponse({ email: "ghost@example.com", inResponseTo: await start() }));
    await post(samlResponse({ email: "ada@example.com", inResponseTo: "_forged" }));
    const cookie = /lab_session=[^;]+/.exec(ok.headers.get("set-cookie")!)![0];
    await logout.POST(new Request(`${APP}/auth/logout`, { method: "POST", headers: { cookie } }));

    const auth = await entries("action like 'auth.%'");
    expect(auth).toMatchObject([
      { actor: "user:ada@example.com", action: "auth.login", target: `user:${id}`, metadata: { idpGroups: ["Engineering"], ip: "203.0.113.7" } },
      { actor: "user:ghost@example.com", action: "auth.login_failed", metadata: { reason: "not provisioned or inactive" } },
      { actor: "anonymous", action: "auth.login_failed", metadata: { reason: expect.stringContaining("InResponseTo") } },
      { actor: "user:ada@example.com", action: "auth.logout", target: `user:${id}` },
    ]);
  });

  it("role changes, with before and after", async () => {
    const admin = await provision("admin@example.com", "Lab Admins");
    const res = await roleRoute.PUT(
      new Request(`${APP}/api/admin/roles/sales`, { method: "PUT", headers: { cookie: await cookieFor(admin) }, body: JSON.stringify({ capabilities: ["chat"], groups: ["Sales"] }) }),
      { params: Promise.resolve({ name: "sales" }) },
    );
    expect(res.status).toBe(200);
    const [entry] = await entries("action = 'role.update'");
    expect(entry).toMatchObject({
      actor: "user:admin@example.com",
      target: "role:sales",
      metadata: { before: { capabilities: ["chat", "tool:crm"], groups: ["Sales"] }, after: { capabilities: ["chat"], groups: ["Sales"] } },
    });
  });

  it("Claude tool calls, allowed and denied", async () => {
    const id = await provision("eng@example.com", "Engineering");
    const script = [
      { content: [
        { type: "tool_use", id: "t1", name: "github_search_issues", input: { repo: "acme/api", query: "saml" } },
        { type: "tool_use", id: "t2", name: "crm_lookup_account", input: { name: "Globex" } },
      ], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ];
    await runChat({
      userId: id, userName: "Eng", history: [{ role: "user", content: "hi" }], actor: { actor: "user:eng@example.com", ip: "198.51.100.1" },
      createMessage: async () => ({ role: "assistant", ...script.shift()! }) as unknown as Anthropic.Beta.BetaMessage,
    });
    // Parallel calls may finish in either order, so compare sorted by target.
    const logged = (await entries("action like 'claude.%'")).sort((a, b) => a.target.localeCompare(b.target));
    expect(logged).toMatchObject([
      { actor: "user:eng@example.com", action: "claude.tool_call_failed", target: "tool:crm_lookup_account", metadata: { denied: true, capability: "tool:crm" } },
      { actor: "user:eng@example.com", action: "claude.tool_call", target: "tool:github_search_issues",
        metadata: { input: { repo: "acme/api", query: "saml" }, capability: "tool:github", ip: "198.51.100.1", outputChars: expect.any(Number) } },
    ]);
  });
});

// ---------- append-only ----------

describe("append-only", () => {
  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    await provision("ada@example.com");
    await expect(pool.query("update audit_log set actor = 'someone-else'")).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
    await expect(pool.query("truncate audit_log")).rejects.toThrow(/append-only/);
    expect((await entries())[0].actor).toBe("scim");
  });
});

// ---------- read API ----------

describe("GET /api/admin/audit", () => {
  const get = async (cookie: string, qs = "") => auditRoute.GET(new Request(`${APP}/api/admin/audit${qs}`, { headers: { cookie } }), noParams);

  it("requires admin:audit", async () => {
    const eng = await provision("eng@example.com", "Engineering");
    expect((await get(await cookieFor(eng))).status).toBe(403);
    expect((await auditRoute.GET(new Request(`${APP}/api/admin/audit`), noParams)).status).toBe(401);
  });

  it("filters, paginates newest-first, and logs the query itself", async () => {
    const admin = await provision("admin@example.com", "Lab Admins");
    for (const n of [1, 2, 3]) await provision(`u${n}@example.com`);
    const cookie = await cookieFor(admin);

    const page1 = await (await get(cookie, "?action=scim.user.&limit=2")).json();
    expect(page1.entries.map((e: { metadata: { userName: string } }) => e.metadata.userName)).toEqual(["u3@example.com", "u2@example.com"]);
    expect(page1.nextBefore).toBe(page1.entries[1].id);
    const page2 = await (await get(cookie, `?action=scim.user.&limit=2&before=${page1.nextBefore}`)).json();
    expect(page2.entries.map((e: { metadata: { userName: string } }) => e.metadata.userName)).toEqual(["u1@example.com", "admin@example.com"]);

    const byTarget = await (await get(cookie, `?target=user:${admin}`)).json();
    expect(byTarget.entries.map((e: { action: string }) => e.action)).toEqual(["scim.group.member_add", "scim.user.create"]);

    const queries = await entries("action = 'admin.audit.query'");
    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatchObject({ actor: "user:admin@example.com", metadata: { query: { action: "scim.user.", limit: 2 } } });
  });

  it("treats % and _ in the action filter literally", async () => {
    const admin = await provision("admin@example.com", "Lab Admins");
    const body = await (await get(await cookieFor(admin), "?action=%25")).json();
    expect(body.entries).toEqual([]);
  });
});
