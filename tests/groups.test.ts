import { describe, expect, it } from "vitest";
import * as users from "@/app/scim/v2/Users/route";
import * as user from "@/app/scim/v2/Users/[id]/route";
import * as groups from "@/app/scim/v2/Groups/route";
import * as group from "@/app/scim/v2/Groups/[id]/route";
import { call, patch, userBody } from "./helpers";

const mkUser = async (email: string) => (await call(users.POST, { method: "POST", body: userBody(email) })).body.id as string;
const mkGroup = async (displayName: string, members: string[] = []) =>
  (await call(groups.POST, {
    method: "POST",
    body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName, members: members.map((value) => ({ value })) },
  })).body;
const memberIds = async (id: string) =>
  ((await call(group.GET, { params: { id } })).body.members as { value: string }[]).map((m) => m.value).sort();
const doPatch = (id: string, ...ops: unknown[]) => call(group.PATCH, { method: "PATCH", params: { id }, body: patch(...ops) });

describe("POST /Groups", () => {
  it("creates a group with members", async () => {
    const ada = await mkUser("ada@example.com");
    const res = await call(groups.POST, { method: "POST", body: { displayName: "Engineering", externalId: "okta-1", members: [{ value: ada }] } });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toContain(`/Groups/${res.body.id}`);
    expect(res.body).toMatchObject({ displayName: "Engineering", externalId: "okta-1", members: [{ value: ada }] });
  });

  it("returns 409 on duplicate displayName and 400 without one", async () => {
    await mkGroup("Engineering");
    expect((await call(groups.POST, { method: "POST", body: { displayName: "engineering" } })).status).toBe(409);
    expect((await call(groups.POST, { method: "POST", body: {} })).status).toBe(400);
  });

  it("requires a bearer token", async () => {
    expect((await call(groups.POST, { method: "POST", body: { displayName: "X" }, token: null })).status).toBe(401);
  });
});

describe("GET /Groups", () => {
  it("filters by displayName and paginates", async () => {
    await mkGroup("Engineering");
    await mkGroup("Sales");
    await mkGroup("Viewers");
    const f = await call(groups.GET, { path: '/Groups?filter=displayName eq "sales"' });
    expect(f.body.totalResults).toBe(1);
    const page = await call(groups.GET, { path: "/Groups?startIndex=3&count=10" });
    expect(page.body).toMatchObject({ totalResults: 3, startIndex: 3, itemsPerPage: 1 });
  });

  it("omits members when excludedAttributes=members", async () => {
    const ada = await mkUser("ada@example.com");
    const g = await mkGroup("Engineering", [ada]);
    const list = await call(groups.GET, { path: "/Groups?excludedAttributes=members" });
    expect(list.body.Resources[0].members).toBeUndefined();
    const one = await call(group.GET, { path: `/Groups/${g.id}?excludedAttributes=members`, params: { id: g.id } });
    expect(one.body.members).toBeUndefined();
  });

  it("GET by id returns 404 for unknown groups", async () => {
    expect((await call(group.GET, { params: { id: "00000000-0000-0000-0000-000000000000" } })).status).toBe(404);
  });

  it("shows memberships on the user resource", async () => {
    const ada = await mkUser("ada@example.com");
    const g = await mkGroup("Engineering", [ada]);
    const res = await call(user.GET, { params: { id: ada } });
    expect(res.body.groups).toEqual([{ value: g.id, display: "Engineering" }]);
  });
});

describe("PATCH /Groups/:id members", () => {
  it("adds members idempotently (Okta and Entra send the same add shape)", async () => {
    const ada = await mkUser("ada@example.com");
    const g = await mkGroup("Engineering");
    const add = { op: "add", path: "members", value: [{ value: ada, display: "ada@example.com" }] };
    expect((await doPatch(g.id, add)).status).toBe(204);
    expect((await doPatch(g.id, add)).status).toBe(204); // retry is a no-op
    expect(await memberIds(g.id)).toEqual([ada]);
  });

  it("removes a member with Okta's filter path", async () => {
    const [ada, bob] = [await mkUser("ada@example.com"), await mkUser("bob@example.com")];
    const g = await mkGroup("Engineering", [ada, bob]);
    await doPatch(g.id, { op: "remove", path: `members[value eq "${ada}"]` });
    expect(await memberIds(g.id)).toEqual([bob]);
  });

  it("removes a member with Entra's value-array shape, and tolerates removing a non-member", async () => {
    const [ada, bob] = [await mkUser("ada@example.com"), await mkUser("bob@example.com")];
    const g = await mkGroup("Engineering", [ada, bob]);
    const remove = { op: "Remove", path: "members", value: [{ value: bob }] };
    expect((await doPatch(g.id, remove)).status).toBe(204);
    expect((await doPatch(g.id, remove)).status).toBe(204);
    expect(await memberIds(g.id)).toEqual([ada]);
  });

  it("replaces all members, and ignores ids that aren't users", async () => {
    const [ada, bob] = [await mkUser("ada@example.com"), await mkUser("bob@example.com")];
    const g = await mkGroup("Engineering", [ada]);
    await doPatch(g.id, { op: "replace", path: "members", value: [{ value: bob }, { value: "00000000-0000-0000-0000-000000000000" }] });
    expect(await memberIds(g.id)).toEqual([bob]);
  });

  it("renames with Okta's no-path value object", async () => {
    const g = await mkGroup("Engineering");
    await doPatch(g.id, { op: "replace", value: { id: g.id, displayName: "Platform Engineering" } });
    const res = await call(group.GET, { params: { id: g.id } });
    expect(res.body.displayName).toBe("Platform Engineering");
    expect(res.body.meta.version).toBe('W/"2"');
  });

  it("rejects unsupported paths and unknown groups", async () => {
    const g = await mkGroup("Engineering");
    expect((await doPatch(g.id, { op: "replace", path: "owner", value: "x" })).body.scimType).toBe("invalidPath");
    expect((await doPatch("00000000-0000-0000-0000-000000000000", { op: "add", path: "members", value: [] })).status).toBe(404);
  });
});

describe("PUT /Groups/:id", () => {
  it("replaces name and membership", async () => {
    const [ada, bob] = [await mkUser("ada@example.com"), await mkUser("bob@example.com")];
    const g = await mkGroup("Engineering", [ada]);
    const res = await call(group.PUT, { method: "PUT", params: { id: g.id }, body: { displayName: "Eng", members: [{ value: bob }] } });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Eng");
    expect(res.body.members.map((m: { value: string }) => m.value)).toEqual([bob]);
  });
});

describe("DELETE /Groups/:id", () => {
  it("deletes the group and its memberships but not the users", async () => {
    const ada = await mkUser("ada@example.com");
    const g = await mkGroup("Engineering", [ada]);
    expect((await call(group.DELETE, { method: "DELETE", params: { id: g.id } })).status).toBe(204);
    expect((await call(group.DELETE, { method: "DELETE", params: { id: g.id } })).status).toBe(404);
    const u = await call(user.GET, { params: { id: ada } });
    expect(u.status).toBe(200);
    expect(u.body.groups).toEqual([]);
  });

  it("deleting a user removes them from groups", async () => {
    const ada = await mkUser("ada@example.com");
    const g = await mkGroup("Engineering", [ada]);
    await call(user.DELETE, { method: "DELETE", params: { id: ada } });
    expect(await memberIds(g.id)).toEqual([]);
  });
});
