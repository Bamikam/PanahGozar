import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests self-skip cleanly without a live DATABASE_URL.
    environment: "node",
    globals: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
