import { describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import * as users from "@/app/scim/v2/Users/route";
import * as user from "@/app/scim/v2/Users/[id]/route";
import * as groups from "@/app/scim/v2/Groups/route";
import * as login from "@/app/auth/saml/login/route";
import * as acs from "@/app/auth/saml/acs/route";
import * as metadata from "@/app/auth/saml/metadata/route";
import * as logout from "@/app/auth/logout/route";
import * as me from "@/app/api/me/route";
import { call, patch, userBody } from "./helpers";
import { ATTACKER, requestIdFrom, samlResponse } from "./fake-idp";

const APP = "https://lab.example.com";

async function provision(email = "ada@example.com") {
  return (await call(users.POST, { method: "POST", body: userBody(email) })).body.id as string;
}

/** Starts an SP-initiated login and returns the AuthnRequest ID the IdP must answer. */
async function startLogin(returnTo?: string) {
  const res = await login.GET(new Request(`${APP}/auth/saml/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`));
  const location = res.headers.get("location")!;
  return { location, requestId: requestIdFrom(location) };
}

async function postAcs(SAMLResponse: string, RelayState = "/") {
  const form = new FormData();
  form.set("SAMLResponse", SAMLResponse);
  form.set("RelayState", RelayState);
  return acs.POST(new Request(`${APP}/auth/saml/acs`, { method: "POST", body: form }));
}

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return /lab_session=([^;]+)/.exec(set)![1];
}

async function signIn(email = "ada@example.com", groupNames: string[] = []) {
  const { requestId } = await startLogin();
  const res = await postAcs(samlResponse({ email, groups: groupNames, inResponseTo: requestId }));
  expect(res.status).toBe(303);
  return cookieFrom(res);
}

const noParams = { params: Promise.resolve({}) };
const whoami = (token: string) => me.GET(new Request(`${APP}/api/me`, { headers: { cookie: `lab_session=${token}` } }), noParams);

describe("SP metadata and login redirect", () => {
  it("publishes SP metadata with the ACS URL and entity ID", async () => {
    const xml = await (await metadata.GET()).text();
    expect(xml).toContain(`entityID="${APP}/auth/saml/metadata"`);
    expect(xml).toContain(`Location="${APP}/auth/saml/acs"`);
  });

  it("redirects to the IdP with a stored AuthnRequest", async () => {
    const { location, requestId } = await startLogin("/chat");
    expect(location.startsWith("https://idp.example.com/sso/saml?")).toBe(true);
    expect(new URL(location).searchParams.get("RelayState")).toBe("/chat");
    const { rowCount } = await pool.query("select 1 from saml_requests where id = $1", [requestId]);
    expect(rowCount).toBe(1);
  });

  it("refuses off-site returnTo values (no open redirect)", async () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      const { location } = await startLogin(bad);
      expect(new URL(location).searchParams.get("RelayState")).toBe("/");
    }
  });
});

