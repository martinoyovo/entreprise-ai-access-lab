import { describe, expect, it } from "vitest";
import * as spc from "@/app/scim/v2/ServiceProviderConfig/route";
import * as schemas from "@/app/scim/v2/Schemas/route";
import * as types from "@/app/scim/v2/ResourceTypes/route";
import { call } from "./helpers";

describe("discovery endpoints", () => {
  it("serves ServiceProviderConfig without a token", async () => {
    const res = await call(spc.GET, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/scim+json");
    expect(res.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true } });
  });

  it("serves User and Group schemas", async () => {
    const res = await call(schemas.GET);
    expect(res.body.Resources.map((s: { id: string }) => s.id)).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
      "urn:ietf:params:scim:schemas:core:2.0:Group",
    ]);
  });

  it("serves ResourceTypes", async () => {
    const res = await call(types.GET);
    expect(res.body.Resources.map((r: { endpoint: string }) => r.endpoint)).toEqual(["/Users", "/Groups"]);
  });
});
