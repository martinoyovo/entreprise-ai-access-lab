import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { pool } from "../db";

// All SAML parsing and XML signature checks are done by @node-saml/node-saml.
// This file only wires it to our config and our Postgres request-ID store.

const REQUEST_TTL_MS = 5 * 60_000; // how long a user has to finish logging in at Okta

/** Postgres-backed store for AuthnRequest IDs, so InResponseTo checks work across restarts and instances. */
const requestStore: CacheProvider = {
  async saveAsync(key, value) {
    await pool.query("insert into saml_requests (id) values ($1) on conflict do nothing", [key]);
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    const { rows } = await pool.query(
      "select created_at from saml_requests where id = $1 and created_at > now() - make_interval(secs => $2)",
      [key, REQUEST_TTL_MS / 1000],
    );
    return rows[0] ? rows[0].created_at.toISOString() : null;
  },
  async removeAsync(key) {
    if (key === null) {
      await pool.query("delete from saml_requests where created_at < now() - make_interval(secs => $1)", [REQUEST_TTL_MS / 1000]);
      return null;
    }
    const { rows } = await pool.query("delete from saml_requests where id = $1 returning id", [key]);
    return rows[0]?.id ?? null;
  },
};

export const appBaseUrl = () => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const acsUrl = () => `${appBaseUrl()}/auth/saml/acs`;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

let saml: SAML | undefined;
function client(): SAML {
  saml ??= new SAML({
    entryPoint: required("SAML_ENTRY_POINT"), // Okta: "Identity Provider Single Sign-On URL"
    issuer: required("SAML_SP_ENTITY_ID"), // our entity ID; Okta: "Audience URI (SP Entity ID)"
    audience: required("SAML_SP_ENTITY_ID"), // reject assertions minted for other apps
    callbackUrl: acsUrl(),
    // .env files can't hold multi-line values easily, so allow "\n" escapes in the PEM.
    idpCert: required("SAML_IDP_CERT").replace(/\\n/g, "\n"),
    // Okta signs the assertion by default. Requiring that signature is what makes the email
    // and groups trustworthy; an unsigned or tampered assertion is rejected.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: "sha256",
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    validateInResponseTo: ValidateInResponseTo.always, // SP-initiated only
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: requestStore,
    acceptedClockSkewMs: 30_000, // tolerate small clock drift between Okta and us
  });
  return saml;
}

/** Only same-site paths may be used after login, otherwise RelayState is an open redirect. */
export function safeReturnTo(v: unknown): string {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : "/";
}

export function loginUrl(returnTo: string): Promise<string> {
  return client().getAuthorizeUrlAsync(safeReturnTo(returnTo), undefined, {});
}

export function metadata(): string {
  return client().generateServiceProviderMetadata(null, null);
}

function firstString(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

export type SamlLogin = { email: string; groups: string[]; sessionIndex: string | null };

/** Validates a POSTed SAMLResponse. Throws if the signature, audience, timing or InResponseTo is wrong. */
export async function validateResponse(samlResponse: string): Promise<SamlLogin> {
  const { profile } = await client().validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new Error("SAML response contained no assertion");
  return readProfile(profile);
}

function readProfile(profile: Profile): SamlLogin {
  const emailAttr = process.env.SAML_EMAIL_ATTRIBUTE ?? "email";
  const groupsAttr = process.env.SAML_GROUPS_ATTRIBUTE ?? "groups";
  // Prefer the explicit email attribute; fall back to an email-format NameID.
  const email = firstString(profile[emailAttr]) ?? (profile.nameID?.includes("@") ? profile.nameID : null);
  if (!email) throw new Error(`SAML assertion has no "${emailAttr}" attribute or email NameID`);
  const raw = profile[groupsAttr];
  const groups = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((g): g is string => typeof g === "string");
  return { email: email.toLowerCase(), groups, sessionIndex: profile.sessionIndex ?? null };
}
