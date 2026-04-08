/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/__tests__/**",
    "!src/index.ts",
    "!src/cli.ts",
    "!src/login.ts",
    "!src/frontend/**",
    "!src/backend/**",
  ],
  reporters: ["clear-text", "html", "json"],
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 30000,
  concurrency: 4,
};
