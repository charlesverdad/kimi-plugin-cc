import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/kimi/scripts/lib/render.mjs";

test("renderReviewResult renders stdout under a Kimi review header", () => {
  const output = renderReviewResult(
    {
      stdout: "Verdict: approve\nLooks fine.",
      stderr: "",
      status: 0
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /^# Kimi Adversarial Review/);
  assert.match(output, /Target: working tree diff/);
  assert.match(output, /Verdict: approve/);
  assert.match(output, /Looks fine\./);
  assert.doesNotMatch(output, /stderr:/);
});

test("renderReviewResult reports empty success and appends stderr blocks", () => {
  const emptySuccess = renderReviewResult(
    { stdout: "", stderr: "", status: 0 },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(emptySuccess, /Kimi review completed without any stdout output\./);

  const failure = renderReviewResult(
    { stdout: "", stderr: "boom", status: 1 },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(failure, /Kimi review failed\./);
  assert.match(failure, /stderr:/);
  assert.match(failure, /```text\nboom\n```/);
});

test("renderStoredJobResult prefers raw output for structured jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Kimi Adversarial Review",
      jobClass: "review"
    },
    {
      rendered: "# Kimi Adversarial Review\n\nTarget: working tree diff\n",
      result: {
        rawOutput: "# Kimi Adversarial Review\n\nVerdict: needs-attention\nOne issue."
      }
    }
  );

  assert.match(output, /^# Kimi Adversarial Review/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /\n$/);
});

test("renderStoredJobResult falls back to rendered output, then to a summary", () => {
  const renderedFallback = renderStoredJobResult(
    { id: "job-1", status: "completed", title: "Kimi Result" },
    { rendered: "# Kimi Result\n\nRendered body" }
  );
  assert.match(renderedFallback, /^# Kimi Result/);
  assert.match(renderedFallback, /Rendered body/);

  const summaryFallback = renderStoredJobResult(
    { id: "job-2", status: "failed", title: "Kimi Result", summary: "did not finish" },
    { errorMessage: "kimi exited with code 1" }
  );
  assert.match(summaryFallback, /^# Kimi Result/);
  assert.match(summaryFallback, /Job: job-2/);
  assert.match(summaryFallback, /Status: failed/);
  assert.match(summaryFallback, /Summary: did not finish/);
  assert.match(summaryFallback, /kimi exited with code 1/);
});
