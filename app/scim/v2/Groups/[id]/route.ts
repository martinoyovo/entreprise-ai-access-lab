import { baseUrl, readJson, scimActor, scimJson, withScim } from "@/lib/scim/http";
import { excludes } from "@/lib/scim/query";
import { deleteGroup, getGroup, patchGroup, replaceGroup } from "@/lib/scim/groups";

export const GET = withScim(async (req, { id }) => {
  const group = await getGroup(id, baseUrl(req), !excludes(new URL(req.url), "members"));
  return scimJson(group, 200, { ETag: group.meta.version });
});

export const PUT = withScim(async (req, { id }) => scimJson(await replaceGroup(id, await readJson(req), baseUrl(req), scimActor(req))));

// 204 for group PATCH: echoing a group with thousands of members back on every
// membership change is wasteful, and both Okta and Entra accept 204.
export const PATCH = withScim(async (req, { id }) => {
  await patchGroup(id, await readJson(req), scimActor(req));
  return new Response(null, { status: 204 });
});

export const DELETE = withScim(async (req, { id }) => {
  await deleteGroup(id, scimActor(req));
  return new Response(null, { status: 204 });
});
