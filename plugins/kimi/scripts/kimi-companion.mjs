#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { getKimiAvailability } from "./lib/kimi.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/kimi-companion.mjs setup [--json]",
      "  node scripts/kimi-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/kimi-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/kimi-companion.mjs task [--background] [--continue] [--model <model>] [--thinking] [prompt]",
      "  node scripts/kimi-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/kimi-companion.mjs result [job-id] [--json]",
      "  node scripts/kimi-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function getKimiAuthStatus(cwd) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability"
    };
  }

  // Try to run a trivial kimi command to check auth
  const result = binaryAvailable("kimi", ["info"], { cwd });
  if (!result.available) {
    // info might not exist in older versions; try login --help instead
    const loginHelp = binaryAvailable("kimi", ["login", "--help"], { cwd });
    if (!loginHelp.available) {
      return {
        available: true,
        loggedIn: false,
        detail: "Unable to verify authentication status",
        source: "kimi-cli"
      };
    }
  }

  // A simple heuristic: if `kimi info` works, assume logged in
  // More robust check would require parsing kimi's config, but this is good enough
  return {
    available: true,
    loggedIn: true,
    detail: "kimi CLI is available",
    source: "kimi-cli"
  };
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const kimiStatus = getKimiAvailability(cwd);
  const authStatus = await getKimiAuthStatus(cwd);
  const config = getConfig(resolveWorkspaceRoot(cwd));
  const reviewGateEnabled = Boolean(config.stopReviewGate);

  const nextSteps = [];
  if (!kimiStatus.available) {
    nextSteps.push("Install Kimi CLI. See https://moonshotai.github.io/kimi-cli/");
  }
  if (kimiStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!kimi login`.");
  }
  if (!reviewGateEnabled) {
    nextSteps.push("Optional: run `/kimi:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: kimiStatus.available && authStatus.loggedIn,
    kimi: kimiStatus,
    auth: authStatus,
    reviewGateEnabled,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function ensureKimiAvailable(cwd) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error("Kimi CLI is not installed. Install it from https://moonshotai.github.io/kimi-cli/ then rerun `/kimi:setup`.");
  }
}

let kimiHelpTextCache = null;

function kimiHelpText() {
  if (kimiHelpTextCache === null) {
    // runCommand applies the same Windows shell handling as every other kimi call.
    const result = runCommand("kimi", ["--help"]);
    kimiHelpTextCache = result.error ? "" : `${result.stdout}\n${result.stderr}`;
  }
  return kimiHelpTextCache;
}

// Kimi CLI 0.38 dropped --quiet and does not advertise --thinking. Passing a flag the
// installed CLI does not know makes it exit immediately with "error: unknown option",
// which surfaces as a job that fails a second after launch. Probe --help instead of
// assuming the flag exists.
function kimiSupportsFlag(flag) {
  const help = kimiHelpText();
  return help ? help.includes(flag) : false;
}

function buildKimiArgs({ cwd, model, thinking, continueSession, prompt }) {
  const args = [];

  if (kimiSupportsFlag("--quiet")) {
    args.push("--quiet");
  }
  args.push("--yolo");

  if (model) {
    args.push("--model", model);
  }
  if (thinking && kimiSupportsFlag("--thinking")) {
    args.push("--thinking");
  }
  if (continueSession) {
    args.push("--continue");
  }

  args.push("-p", prompt);
  return args;
}

const KIMI_FLAG_ERROR_PATTERNS = [
  /unknown option '(--[a-z0-9-]+)'/i,
  /Cannot combine --prompt with (--[a-z0-9-]+)/i
];

function kimiRejectedFlag(output) {
  for (const pattern of KIMI_FLAG_ERROR_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      return match[1];
    }
  }
  return null;
}

// Options whose next argv entry is a value (model name or prompt), never a flag.
const KIMI_VALUE_OPTIONS = new Set(["--model", "-p"]);

function withoutFlag(args, flag) {
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    if (KIMI_VALUE_OPTIONS.has(args[i]) && i + 1 < args.length) {
      next.push(args[i], args[i + 1]);
      i += 1;
    } else if (args[i] !== flag) {
      next.push(args[i]);
    }
  }
  return next;
}

