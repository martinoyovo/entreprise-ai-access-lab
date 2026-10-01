import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  // pg uses Node APIs; keep it out of the bundler.
  serverExternalPackages: ["pg"],
  // The repo root holds another project's lockfile; tell Next this folder is the app root.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};
export default config;
