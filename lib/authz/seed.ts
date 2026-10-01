import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db";

/**
 * Seeds the default roles once. Seeding only an empty table means roles an admin
 * later edits or deletes aren't silently restored on the next deploy.
 */
export async function seedIfEmpty(): Promise<boolean> {
  const { rows } = await pool.query("select count(*)::int as n from roles");
  if (rows[0].n > 0) return false;
  await pool.query(readFileSync(join(process.cwd(), "db/seed.sql"), "utf8"));
  return true;
}
