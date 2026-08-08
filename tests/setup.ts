import { vi } from "vitest"
import { testConfigDir } from "./helpers"

vi.stubEnv("OPENCODE_CONFIG_DIR", testConfigDir)
