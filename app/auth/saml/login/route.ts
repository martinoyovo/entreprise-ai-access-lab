import { loginUrl } from "@/lib/auth/saml";

// SP-initiated login: build an AuthnRequest and redirect the browser to Okta with it.
// The request ID is stored so the response can be tied back to it (see saml_requests).
export async function GET(req: Request) {
  const returnTo = new URL(req.url).searchParams.get("returnTo") ?? "/";
  return Response.redirect(await loginUrl(returnTo), 302);
}
