import { scimJson, withScim } from "@/lib/scim/http";
import { schemas } from "@/lib/scim/discovery";

// Discovery documents contain no user data, so no bearer token is required (RFC 7644 §4).
export const GET = withScim(async () => scimJson(schemas), { auth: false });