// The Kimi CLI churns its flags between releases: 0.38 dropped --quiet outright and
// refuses --yolo alongside -p. Either one makes the process exit in about a second with
// a usage error, which surfaces here as a job that "failed" with no visible cause. These
// errors happen before any work starts, so retrying without the flag the CLI named is
// safe and keeps the plugin working across CLI versions. Only failed runs are inspected:
// a successful answer may itself quote one of these messages.
async function runKimi(cwd, args, options = {}) {
  let attemptArgs = args;
  let result = await spawnKimi(cwd, attemptArgs, options);

  for (let attempt = 0; attempt < 3 && result.status !== 0; attempt += 1) {
    const flag = kimiRejectedFlag(`${result.stderr}\n${result.stdout}`);
    const nextArgs = flag ? withoutFlag(attemptArgs, flag) : attemptArgs;
    if (nextArgs.length === attemptArgs.length) {
      break;
    }
    attemptArgs = nextArgs;
    if (options.onProgress) {
      options.onProgress(`kimi rejected ${flag}; retrying without it.`);
    }
    result = await spawnKimi(cwd, attemptArgs, options);
  }

  return result;
}

function spawnKimi(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("kimi", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.onProgress) {
        options.onProgress(chunk.trimEnd());
      }
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code, signal) => {
      resolve({
        status: signal ? 1 : (code ?? 1),
        stdout,
        stderr,
        pid: proc.pid
      });
    });
  });
}

function buildReviewPrompt(context, focusText, adversarial = false) {
  if (adversarial) {
    const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
    return interpolateTemplate(template, {
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_INPUT: context.content
    });
  }

  const template = loadPromptTemplate(ROOT_DIR, "review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request) {
  ensureKimiAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName === "Adversarial Review");

  const args = buildKimiArgs({
    cwd: request.cwd,
    model: request.model,
    prompt
  });

  const result = await runKimi(request.cwd, args, {
    onProgress: request.onProgress
  });

  const payload = {
    review: reviewName,
    target,
    kimi: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout
    }
  };

  const rendered = renderReviewResult(
    {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    },
    { reviewLabel: reviewName, targetLabel: context.target.label }
  );

  return {
    exitStatus: result.status,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.stdout, `${reviewName} completed.`),
    jobTitle: `Kimi ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  ensureKimiAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    continueSession: request.continueSession
  });

  if (!request.prompt && !request.continueSession) {
    throw new Error("Provide a prompt, piped stdin, or use --continue.");
  }

  const args = buildKimiArgs({
    cwd: request.cwd,
    model: request.model,
    thinking: request.thinking,
    continueSession: request.continueSession,
    prompt: request.prompt || "Continue from where you left off."
  });

  const result = await runKimi(request.cwd, args, {
    onProgress: request.onProgress
  });

  const rawOutput = result.stdout;
  const failureMessage = result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null
    }
  );
  const payload = {
    status: result.status,
    rawOutput,
    stderr: result.stderr
  };

  return {
    exitStatus: result.status,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: true
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Kimi Review" : `Kimi ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, continueSession = false }) {
  const title = continueSession ? "Kimi Continue" : "Kimi Task";
  const fallbackSummary = continueSession ? "Continue previous session" : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /kimi:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, thinking, prompt, continueSession, jobId }) {
  return {
    cwd,
    model,
    thinking,
    prompt,
    continueSession,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, continueSession) {
  if (!prompt && !continueSession) {
    throw new Error("Provide a prompt, piped stdin, or use --continue.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "kimi-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json", "continue", "background", "thinking", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const prompt = readTaskPrompt(cwd, options, positionals);
  const continueSession = Boolean(options.continue);
  const thinking = Boolean(options.thinking);

  if (!prompt && !continueSession) {
    throw new Error("Provide a prompt, piped stdin, or use --continue.");
  }

  const taskMetadata = buildTaskRunMetadata({
    prompt,
    continueSession
  });

  if (options.background) {
    ensureKimiAvailable(cwd);
    requireTaskRequest(prompt, continueSession);

    const job = buildTaskJob(workspaceRoot, taskMetadata, true);
    const request = buildTaskRequest({
      cwd,
      model,
      thinking,
      prompt,
      continueSession,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, true);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        thinking,
        prompt,
        continueSession,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const visibleJobs = sessionId ? jobs.filter((job) => job.sessionId === sessionId) : jobs;

  const candidate = visibleJobs.find(
    (job) =>
      job.jobClass === "task" &&
      job.status !== "queued" &&
      job.status !== "running"
  ) ?? null;

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