describe("ACS: successful login", () => {
  it("creates a Postgres session and sets a secure cookie", async () => {
    await provision();
    const { requestId } = await startLogin("/chat");
    const res = await postAcs(samlResponse({ email: "ada@example.com", groups: ["Engineering"], inResponseTo: requestId }), "/chat");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP}/chat`);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=lax/i);

    const token = cookieFrom(res);
    const { rows } = await pool.query("select token_hash, idp_groups from sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toString("utf8")).not.toContain(token); // only the hash is stored
    expect(rows[0].idp_groups).toEqual(["Engineering"]);
  });

  it("matches the SCIM user by email, case-insensitively, and reports SCIM groups", async () => {
    const id = await provision("ada@example.com");
    await call(groups.POST, { method: "POST", body: { displayName: "Engineering", members: [{ value: id }] } });
    const token = await signIn("Ada@Example.COM", ["Something the IdP says"]);
    const body = await (await whoami(token)).json();
    expect(body.user).toMatchObject({ id, email: "ada@example.com" });
    expect(body.groups).toEqual(["Engineering"]); // SCIM, not the assertion, decides
  });
});

describe("ACS: rejected logins", () => {
  it("rejects users SCIM never provisioned (no JIT)", async () => {
    const { requestId } = await startLogin();
    const res = await postAcs(samlResponse({ email: "stranger@example.com", inResponseTo: requestId }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects deactivated users", async () => {
    const id = await provision();
    await call(user.PATCH, { method: "PATCH", params: { id }, body: patch({ op: "replace", value: { active: false } }) });
    const { requestId } = await startLogin();
    expect((await postAcs(samlResponse({ email: "ada@example.com", inResponseTo: requestId }))).status).toBe(403);
  });

  it("rejects an assertion edited after signing", async () => {
    await provision("ada@example.com");
    await provision("eve@example.com");
    const { requestId } = await startLogin();
    const forged = samlResponse({
      email: "eve@example.com",
      inResponseTo: requestId,
      tamper: (xml) => xml.replaceAll("eve@example.com", "ada@example.com"),
    });
    expect((await postAcs(forged)).status).toBe(401);
  });

  it("rejects assertions signed by a different key", async () => {
    await provision();
    const { requestId } = await startLogin();
    expect((await postAcs(samlResponse({ email: "ada@example.com", inResponseTo: requestId, signWith: ATTACKER }))).status).toBe(401);
  });

  it("rejects unsigned assertions", async () => {
    await provision();
    const { requestId } = await startLogin();
    expect((await postAcs(samlResponse({ email: "ada@example.com", inResponseTo: requestId, signWith: null }))).status).toBe(401);
  });

  it("rejects a replayed response", async () => {
    await provision();
    const { requestId } = await startLogin();
    const response = samlResponse({ email: "ada@example.com", inResponseTo: requestId });
    expect((await postAcs(response)).status).toBe(303);
    expect((await postAcs(response)).status).toBe(401);
  });

  it("rejects unsolicited (IdP-initiated) and unknown-request responses", async () => {
    await provision();
    expect((await postAcs(samlResponse({ email: "ada@example.com", inResponseTo: null }))).status).toBe(401);
    expect((await postAcs(samlResponse({ email: "ada@example.com", inResponseTo: "_never-sent" }))).status).toBe(401);
  });

  it("rejects expired assertions and assertions for another audience", async () => {
    await provision();
    let { requestId } = await startLogin();
    const expired = samlResponse({ email: "ada@example.com", inResponseTo: requestId, notOnOrAfter: new Date(Date.now() - 5 * 60_000) });
    expect((await postAcs(expired)).status).toBe(401);
    ({ requestId } = await startLogin());
    const otherApp = samlResponse({ email: "ada@example.com", inResponseTo: requestId, audience: "https://other-app.example" });
    expect((await postAcs(otherApp)).status).toBe(401);
  });

  it("returns 400 without a SAMLResponse", async () => {
    const res = await acs.POST(new Request(`${APP}/auth/saml/acs`, { method: "POST", body: new FormData() }));
    expect(res.status).toBe(400);
  });
});

describe("sessions", () => {
  it("/api/me is 401 without a valid cookie", async () => {
    expect((await me.GET(new Request(`${APP}/api/me`), noParams)).status).toBe(401);
    expect((await whoami("made-up-token")).status).toBe(401);
  });

  it("logout revokes the session server-side, so a copied cookie stops working", async () => {
    await provision();
    const token = await signIn();
    expect((await whoami(token)).status).toBe(200);
    const res = await logout.POST(new Request(`${APP}/auth/logout`, { method: "POST", headers: { cookie: `lab_session=${token}` } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/lab_session=;/);
    expect((await whoami(token)).status).toBe(401);
    const { rows } = await pool.query("select revoked_at from sessions");
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("stops working once expired", async () => {
    await provision();
    const token = await signIn();
    await pool.query("update sessions set expires_at = now() - interval '1 second'");
    expect((await whoami(token)).status).toBe(401);
  });

  it("stops working as soon as SCIM deactivates the user", async () => {
    const id = await provision();
    const token = await signIn();
    await call(user.PATCH, { method: "PATCH", params: { id }, body: patch({ op: "replace", value: { active: false } }) });
    expect((await whoami(token)).status).toBe(401);
  });
});
