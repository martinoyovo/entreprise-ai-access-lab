import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import * as users from "@/app/scim/v2/Users/route";
import * as groups from "@/app/scim/v2/Groups/route";
import * as group from "@/app/scim/v2/Groups/[id]/route";
import * as chatRoute from "@/app/api/chat/route";
import * as me from "@/app/api/me/route";
import * as rolesRoute from "@/app/api/admin/roles/route";
import * as roleRoute from "@/app/api/admin/roles/[name]/route";
import { accessFor } from "@/lib/authz/access";
import { putRole } from "@/lib/authz/roles";
import { createSession } from "@/lib/auth/session";
import { runChat, type CreateMessage } from "@/lib/chat/run";
import { call, patch, userBody } from "./helpers";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
const APP = "https://lab.example.com";

// ---------- fixtures ----------

const groupIds = new Map<string, string>();
async function groupId(name: string) {
  if (!groupIds.has(name)) groupIds.set(name, (await call(groups.POST, { method: "POST", body: { displayName: name } })).body.id);
  return groupIds.get(name)!;
}
afterEach(() => groupIds.clear());

/** Provisions a user through SCIM and puts them in the given Okta groups. */
async function provision(email: string, groupNames: string[]) {
  const id = (await call(users.POST, { method: "POST", body: userBody(email) })).body.id as string;
  for (const g of groupNames) await setMembership(id, g, "add");
  return id;
}

const setMembership = async (userId: string, groupName: string, op: "add" | "remove") =>
  call(group.PATCH, {
    method: "PATCH",
    params: { id: await groupId(groupName) },
    body: op === "add" ? patch({ op: "add", path: "members", value: [{ value: userId }] }) : patch({ op: "remove", path: `members[value eq "${userId}"]` }),
  });

async function sessionCookie(userId: string) {
  const { token } = await createSession({ userId, idpGroups: [], sessionIndex: null, ip: null, userAgent: null });
  return `lab_session=${token}`;
}

const noParams = { params: Promise.resolve({}) };

// ---------- fake Claude ----------

function msg(content: Anthropic.Beta.BetaContentBlock[], stop_reason: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
  return { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason } as Anthropic.Beta.BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;
const toolUse = (name: string, input: object, id = "toolu_1") => ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaToolUseBlock;

/** Returns scripted responses in order and records every request. */
function fakeClaude(...responses: (Anthropic.Beta.BetaMessage | (() => Promise<Anthropic.Beta.BetaMessage>))[]) {
  const requests: Params[] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("fake Claude ran out of responses");
    return typeof next === "function" ? next() : next;
  };
  const toolNames = (i = 0) => (requests[i].tools ?? []).map((t) => ("name" in t ? t.name : t.type));
  return { createMessage, requests, toolNames };
}

const chat = (userId: string, fake: ReturnType<typeof fakeClaude>, content = "hi") =>
  runChat({ userId, userName: "Test", history: [{ role: "user", content }], createMessage: fake.createMessage, actor: { actor: "user:test@example.com", ip: null } });

// ---------- tests ----------

describe("group -> role -> capability resolution", () => {
  it("maps seeded groups to roles and capabilities", async () => {
    const eng = await provision("eng@example.com", ["Engineering"]);
    const sales = await provision("sales@example.com", ["Sales"]);
    const viewer = await provision("viewer@example.com", ["Lab Users"]);
    expect(await accessFor(eng)).toEqual({ roles: ["engineer"], capabilities: new Set(["chat", "tool:github"]) });
    expect(await accessFor(sales)).toEqual({ roles: ["sales"], capabilities: new Set(["chat", "tool:crm"]) });
    expect(await accessFor(viewer)).toEqual({ roles: ["viewer"], capabilities: new Set(["chat"]) });
  });

  it("unions roles across groups", async () => {
    const both = await provision("both@example.com", ["Engineering", "Sales"]);
    expect((await accessFor(both)).capabilities).toEqual(new Set(["chat", "tool:github", "tool:crm"]));
  });

  it("gives nothing to users whose groups map to no role (fail closed)", async () => {
    const id = await provision("nobody@example.com", ["Marketing"]);
    expect(await accessFor(id)).toEqual({ roles: [], capabilities: new Set() });
  });

  it("matches group names case-insensitively", async () => {
    const id = await provision("eng@example.com", ["ENGINEERING"]);
    expect((await accessFor(id)).roles).toEqual(["engineer"]);
  });
});

