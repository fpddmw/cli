import { runCli } from "./cli.js";

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
