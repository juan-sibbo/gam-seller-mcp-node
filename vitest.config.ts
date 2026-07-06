import { defineConfig } from "vitest/config"; // vitest 2.x — compatible Node 18 LTS

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