describe("chat only sends Claude the allowed tools", () => {
  const cases: [string, string[], string[]][] = [
    ["Engineering", ["Engineering"], ["github_search_issues", "github_get_pull_request"]],
    ["Sales", ["Sales"], ["crm_lookup_account", "crm_list_opportunities"]],
    ["Viewer", ["Lab Users"], []],
  ];
  for (const [label, groupNames, expected] of cases) {
    it(`${label}`, async () => {
      const id = await provision(`${label}@example.com`, groupNames);
      const fake = fakeClaude(msg([text("hello")], "end_turn"));
      const result = await chat(id, fake);
      expect(result.reply).toBe("hello");
      expect(fake.toolNames()).toEqual(expected);
      expect(fake.requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
      expect(fake.requests[0].mcp_servers).toBeUndefined();
    });
  }
});

describe("tool execution", () => {
  it("runs an allowed tool and sends the result back to Claude", async () => {
    const id = await provision("eng@example.com", ["Engineering"]);
    const fake = fakeClaude(
      msg([text("Searching."), toolUse("github_search_issues", { repo: "acme/api", query: "saml" })], "tool_use"),
      msg([text("Found issue #412.")], "end_turn"),
    );
    const result = await chat(id, fake, "any SAML bugs?");
    expect(result.reply).toBe("Found issue #412.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "github_search_issues", ok: true });
    expect(result.toolCalls[0].output).toContain("SSO login loops");

    const second = fake.requests[1].messages;
    expect(second.at(-2)!.role).toBe("assistant"); // full assistant content echoed back
    expect(second.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] });
  });

  it("refuses a tool the user's roles don't grant, even if Claude calls it", async () => {
    const id = await provision("eng@example.com", ["Engineering"]);
    const fake = fakeClaude(
      msg([toolUse("crm_lookup_account", { name: "Globex" })], "tool_use"),
      msg([text("You don't have CRM access.")], "end_turn"),
    );
    const result = await chat(id, fake);
    expect(result.toolCalls[0]).toMatchObject({ name: "crm_lookup_account", ok: false });
    expect(fake.requests[1].messages.at(-1)).toMatchObject({ content: [{ type: "tool_result", is_error: true }] });
  });

  it("refuses unknown tool names", async () => {
    const id = await provision("eng@example.com", ["Engineering"]);
    const fake = fakeClaude(msg([toolUse("drop_database", {})], "tool_use"), msg([text("ok")], "end_turn"));
    expect((await chat(id, fake)).toolCalls[0]).toMatchObject({ ok: false, output: expect.stringContaining("drop_database") });
  });

  it("returns all parallel tool results in one user message", async () => {
    const id = await provision("sales@example.com", ["Sales"]);
    const fake = fakeClaude(
      msg([toolUse("crm_lookup_account", { name: "Globex" }, "t1"), toolUse("crm_list_opportunities", { account: "" }, "t2")], "tool_use"),
      msg([text("done")], "end_turn"),
    );
    await chat(id, fake);
    const last = fake.requests[1].messages.at(-1)!;
    expect((last.content as unknown[]).map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(["t1", "t2"]);
  });

  it("reports refusals instead of an empty reply", async () => {
    const id = await provision("viewer@example.com", ["Lab Users"]);
    const result = await chat(id, fakeClaude(msg([], "refusal")));
    expect(result).toMatchObject({ stopReason: "refusal", reply: expect.stringContaining("declined") });
  });
});

describe("SCIM group changes take effect immediately", () => {
  it("between requests: removing a user from Engineering removes the GitHub tools", async () => {
    const id = await provision("eng@example.com", ["Engineering", "Lab Users"]);
    const before = fakeClaude(msg([text("hi")], "end_turn"));
    await chat(id, before);
    expect(before.toolNames()).toContain("github_search_issues");

    await setMembership(id, "Engineering", "remove");
    const after = fakeClaude(msg([text("hi")], "end_turn"));
    await chat(id, after);
    expect(after.toolNames()).toEqual([]);
  });

  it("mid-conversation: a tool call made after the group removal is refused", async () => {
    const id = await provision("eng@example.com", ["Engineering"]);
    const fake = fakeClaude(
      async () => {
        await setMembership(id, "Engineering", "remove"); // Okta pushes the change while Claude is thinking
        return msg([toolUse("github_search_issues", { repo: "acme/api", query: "saml" })], "tool_use");
      },
      msg([text("Access changed.")], "end_turn"),
    );
    const result = await chat(id, fake);
    expect(result.toolCalls[0]).toMatchObject({ ok: false, output: expect.stringContaining("Permission denied") });
  });

  it("losing every mapped group removes chat itself", async () => {
    const id = await provision("viewer@example.com", ["Lab Users"]);
    await setMembership(id, "Lab Users", "remove");
    await expect(chat(id, fakeClaude())).rejects.toThrow();
  });
});

describe("MCP connector gating", () => {
  afterEach(() => {
    delete process.env.MCP_DOCS_URL;
  });

  it("attaches the docs MCP server only for roles with connector:docs", async () => {
    process.env.MCP_DOCS_URL = "https://mcp.example.com/docs";
    await putRole("docs-reader", { capabilities: ["chat", "connector:docs"], groups: ["Docs Readers"] }, { actor: "test", ip: null });
    const reader = await provision("reader@example.com", ["Docs Readers"]);
    const viewer = await provision("viewer@example.com", ["Lab Users"]);

    const withDocs = fakeClaude(msg([text("hi")], "end_turn"));
    await chat(reader, withDocs);
    expect(withDocs.requests[0].mcp_servers).toEqual([{ type: "url", name: "docs", url: "https://mcp.example.com/docs", authorization_token: null }]);
    expect(withDocs.requests[0].tools).toContainEqual({ type: "mcp_toolset", mcp_server_name: "docs" });
    expect(withDocs.requests[0].betas).toContain("mcp-client-2025-11-20");

    const without = fakeClaude(msg([text("hi")], "end_turn"));
    await chat(viewer, without);
    expect(without.requests[0].mcp_servers).toBeUndefined();
    expect(without.requests[0].betas).not.toContain("mcp-client-2025-11-20");
  });
});

async function sessionAdmin() {
  const id = await provision("admin@example.com", ["Lab Admins"]);
  return { headers: { cookie: await sessionCookie(id) } };
}

describe("HTTP routes", () => {
  const post = (cookie: string | null, body: unknown) =>
    chatRoute.POST(
      new Request(`${APP}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...(cookie && { cookie }) }, body: JSON.stringify(body) }),
      noParams,
    );

  it("/api/chat needs a session and the chat capability", async () => {
    expect((await post(null, { messages: [{ role: "user", content: "hi" }] })).status).toBe(401);
    const id = await provision("nobody@example.com", ["Marketing"]);
    const res = await post(await sessionCookie(id), { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(403);
  });

  it("/api/chat validates the history", async () => {
    const id = await provision("viewer@example.com", ["Lab Users"]);
    const cookie = await sessionCookie(id);
    for (const bad of [{}, { messages: [] }, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "assistant", content: "x" }] }]) {
      expect((await post(cookie, bad)).status).toBe(400);
    }
  });

  it("/api/me reports roles, capabilities and tools", async () => {
    const id = await provision("eng@example.com", ["Engineering"]);
    const res = await me.GET(new Request(`${APP}/api/me`, { headers: { cookie: await sessionCookie(id) } }), noParams);
    expect(await res.json()).toMatchObject({
      groups: ["Engineering"],
      roles: ["engineer"],
      capabilities: ["chat", "tool:github"],
      tools: ["github_search_issues", "github_get_pull_request"],
    });
  });
});

describe("custom roles admin API", () => {
  const req = (method: string, cookie: string, body?: unknown) =>
    new Request(`${APP}/api/admin/roles`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const put = async (cookie: string, name: string, body: unknown) => roleRoute.PUT(req("PUT", cookie, body), { params: Promise.resolve({ name }) });

  it("is admin-only", async () => {
    const eng = await provision("eng@example.com", ["Engineering"]);
    const cookie = await sessionCookie(eng);
    expect((await rolesRoute.GET(req("GET", cookie), noParams)).status).toBe(403);
    expect((await put(cookie, "x", { capabilities: [], groups: [] })).status).toBe(403);
  });

  it("creates a custom role that immediately grants tools to its group", async () => {
    const { headers } = await sessionAdmin();
    const support = await provision("support@example.com", ["Support"]);
    expect((await accessFor(support)).capabilities.size).toBe(0);

    const res = await put(headers.cookie, "support", { description: "Support agents", capabilities: ["chat", "tool:crm"], groups: ["Support"] });
    expect(res.status).toBe(200);
    expect((await res.json()).roles).toContainEqual({ name: "support", description: "Support agents", capabilities: ["chat", "tool:crm"], groups: ["Support"] });

    const fake = fakeClaude(msg([text("hi")], "end_turn"));
    await chat(support, fake);
    expect(fake.toolNames()).toEqual(["crm_lookup_account", "crm_list_opportunities"]);
  });

  it("editing a role changes access on the next request", async () => {
    const { headers } = await sessionAdmin();
    const eng = await provision("eng@example.com", ["Engineering"]);
    await put(headers.cookie, "engineer", { capabilities: ["chat"], groups: ["Engineering"] });
    expect((await accessFor(eng)).capabilities).toEqual(new Set(["chat"]));
  });

  it("rejects unknown capabilities and bad names", async () => {
    const { headers } = await sessionAdmin();
    expect((await put(headers.cookie, "x-role", { capabilities: ["tool:everything"], groups: [] })).status).toBe(400);
    expect((await put(headers.cookie, "Bad Name", { capabilities: [], groups: [] })).status).toBe(400);
  });

  it("refuses changes that would lock every admin out", async () => {
    const { headers } = await sessionAdmin();
    const res = await put(headers.cookie, "admin", { capabilities: ["chat"], groups: ["Lab Admins"] });
    expect(res.status).toBe(409);
    const del = await roleRoute.DELETE(req("DELETE", headers.cookie), { params: Promise.resolve({ name: "admin" }) });
    expect(del.status).toBe(409);
    expect((await rolesRoute.GET(req("GET", headers.cookie), noParams)).status).toBe(200); // still an admin
  });

  it("deletes a role", async () => {
    const { headers } = await sessionAdmin();
    const sales = await provision("sales@example.com", ["Sales"]);
    const del = await roleRoute.DELETE(req("DELETE", headers.cookie), { params: Promise.resolve({ name: "sales" }) });
    expect(del.status).toBe(204);
    expect((await accessFor(sales)).roles).toEqual([]);
  });
});
