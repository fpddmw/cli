const { spawnSync } = require("node:child_process");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const c8Bin = require.resolve("c8/bin/c8.js");
const result = spawnSync(
  process.execPath,
  [
    c8Bin,
    "--all",
    "--src",
    "src",
    "--include",
    "src/**",
    "--exclude-after-remap",
    "--reporter=text",
    "--reporter=text-summary",
    "--reporter=json-summary",
    "--report-dir",
    "coverage",
    "--check-coverage",
    "--lines=30",
    "--statements=30",
    "--functions=29",
    "--branches=60",
    process.execPath,
    "--import",
    "tsx",
    "--test",
    "test/*.test.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TIANGONG_AI_CLI_COVERAGE: "1",
    },
  },
);

if (result.error) {
  fail(`Failed to execute coverage run: ${result.error.message}`);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.signal) {
  fail(`Coverage run terminated with signal ${result.signal}.`);
}

fail("Coverage run failed without an exit status.");
