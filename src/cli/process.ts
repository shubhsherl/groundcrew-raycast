import { spawn } from "node:child_process";

export interface ProcessOptions {
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface CapturedDiagnostics {
  stderr: string;
  stdout: string;
}

export type ProcessResult =
  | ({ kind: "success"; exitCode: 0 } & CapturedDiagnostics)
  | ({
      kind: "failure";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    } & CapturedDiagnostics)
  | ({ kind: "timeout" } & CapturedDiagnostics)
  | ({ kind: "canceled" } & CapturedDiagnostics)
  | ({ kind: "launch-failure"; error: Error } & CapturedDiagnostics);

const FORCE_KILL_AFTER_MS = 250;

// `exit` fires when the process itself exits; `close` additionally waits for its
// stdio pipes to end. A detached grandchild that inherited those pipes — e.g.
// crew's long-lived clearance daemon spawned by `crew start` — can hold them open
// indefinitely, so `close` may never arrive. Prefer `close` for complete output,
// but fall back to `exit` after this grace window so a lingering daemon can't leave
// the command hanging (which surfaced as a successful `crew start` reported as
// "canceled"). The window is ample for a normal pipe close, which is near-instant.
const CLOSE_GRACE_AFTER_EXIT_MS = 200;

export async function runProcess(
  executablePath: string,
  argv: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted === true) {
    return { kind: "canceled", stdout: "", stderr: "" };
  }

  return await new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let terminalRequest: "canceled" | "timeout" | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let closeGrace: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(executablePath, [...argv], {
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = (kind: "canceled" | "timeout") => {
      if (terminalRequest !== undefined) {
        return;
      }
      terminalRequest = kind;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_AFTER_MS);
    };

    const abort = () => terminate("canceled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    }

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
      }
      if (closeGrace !== undefined) {
        clearTimeout(closeGrace);
      }
      options.signal?.removeEventListener("abort", abort);

      if (terminalRequest !== undefined) {
        resolve({ kind: terminalRequest, stdout, stderr });
        return;
      }
      if (launchError !== undefined) {
        resolve({ kind: "launch-failure", error: launchError, stdout, stderr });
        return;
      }
      if (exitCode === 0) {
        resolve({ kind: "success", exitCode: 0, stdout, stderr });
        return;
      }
      resolve({ kind: "failure", exitCode, signal, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      launchError = error;
    });
    // Settle on `close` for complete output when the pipes end promptly; otherwise
    // fall back to `exit` after a grace window (see CLOSE_GRACE_AFTER_EXIT_MS) so a
    // grandchild holding the pipes open can't leave the command hanging.
    child.on("close", (exitCode, signal) => {
      settle(exitCode, signal);
    });
    child.on("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }
      closeGrace = setTimeout(() => {
        settle(exitCode, signal);
      }, CLOSE_GRACE_AFTER_EXIT_MS);
    });
  });
}
