import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The source uses `.js`-suffixed import specifiers that point at `.ts`
    // files (NodeNext/bundler style). Ensure vitest resolves them.
    extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
