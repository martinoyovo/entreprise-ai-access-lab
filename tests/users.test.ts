import { describe, expect, it } from "vitest";
import * as users from "@/app/scim/v2/Users/route";
import * as user from "@/app/scim/v2/Users/[id]/route";
import { BASE, call, patch, userBody } from "./helpers";

const create = async (email = "ada@example.com", extra = {}) =>
  (await call(users.POST, { method: "POST", body: userBody(email, extra) })).body;

describe("auth and errors", () => {
  it("rejects missing and wrong bearer tokens with a SCIM error", async () => {
    for (const token of [null, "wrong"]) {
      const res = await call(users.GET, { token });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    }
  });

  it("responds with application/scim+json", async () => {
    const res = await call(users.GET);
    expect(res.headers.get("content-type")).toBe("application/scim+json");
  });

  it("rejects invalid JSON", async () => {
    const res = await call(users.POST, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidSyntax");
  });
});

describe("POST /Users", () => {
  it("creates a user", async () => {
    const res = await call(users.POST, { method: "POST", body: userBody("Ada@Example.com", { externalId: "00u1" }) });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${BASE}/Users/${res.body.id}`);
    expect(res.body).toMatchObject({
      userName: "Ada@Example.com",
      externalId: "00u1",
      active: true,
      emails: [{ value: "ada@example.com", primary: true }], // normalised: this is the SAML join key
      groups: [],
      meta: { resourceType: "User", version: 'W/"1"' },
    });
  });

  it("returns 409 uniqueness when the user already exists (retried POST)", async () => {
    await create();
    const res = await call(users.POST, { method: "POST", body: userBody("ADA@example.com") });
    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe("uniqueness");
  });

  it("falls back to userName as email, and requires one of them", async () => {
    const ok = await call(users.POST, { method: "POST", body: { userName: "bob@example.com" } });
    expect(ok.body.emails[0].value).toBe("bob@example.com");
    const bad = await call(users.POST, { method: "POST", body: { userName: "bob" } });
    expect(bad.status).toBe(400);
    const none = await call(users.POST, { method: "POST", body: {} });
    expect(none.status).toBe(400);
  });
});

describe("GET /Users", () => {
  it("filters by userName case-insensitively", async () => {
    await create("ada@example.com");
    await create("bob@example.com");
    const res = await call(users.GET, { path: '/Users?filter=userName%20eq%20%22ADA%40example.com%22' });
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources[0].userName).toBe("ada@example.com");
  });

  it("returns an empty list, not 404, when the filter matches nothing", async () => {
    const res = await call(users.GET, { path: '/Users?filter=userName eq "ghost@example.com"' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalResults: 0, Resources: [] });
  });

  it("filters by externalId and emails.value", async () => {
    await create("ada@example.com", { externalId: "abc" });
    expect((await call(users.GET, { path: '/Users?filter=externalId eq "abc"' })).body.totalResults).toBe(1);
    expect((await call(users.GET, { path: '/Users?filter=emails.value eq "ada@example.com"' })).body.totalResults).toBe(1);
  });

  it("rejects unsupported filters instead of returning everyone", async () => {
    const res = await call(users.GET, { path: '/Users?filter=userName sw "a"' });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidFilter");
  });

  it("paginates with 1-based startIndex and count", async () => {
    for (const n of [1, 2, 3, 4, 5]) await create(`u${n}@example.com`);
    const res = await call(users.GET, { path: "/Users?startIndex=2&count=2" });
    expect(res.body).toMatchObject({ totalResults: 5, startIndex: 2, itemsPerPage: 2 });
    expect(res.body.Resources.map((u: { userName: string }) => u.userName)).toEqual(["u2@example.com", "u3@example.com"]);
    const counted = await call(users.GET, { path: "/Users?count=0" });
    expect(counted.body).toMatchObject({ totalResults: 5, Resources: [] });
  });
});

describe("GET /Users/:id", () => {
  it("returns the user with an ETag", async () => {
    const u = await create();
    const res = await call(user.GET, { params: { id: u.id } });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(u.id);
    expect(res.headers.get("etag")).toBe('W/"1"');
  });

  it("returns 404 for unknown and malformed ids", async () => {
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
      const res = await call(user.GET, { params: { id } });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe("404");
    }
  });
});

describe("PUT /Users/:id", () => {
  it("replaces the user and is idempotent", async () => {
    const u = await create();
    const body = userBody("ada.l@example.com", { name: { givenName: "Augusta" }, active: false });
    const first = await call(user.PUT, { method: "PUT", params: { id: u.id }, body });
    const second = await call(user.PUT, { method: "PUT", params: { id: u.id }, body });
    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userName: "ada.l@example.com", active: false, name: { givenName: "Augusta" } });
      expect(res.body.name.familyName).toBeUndefined(); // full replace clears omitted fields
    }
  });

  it("returns 404 for an unknown user", async () => {
    const res = await call(user.PUT, { method: "PUT", params: { id: "00000000-0000-0000-0000-000000000000" }, body: userBody("x@example.com") });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /Users/:id", () => {
  it("deactivates with Okta's shape (no path, value object)", async () => {
    const u = await create();
    const res = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body: patch({ op: "replace", value: { active: false } }) });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("deactivates with Entra's shape (capitalised op, path, string boolean)", async () => {
    const u = await create();
    const res = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body: patch({ op: "Replace", path: "active", value: "False" }) });
    expect(res.body.active).toBe(false);
  });

  it("is idempotent when the same deactivation is retried", async () => {
    const u = await create();
    const body = patch({ op: "replace", value: { active: false } });
    await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body });
    const again = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body });
    expect(again.status).toBe(200);
    expect(again.body.active).toBe(false);
  });

  it("applies Entra attribute paths and ignores unknown extension attributes", async () => {
    const u = await create();
    const res = await call(user.PATCH, {
      method: "PATCH",
      params: { id: u.id },
      body: patch(
        { op: "Replace", path: 'emails[type eq "work"].value', value: "ada.new@example.com" },
        { op: "Replace", path: "name.givenName", value: "Augusta" },
        { op: "Add", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "R&D" },
        { op: "Replace", value: { "name.familyName": "King", displayName: "Augusta King" } },
      ),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      emails: [{ value: "ada.new@example.com" }],
      name: { givenName: "Augusta", familyName: "King" },
      displayName: "Augusta King",
      meta: { version: 'W/"2"' },
    });
  });

  it("rejects bad PATCH bodies", async () => {
    const u = await create();
    const noSchema = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body: { Operations: [] } });
    expect(noSchema.status).toBe(400);
    const badOp = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body: patch({ op: "move", path: "active" }) });
    expect(badOp.status).toBe(400);
    const badBool = await call(user.PATCH, { method: "PATCH", params: { id: u.id }, body: patch({ op: "replace", path: "active", value: "nope" }) });
    expect(badBool.body.scimType).toBe("invalidValue");
  });

  it("returns 409 when a rename collides with another user", async () => {
    const a = await create("a@example.com");
    await create("b@example.com");
    const res = await call(user.PATCH, { method: "PATCH", params: { id: a.id }, body: patch({ op: "replace", path: "userName", value: "b@example.com" }) });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /Users/:id", () => {
  it("deletes, then returns 404 on repeat and on GET", async () => {
    const u = await create();
    expect((await call(user.DELETE, { method: "DELETE", params: { id: u.id } })).status).toBe(204);
    expect((await call(user.DELETE, { method: "DELETE", params: { id: u.id } })).status).toBe(404);
    expect((await call(user.GET, { params: { id: u.id } })).status).toBe(404);
  });
});
