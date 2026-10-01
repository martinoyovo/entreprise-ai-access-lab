import { baseUrl, readJson, scimActor, scimJson, withScim } from "@/lib/scim/http";
import { createUser, listUsers } from "@/lib/scim/users";

export const GET = withScim(async (req) => scimJson(await listUsers(new URL(req.url), baseUrl(req))));

export const POST = withScim(async (req) => {
  const user = await createUser(await readJson(req), baseUrl(req), scimActor(req));
  return scimJson(user, 201, { Location: user.meta.location });
});
