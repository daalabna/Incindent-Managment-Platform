import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1100 },
  },
  webServer: [
    {
      command: "npm start",
      url: "http://127.0.0.1:4001/api/health",
      reuseExistingServer: false,
      env: {
        PORT: "4001",
        SENTINEL_MODE:
          process.env.E2E_DISTRIBUTED === "true" ? "distributed" : "local",
        // Required when SENTINEL_MODE=local — production path rejects SQLite without it.
        ALLOW_SQLITE: "true",
        DATABASE_PATH: ":memory:",
        SIMULATION_TICK_MS: "250",
      },
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      env: { VITE_PORT: "5174", SENTINEL_API_PORT: "4001" },
    },
  ],
});
