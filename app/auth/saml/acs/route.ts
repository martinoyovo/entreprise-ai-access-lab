import { NextResponse } from "next/server";
import { audit, userActor } from "@/lib/audit";
import { pool } from "@/lib/db";
import { authError, clientIp } from "@/lib/auth/http";
import { appBaseUrl, safeReturnTo, validateResponse, type SamlLogin } from "@/lib/auth/saml";
import { createSession, sessionCookie } from "@/lib/auth/session";

// Assertion Consumer Service: Okta POSTs the signed SAMLResponse here.
export async function POST(req: Request) {
  const form = await req.formData();
  const samlResponse = form.get("SAMLResponse");
  if (typeof samlResponse !== "string") return authError(400, "Missing SAMLResponse.");
  const ip = clientIp(req);

  let login: SamlLogin;
  try {
    login = await validateResponse(samlResponse);
  } catch (e) {
    console.warn("SAML response rejected:", (e as Error).message);
    // We can't trust any identity in a response that failed validation, so the actor is anonymous.
    await audit(pool, { actor: "anonymous", ip }, "auth.login_failed", null, { reason: (e as Error).message });
    return authError(401, "The identity provider's response could not be verified.");
  }

  // No just-in-time provisioning: SCIM is the only way into the users table, so the IdP
  // stays the single source of truth for who has access. Match on the same email field.
  const { rows } = await pool.query("select id from users where lower(email) = $1 and active", [login.email]);
  if (!rows[0]) {
    console.warn(`SAML login for unprovisioned or inactive user ${login.email}`);
    await audit(pool, userActor(login.email, ip), "auth.login_failed", null, { reason: "not provisioned or inactive" });
    return authError(403, "Your account isn't provisioned for this app. Ask your administrator to assign it in Okta.");
  }

  const { token, expiresAt } = await createSession({
    userId: rows[0].id,
    idpGroups: login.groups,
    sessionIndex: login.sessionIndex,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  await audit(pool, userActor(login.email, ip), "auth.login", `user:${rows[0].id}`, { idpGroups: login.groups, expiresAt });
  // 303 turns the POST into a GET on the target page.
  const res = NextResponse.redirect(`${appBaseUrl()}${safeReturnTo(form.get("RelayState"))}`, 303);
  res.cookies.set(sessionCookie(token, expiresAt));
  return res;
}
