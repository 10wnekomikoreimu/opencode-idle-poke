import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const testDir = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  test: {
    root: testDir,
    setupFiles: ["./setup.ts"],
    include: ["*.test.ts"],
    environment: "node",
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
})
