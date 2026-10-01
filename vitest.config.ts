import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false, // all test files share one database
  },
});
