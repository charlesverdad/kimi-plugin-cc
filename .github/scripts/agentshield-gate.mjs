#!/usr/bin/env node
// Reads an AgentShield JSON report and fails (exit 1) if any finding is at or
// above the given minimum severity. LOW/INFO findings are reported but never
// fail the build — AgentShield emits LOW "self-improving skill" advisories that
// do not apply to plain Claude Code slash commands.
//
// Usage: node agentshield-gate.mjs <report.json> [min-severity]

import { readFileSync } from "node:fs";

const [reportPath, minSeverity = "medium"] = process.argv.slice(2);

if (!reportPath) {
  console.error("usage: agentshield-gate.mjs <report.json> [min-severity]");
  process.exit(2);
}

const RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const threshold = RANK[minSeverity];

if (threshold === undefined) {
  console.error(`unknown severity "${minSeverity}" (expected one of ${Object.keys(RANK).join(", ")})`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`could not read/parse ${reportPath}: ${error.message}`);
  process.exit(2);
}

const findings = Array.isArray(report.findings) ? report.findings : [];

const counts = {};
for (const finding of findings) {
  const severity = String(finding.severity ?? "info").toLowerCase();
  counts[severity] = (counts[severity] ?? 0) + 1;
}

const order = ["critical", "high", "medium", "low", "info"];
const summary = order
  .filter((severity) => counts[severity])
  .map((severity) => `${counts[severity]} ${severity}`)
  .join(", ");
console.log(`AgentShield: ${findings.length} finding(s)${summary ? ` — ${summary}` : ""}`);

const blocking = findings.filter(
  (finding) => (RANK[String(finding.severity ?? "info").toLowerCase()] ?? 0) >= threshold,
);

if (blocking.length === 0) {
  console.log(`No findings at or above "${minSeverity}". Gate passed.`);
  process.exit(0);
}

console.error(`\nFound ${blocking.length} finding(s) at or above "${minSeverity}":`);
for (const finding of blocking) {
  console.error(`  [${String(finding.severity).toUpperCase()}] ${finding.file ?? "?"}: ${finding.title ?? finding.id ?? ""}`);
}
process.exit(1);
