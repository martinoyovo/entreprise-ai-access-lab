// A tiny stand-in for Okta, used only in tests: it reads our AuthnRequest and returns a
// signed SAMLResponse. Signing uses xml-crypto directly; the app itself never does.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
export const IDP = { key: fixture("idp.key"), cert: fixture("idp.crt") };
export const ATTACKER = { key: fixture("attacker.key"), cert: fixture("attacker.crt") };

const ACS = "https://lab.example.com/auth/saml/acs";
const AUDIENCE = "https://lab.example.com/auth/saml/metadata";

/** Pulls the AuthnRequest ID out of the redirect URL our /auth/saml/login produced. */
export function requestIdFrom(location: string): string {
  const xml = inflateRawSync(Buffer.from(new URL(location).searchParams.get("SAMLRequest")!, "base64")).toString();
  return /ID="([^"]+)"/.exec(xml)![1];
}

type Opts = {
  email: string;
  groups?: string[];
  inResponseTo?: string | null;
  signWith?: { key: string; cert: string } | null;
  notOnOrAfter?: Date;
  audience?: string;
  tamper?: (xml: string) => string;
  acs?: string;
};

export function samlResponse({ email, groups = [], inResponseTo, signWith = IDP, notOnOrAfter, audience = AUDIENCE, tamper, acs = ACS }: Opts): string {
  const now = new Date();
  const until = (notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const irt = inResponseTo ? ` InResponseTo="${inResponseTo}"` : "";
  const id = () => "_" + Math.random().toString(16).slice(2);
  const values = (vs: string[]) => vs.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("");

  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${acs}"${irt}>` +
    `<saml:Issuer>http://www.okta.com/test</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${id()}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>http://www.okta.com/test</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${until}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email">${values([email])}</saml:Attribute>` +
    (groups.length ? `<saml:Attribute Name="groups">${values(groups)}</saml:Attribute>` : "") +
    `</saml:AttributeStatement></saml:Assertion></samlp:Response>`;

  if (signWith) {
    const sig = new SignedXml({
      privateKey: signWith.key,
      publicCert: signWith.cert,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(xml, {
      location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" },
    });
    xml = sig.getSignedXml();
  }
  return Buffer.from(tamper ? tamper(xml) : xml).toString("base64");
}
