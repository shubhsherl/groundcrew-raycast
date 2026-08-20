import type {
  GroundcrewLifecycleResult,
  GroundcrewStatusInventory,
  GroundcrewTask,
} from "../types/groundcrew";
import { GroundcrewClientError } from "./errors";
import { resolveCrewExecutable } from "./executable";
import { filterStatusByNaturalTaskId, parseLegacyStatusJson } from "./legacy-status";
import { type ProcessResult, runProcess } from "./process";
import { assertCompatibleVersion } from "./semver";
import { parseTaskJson, parseTaskListJson } from "./task-json";

export const MINIMUM_GROUNDCREW_VERSION = "4.50.3";

const DEFAULT_VERSION_TIMEOUT_MS = 5_000;

export interface CreateGroundcrewClientOptions {
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  versionTimeoutMs?: number;
}

export interface LifecycleOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StopTaskOptions extends LifecycleOptions {
  reason?: string;
}

export interface GroundcrewClient {
  readonly executablePath: string;
  readonly version: string;
  listTasks(): Promise<GroundcrewTask[]>;
  getTask(taskId: string): Promise<GroundcrewTask>;
  /** Always loads `crew status --json`; natural-task filtering happens after the full inventory is parsed. */
  getStatus(naturalTaskId?: string): Promise<GroundcrewStatusInventory>;
  startTask(taskId: string, options?: LifecycleOptions): Promise<GroundcrewLifecycleResult>;
  stopTask(taskId: string, options?: StopTaskOptions): Promise<GroundcrewLifecycleResult>;
  resumeTask(taskId: string, options?: LifecycleOptions): Promise<GroundcrewLifecycleResult>;
  cleanupTask(taskId: string, options?: LifecycleOptions): Promise<GroundcrewLifecycleResult>;
}

function diagnostics(result: ProcessResult) {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.kind === "failure" ? { exitCode: result.exitCode } : {}),
  };
}

function conciseFailureDetail(result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (detail.length === 0) {
    return "No diagnostic output was captured.";
  }
  const firstLine = detail.split("\n", 1)[0] ?? detail;
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

function commandFailure(argv: readonly string[], result: ProcessResult): GroundcrewClientError {
  const description = `crew ${argv.join(" ")}`;
  switch (result.kind) {
    case "launch-failure":
      return new GroundcrewClientError(
        "LAUNCH_FAILED",
        `Could not launch ${description}: ${result.error.message}`,
        { cause: result.error, diagnostics: diagnostics(result) },
      );
    case "timeout":
      return new GroundcrewClientError("COMMAND_TIMEOUT", `${description} timed out.`, {
        diagnostics: diagnostics(result),
      });
    case "canceled":
      return new GroundcrewClientError("COMMAND_CANCELED", `${description} was canceled.`, {
        diagnostics: diagnostics(result),
      });
    case "failure":
      return new GroundcrewClientError(
        "COMMAND_FAILED",
        `${description} exited with ${result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.exitCode}`}: ${conciseFailureDetail(result)}`,
        { diagnostics: diagnostics(result) },
      );
    case "success":
      throw new Error("A successful process cannot be converted to a command failure.");
  }
}

class InstalledGroundcrewClient implements GroundcrewClient {
  public readonly executablePath: string;
  public readonly version: string;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(executablePath: string, version: string, environment: NodeJS.ProcessEnv) {
    this.executablePath = executablePath;
    this.version = version;
    this.#environment = environment;
  }

  async #runJson(argv: readonly string[]): Promise<string> {
    const result = await runProcess(this.executablePath, argv, { environment: this.#environment });
    if (result.kind !== "success") {
      throw commandFailure(argv, result);
    }
    return result.stdout;
  }

  async #runLifecycle(
    argv: readonly string[],
    options: LifecycleOptions = {},
  ): Promise<GroundcrewLifecycleResult> {
    return await runProcess(this.executablePath, argv, {
      environment: this.#environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  public async listTasks(): Promise<GroundcrewTask[]> {
    return parseTaskListJson(await this.#runJson(["task", "list", "--json"]));
  }

  public async getTask(taskId: string): Promise<GroundcrewTask> {
    return parseTaskJson(await this.#runJson(["task", "get", taskId, "--json"]));
  }

  public async getStatus(naturalTaskId?: string): Promise<GroundcrewStatusInventory> {
    const normalized = naturalTaskId?.trim();
    if (naturalTaskId !== undefined && normalized?.length === 0) {
      throw new GroundcrewClientError(
        "INVALID_ARGUMENT",
        "Status filtering requires a non-empty natural task ID.",
      );
    }
    const inventory = parseLegacyStatusJson(await this.#runJson(["status", "--json"]));
    if (normalized === undefined) {
      return inventory;
    }
    return filterStatusByNaturalTaskId(inventory, normalized);
  }

  public async startTask(
    taskId: string,
    options: LifecycleOptions = {},
  ): Promise<GroundcrewLifecycleResult> {
    return await this.#runLifecycle(["start", taskId], options);
  }

  public async stopTask(
    taskId: string,
    options: StopTaskOptions = {},
  ): Promise<GroundcrewLifecycleResult> {
    const argv = [
      "stop",
      taskId,
      ...(options.reason === undefined ? [] : ["--reason", options.reason]),
    ];
    return await this.#runLifecycle(argv, options);
  }

  public async resumeTask(
    taskId: string,
    options: LifecycleOptions = {},
  ): Promise<GroundcrewLifecycleResult> {
    return await this.#runLifecycle(["resume", taskId], options);
  }

  public async cleanupTask(
    taskId: string,
    options: LifecycleOptions = {},
  ): Promise<GroundcrewLifecycleResult> {
    return await this.#runLifecycle(["cleanup", taskId], options);
  }
}

export async function createGroundcrewClient(
  options: CreateGroundcrewClientOptions = {},
): Promise<GroundcrewClient> {
  const environment = { ...(options.environment ?? process.env) };
  const executablePath = await resolveCrewExecutable({
    configuredPath: options.executablePath,
    environment,
  });
  const versionResult = await runProcess(executablePath, ["--version"], {
    environment,
    timeoutMs: options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
  });
  if (versionResult.kind !== "success") {
    throw commandFailure(["--version"], versionResult);
  }
  const version = assertCompatibleVersion(versionResult.stdout, MINIMUM_GROUNDCREW_VERSION);
  return new InstalledGroundcrewClient(executablePath, version, environment);
}
