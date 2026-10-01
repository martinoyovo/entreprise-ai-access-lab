import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/auth/saml";
import { audit, userActor } from "@/lib/audit";
import { clientIp } from "@/lib/auth/http";
import { SESSION_COOKIE, getSessionUser, revokeSession, tokenFromRequest } from "@/lib/auth/session";
import { pool } from "@/lib/db";

// Local logout: revoke the server-side session, then clear the cookie. Clearing the cookie
// alone wouldn't be enough, since a copied cookie would still work until it expired.
// POST-only so a cross-site <img src="/auth/logout"> can't log people out.
export async function POST(req: Request) {
  const token = tokenFromRequest(req);
  const session = await getSessionUser(token);
  if (token) await revokeSession(token);
  if (session) await audit(pool, userActor(session.user.email, clientIp(req)), "auth.logout", `user:${session.user.id}`);
  const res = NextResponse.redirect(`${appBaseUrl()}/`, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
