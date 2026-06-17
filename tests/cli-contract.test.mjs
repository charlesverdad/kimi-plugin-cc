import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_COMMANDS,
  verifyContract,
  tokenizeHelp,
  formatContractReport
} from "../plugins/kimi/scripts/lib/cli-contract.mjs";
import { runCommand } from "../plugins/kimi/scripts/lib/process.mjs";

// A fake `kimi --help` fixture that mirrors the documented kimi-cli command
// surface (subcommands + global run flags). This lets the contract test run
// fully offline in CI without kimi installed. Keep this representative of real
// `kimi --help` output, including the alias spellings kimi-cli prints.
const FAKE_TOP_LEVEL_HELP = `
Usage: kimi [OPTIONS] COMMAND [ARGS]...

  Kimi CLI - agentic coding in your terminal.

Options:
  -V, --version             Show version number and exit
  -m, --model TEXT          Specify LLM model
  --thinking / --no-thinking
                            Enable or disable thinking mode
  -C, --continue            Continue the previous session
  -p, --print               Run in print mode (non-interactive)
  --quiet                   Shortcut for --print --output-format text --final-message-only
  -y, --yolo                Auto-approve all tool calls
  --help                    Show this message and exit.

Commands:
  acp      Start a multi-session ACP server.
  export   Export a session as a ZIP archive.
  info     Display version and protocol information.
  login    Authenticate to your Kimi account.
  logout   Deauthenticate from your Kimi account.
  mcp      Manage MCP server configurations.
  plugin   Manage plugins (Beta).
  term     Launch the Toad terminal UI.
  vis      Launch the Agent Tracing Visualizer.
  web      Start the Web UI server.
`;

const FAKE_LOGIN_HELP = `
Usage: kimi login [OPTIONS]

  Authenticate to your Kimi account.

Options:
  --help  Show this message and exit.
`;

function fakeFetchHelp(argv) {
  if (argv[0] === "login") {
    return FAKE_LOGIN_HELP;
  }
  // ["--help"] (top level)
  return FAKE_TOP_LEVEL_HELP;
}

test("manifest covers exactly the kimi surface the companion uses", () => {
  // Guard against silent drift: the companion relies on these tokens.
  const topLevel = REQUIRED_COMMANDS.find((g) => g.id === "top-level");
  const tokens = new Set(topLevel.requires.map((r) => r.token));
  for (const expected of [
    "--version",
    "info",
    "login",
    "--quiet",
    "--yolo",
    "--model",
    "--thinking",
    "--continue",
    "-p"
  ]) {
    assert.ok(tokens.has(expected), `manifest must require ${expected}`);
  }
});

test("verifyContract passes against a faithful fake kimi --help fixture", () => {
  const verification = verifyContract(fakeFetchHelp);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "fake kimi contract")
  );
  assert.deepEqual(verification.missing, []);
});

test("verifyContract accepts alias spellings (e.g. --print for -p)", () => {
  // kimi prints `-p, --print`; tokenizer captures both, so -p is satisfied.
  const tokens = tokenizeHelp(FAKE_TOP_LEVEL_HELP);
  assert.ok(tokens.has("-p"));
  assert.ok(tokens.has("--print"));
  assert.ok(tokens.has("--version"));
  assert.ok(tokens.has("--continue"));
});

test("verifyContract fails loudly when a required flag is dropped", () => {
  // Simulate a future kimi-cli that removed --yolo.
  const helpWithoutYolo = FAKE_TOP_LEVEL_HELP.replace(
    /^\s*-y, --yolo.*$/m,
    ""
  );
  const fetch = (argv) =>
    argv[0] === "login" ? FAKE_LOGIN_HELP : helpWithoutYolo;
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(
    verification.missing.some((m) => m.token === "--yolo"),
    "missing list should call out --yolo"
  );
});

test("verifyContract fails loudly when a required subcommand is dropped", () => {
  const helpWithoutInfo = FAKE_TOP_LEVEL_HELP.replace(
    /^\s*info\s+Display.*$/m,
    ""
  );
  const fetch = (argv) =>
    argv[0] === "login" ? FAKE_LOGIN_HELP : helpWithoutInfo;
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.some((m) => m.token === "info"));
});

test("verifyContract reports a fetch failure as missing, not a crash", () => {
  const fetch = () => {
    throw new Error("boom");
  };
  const verification = verifyContract(fetch);
  assert.equal(verification.ok, false);
  assert.ok(verification.missing.every((m) => /help fetch failed/.test(m.reason)));
});

// Optional real-binary check: if `kimi` is installed on PATH, verify the live
// command surface too. Skips gracefully (does NOT fail) when kimi is absent,
// so `npm test` works in CI without kimi installed.
test("real kimi CLI satisfies the contract (skipped if kimi absent)", (t) => {
  const probe = runCommand("kimi", ["--version"]);
  const kimiMissing = probe.error && probe.error.code === "ENOENT";
  if (kimiMissing) {
    t.skip("kimi binary not found on PATH");
    return;
  }

  const fetchRealHelp = (argv) => {
    const result = runCommand("kimi", argv, { maxBuffer: 10 * 1024 * 1024 });
    if (result.error) {
      throw result.error;
    }
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  };

  const verification = verifyContract(fetchRealHelp);
  assert.equal(
    verification.ok,
    true,
    formatContractReport(verification, "real kimi contract")
  );
});
