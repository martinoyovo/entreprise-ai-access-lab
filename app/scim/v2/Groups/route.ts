import { baseUrl, readJson, scimActor, scimJson, withScim } from "@/lib/scim/http";
import { createGroup, listGroups } from "@/lib/scim/groups";

export const GET = withScim(async (req) => scimJson(await listGroups(new URL(req.url), baseUrl(req))));

export const POST = withScim(async (req) => {
  const group = await createGroup(await readJson(req), baseUrl(req), scimActor(req));
  return scimJson(group, 201, { Location: group.meta.location });
});
