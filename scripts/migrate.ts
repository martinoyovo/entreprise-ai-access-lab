import "dotenv/config";
import { readFileSync } from "node:fs";
import { pool } from "../lib/db";
import { seedIfEmpty } from "../lib/authz/seed";

// No migration framework: the schema is small and written to be re-runnable.
const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
await pool.query(sql);
console.log("schema applied");
if (await seedIfEmpty()) console.log("default roles seeded");
await pool.end();
