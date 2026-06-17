#!/usr/bin/env node
// Verify that an installed `kimi` CLI still exposes the command surface this
// plugin depends on, by parsing `kimi --help` / `kimi <subcommand> --help`.
//
// Usage:
//   node plugins/kimi/scripts/check-cli-contract.mjs
//
// Exit codes:
//   0  contract satisfied
//   1  contract violated (a required subcommand/flag is missing)
//   2  `kimi` binary not found on PATH
//
// This is the entry point used by the kimi-cli-compat CI workflow. It is the
// real-binary counterpart to tests/cli-contract.test.mjs, and shares the same
// manifest (REQUIRED_COMMANDS) so there is a single source of truth.

import process from "node:process";

import { runCommand } from "./lib/process.mjs";
import {
  REQUIRED_COMMANDS,
  verifyContract,
  formatContractReport
} from "./lib/cli-contract.mjs";

function kimiOnPath() {
  const result = runCommand("kimi", ["--version"]);
  if (result.error && result.error.code === "ENOENT") {
    return false;
  }
  // Even a non-zero exit means the binary exists; only ENOENT means missing.
  return !(result.error && result.error.code === "ENOENT");
}

/**
 * Fetch help text from the real `kimi` binary. Returns combined stdout+stderr
 * because some CLIs emit help on stderr. Returns "" if the command errored
 * (other than producing help).
 */
function fetchRealHelp(argv) {
  const result = runCommand("kimi", argv, { maxBuffer: 10 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function main() {
  if (!kimiOnPath()) {
    process.stderr.write(
      "kimi binary not found on PATH; cannot run real contract check.\n"
    );
    process.exitCode = 2;
    return;
  }

  const version = (() => {
    const result = runCommand("kimi", ["--version"]);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || "unknown";
  })();

  const verification = verifyContract(fetchRealHelp, { manifest: REQUIRED_COMMANDS });
  process.stdout.write(`${formatContractReport(verification, `kimi CLI contract (kimi ${version})`)}\n`);

  if (!verification.ok) {
    process.stderr.write(
      "\nERROR: installed kimi-cli is missing command surface the plugin depends on.\n"
    );
    process.exitCode = 1;
  }
}

main();
