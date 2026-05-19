import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      // ── Excludes ──────────────────────────────────────────────────────
      // Test files, integration scaffolding, and entry points are noise
      // for the coverage gate — they're either tests themselves or
      // glue that's verified by integration tests rather than unit ones.
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/index.ts",
        "src/cli.ts",
        "src/login.ts",
        "src/setup.ts",
        "src/bootstrap.ts",
        // Kilo/OpenCode process-entry handlers are covered by the dedicated
        // integration and backend-live CI tiers. Keep unit coverage focused on
        // parser/session/server logic where isolated tests give useful signal.
        "src/backend/kilo/handler.ts",
        "src/backend/kilo/one-shot.ts",
        "src/backend/opencode/handler.ts",
        "src/backend/opencode/one-shot.ts",
        "**/*.d.ts",
        "**/dist/**",
      ],
      // ── Global thresholds ─────────────────────────────────────────────
      // Catches "tests dropped on critical code" without being so tight
      // that minor refactors break CI. Tightened over time as the suite
      // grows. Each ratchet should bump in increments of ~5%.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
