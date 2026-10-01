import "dotenv/config";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach } from "vitest";

// Point the app at the throwaway test database before lib/db creates its pool.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://lab:lab@localhost:5432/access_lab_test";
process.env.SCIM_BEARER_TOKEN = "test-token";
process.env.APP_BASE_URL = "https://lab.example.com";
process.env.SAML_SP_ENTITY_ID = "https://lab.example.com/auth/saml/metadata";
process.env.SAML_ENTRY_POINT = "https://idp.example.com/sso/saml";
process.env.SAML_IDP_CERT = readFileSync(new URL("./fixtures/idp.crt", import.meta.url), "utf8");

const { pool } = await import("../lib/db");
const { seedIfEmpty } = await import("../lib/authz/seed");

beforeAll(async () => {
  await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("truncate users, groups, group_members, sessions, saml_requests, roles, role_capabilities, group_role_mappings cascade");
  // The audit log refuses TRUNCATE; the test database lifts that guard just for cleanup.
  await pool.query("alter table audit_log disable trigger audit_log_no_truncate; truncate audit_log; alter table audit_log enable trigger audit_log_no_truncate");
  await seedIfEmpty();
});
afterAll(async () => {
  await pool.end();
  delete (globalThis as { pgPool?: unknown }).pgPool;
});
