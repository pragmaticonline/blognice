/**
 * Mutation testing with Stryker.
 *
 * The suite runs under node:test via tsx, which has no dedicated Stryker test
 * runner, so the built-in command runner executes a shell command per mutant.
 * A full `npm test` per mutant is ~90s, so broad runs must be scoped:
 *
 *   STRYKER_MUTATE=src/tts.ts STRYKER_TEST_COMMAND="npx tsx --test test/tts.test.mjs" npm run test:mutation
 *
 * Unscoped `npm run test:mutation` mutates all of src/ and re-runs the whole
 * suite per mutant; reserve that for scheduled (non-blocking) runs.
 */
const mutate = process.env.STRYKER_MUTATE
  ? process.env.STRYKER_MUTATE.split(",").map((entry) => entry.trim()).filter(Boolean)
  : ["src/**/*.ts"];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate,
  testRunner: "command",
  commandRunner: {
    command: process.env.STRYKER_TEST_COMMAND ?? "npm test",
  },
  reporters: ["progress", "clear-text", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  coverageAnalysis: "all",
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60_000,
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp", ".wrangler", "dist", "build"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
