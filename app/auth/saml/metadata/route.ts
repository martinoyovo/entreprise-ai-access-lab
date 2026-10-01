import { metadata } from "@/lib/auth/saml";

// SP metadata (entity ID + ACS URL). Handy when configuring the Okta app.
export async function GET() {
  return new Response(metadata(), { headers: { "Content-Type": "application/samlmetadata+xml" } });
}
