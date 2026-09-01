import { describe, expect, it } from "vitest";

import { runProcess } from "../cli/process";

describe("runProcess", () => {
  it("captures output and reports success for a normal command", async () => {
    const result = await runProcess("/bin/sh", ["-c", "echo hello"], { environment: process.env });
    expect(result.kind).toBe("success");
    expect(result.stdout).toContain("hello");
  });

  it("reports failure with the exit code for a non-zero exit", async () => {
    const result = await runProcess("/bin/sh", ["-c", "exit 3"], { environment: process.env });
    expect(result).toMatchObject({ kind: "failure", exitCode: 3 });
  });

  it("resolves promptly on exit when a background child keeps the stdout pipe open", async () => {
    // `sleep 5 &` inherits stdout and outlives the shell, so the `close` event is
    // delayed ~5s while the shell itself exits immediately — the same shape as
    // `crew start` leaving its clearance daemon running. runProcess must settle via
    // `exit` (plus the short grace window) rather than hang until the pipe closes.
    const started = Date.now();
    const result = await runProcess("/bin/sh", ["-c", "sleep 5 & echo ready"], {
      environment: process.env,
    });
    const elapsedMs = Date.now() - started;

    expect(result.kind).toBe("success");
    expect(result.stdout).toContain("ready");
    expect(elapsedMs).toBeLessThan(2000);
  });
});
