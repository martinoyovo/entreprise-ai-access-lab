import { baseUrl, readJson, scimActor, scimJson, withScim } from "@/lib/scim/http";
import { deleteUser, getUser, patchUser, replaceUser } from "@/lib/scim/users";

export const GET = withScim(async (req, { id }) => {
  const user = await getUser(id, baseUrl(req));
  return scimJson(user, 200, { ETag: user.meta.version });
});

export const PUT = withScim(async (req, { id }) => scimJson(await replaceUser(id, await readJson(req), baseUrl(req), scimActor(req))));

// Returning the updated user (200) rather than 204 lets the IdP confirm the result.
export const PATCH = withScim(async (req, { id }) => scimJson(await patchUser(id, await readJson(req), baseUrl(req), scimActor(req))));

export const DELETE = withScim(async (req, { id }) => {
  await deleteUser(id, scimActor(req));
  return new Response(null, { status: 204 });
});
