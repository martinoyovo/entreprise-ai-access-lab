// Fake data standing in for GitHub and a CRM. The point of this project is the access
// control around the tools, not the integrations themselves.

const ISSUES = [
  { repo: "acme/api", number: 412, title: "SSO login loops when SAML clock skew > 30s", state: "open", labels: ["auth", "bug"] },
  { repo: "acme/api", number: 398, title: "Rate limit SCIM /Users list endpoint", state: "closed", labels: ["scim"] },
  { repo: "acme/api", number: 377, title: "Audit log export to S3", state: "open", labels: ["audit", "feature"] },
  { repo: "acme/web", number: 88, title: "Dark mode for chat transcript", state: "open", labels: ["ui"] },
];

const PULLS: Record<string, { title: string; author: string; state: string; files: string[] }> = {
  "acme/api#415": { title: "Tolerate 60s clock skew in SAML validation", author: "ada", state: "open", files: ["lib/auth/saml.ts", "tests/auth.test.ts"] },
  "acme/web#90": { title: "Chat transcript dark mode", author: "grace", state: "merged", files: ["app/chat.tsx"] },
};

const ACCOUNTS = [
  { name: "Globex", tier: "Enterprise", arr: 480_000, owner: "sam@acme.test", renewal: "2027-02-01" },
  { name: "Initech", tier: "Growth", arr: 96_000, owner: "lee@acme.test", renewal: "2026-12-15" },
  { name: "Umbrella Health", tier: "Enterprise", arr: 720_000, owner: "sam@acme.test", renewal: "2027-06-30" },
];

const OPPORTUNITIES = [
  { account: "Globex", name: "Add 200 seats", stage: "Negotiation", amount: 120_000 },
  { account: "Initech", name: "Upgrade to Enterprise", stage: "Discovery", amount: 150_000 },
  { account: "Umbrella Health", name: "EU data residency add-on", stage: "Proposal", amount: 90_000 },
];

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

export const githubSearchIssues = (repo: string, query: string) =>
  ISSUES.filter((i) => i.repo === repo && (has(i.title, query) || i.labels.some((l) => has(l, query))));

export const githubGetPullRequest = (repo: string, number: number) =>
  PULLS[`${repo}#${number}`] ?? { error: `No pull request ${repo}#${number}` };

export const crmLookupAccount = (name: string) =>
  ACCOUNTS.find((a) => has(a.name, name)) ?? { error: `No account matching "${name}"` };

export const crmListOpportunities = (account: string) =>
  OPPORTUNITIES.filter((o) => !account || has(o.account, account));
