import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GroundcrewClient } from "../cli";
import type {
  GroundcrewLifecycleResult,
  GroundcrewStatusBlockedIssue,
  GroundcrewStatusBoardIssue,
  GroundcrewStatusInventory,
  GroundcrewStatusQueueIssue,
  GroundcrewStatusTask,
  GroundcrewTask,
} from "../types/groundcrew";

export type LifecycleAction = "start" | "stop" | "resume" | "cleanup";

export type LifecycleMutations = Pick<
  GroundcrewClient,
  "startTask" | "stopTask" | "resumeTask" | "cleanupTask"
>;

export interface LifecycleReconciliation {
  status?: LifecycleTaskSelection;
  statusRefreshed: boolean;
  task?: GroundcrewTask;
  taskRefreshed: boolean;
}

export interface LifecycleActionController {
  isMutating: (taskId: string) => boolean;
  run: (
    action: LifecycleAction,
    taskId: string,
    options?: { reason?: string; targetTaskId?: string },
  ) => Promise<void>;
}

export type LifecycleTaskSelection =
  | { kind: "local"; task: GroundcrewStatusTask }
  | { kind: "missing"; task: GroundcrewStatusBoardIssue }
  | { kind: "ready"; task: GroundcrewStatusQueueIssue }
  | { kind: "blocked"; task: GroundcrewStatusBlockedIssue };

export interface LifecycleAvailability {
  cleanup: boolean;
  resume: boolean;
  start: boolean;
  stop: boolean;
}

const ACTION_PRESENTATION: Record<
  LifecycleAction,
  { progress: string; success: string; canceled: string; failure: string }
> = {
  start: {
    progress: "Starting Task",
    success: "Task Started",
    canceled: "Start Canceled",
    failure: "Couldn’t Start Task",
  },
  stop: {
    progress: "Stopping Task",
    success: "Task Stopped",
    canceled: "Stop Canceled",
    failure: "Couldn’t Stop Task",
  },
  resume: {
    progress: "Resuming Task",
    success: "Task Resumed",
    canceled: "Resume Canceled",
    failure: "Couldn’t Resume Task",
  },
  cleanup: {
    progress: "Cleaning Up Task",
    success: "Task Cleaned Up",
    canceled: "Cleanup Canceled",
    failure: "Couldn’t Clean Up Task",
  },
};

function normalizedTaskId(taskId: string): string {
  return taskId.trim().toLowerCase();
}

function isCanonicalTaskId(taskId: string): boolean {
  return taskId.includes(":");
}

function naturalTaskId(taskId: string): string {
  const normalized = normalizedTaskId(taskId);
  const separator = normalized.indexOf(":");
  return separator < 0 ? normalized : normalized.slice(separator + 1);
}

export function findCanonicalTask(
  tasks: readonly GroundcrewTask[],
  taskId: string,
): GroundcrewTask | undefined {
  const normalized = normalizedTaskId(taskId);
  if (isCanonicalTaskId(normalized)) {
    return tasks.find((task) => normalizedTaskId(task.id) === normalized);
  }
  const matches = tasks.filter((task) => naturalTaskId(task.id) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

export function findLifecycleTask(
  inventory: GroundcrewStatusInventory,
  taskId: string,
): LifecycleTaskSelection | undefined {
  const selections: LifecycleTaskSelection[] = [
    ...inventory.tasks.map((task): LifecycleTaskSelection => ({ kind: "local", task })),
    ...inventory.inProgressWithoutWorktree.map((task): LifecycleTaskSelection => ({
      kind: "missing",
      task,
    })),
    ...inventory.queueReady.map((task): LifecycleTaskSelection => ({ kind: "ready", task })),
    ...inventory.queueBlocked.map((task): LifecycleTaskSelection => ({ kind: "blocked", task })),
  ];
  const normalized = normalizedTaskId(taskId);
  const matches = selections.filter((selection) => {
    if (isCanonicalTaskId(normalized)) {
      const canonicalId =
        selection.kind === "local" ? selection.task.source?.id : selection.task.id;
      return canonicalId !== undefined && normalizedTaskId(canonicalId) === normalized;
    }
    const naturalId = selection.kind === "local" ? selection.task.task : selection.task.naturalId;
    return normalizedTaskId(naturalId) === normalized;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function getLifecycleAvailability(
  task?: GroundcrewTask,
  status?: LifecycleTaskSelection,
): LifecycleAvailability {
  const canonicalStartEligible =
    task?.status === "todo" && task.blockers.length === 0 && !task.hasMoreBlockers;
  const local = status?.kind === "local" ? status.task : undefined;
  const hasPreservedWorktree = (local?.worktrees.length ?? 0) > 0;
  return {
    start:
      status?.kind === "ready"
        ? task === undefined || canonicalStartEligible
        : status === undefined && canonicalStartEligible,
    stop: local?.session === "live",
    resume:
      hasPreservedWorktree && (local?.lifecycle === "interrupted" || local?.session === "exited"),
    cleanup: local !== undefined && local.session !== "live",
  };
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function reconciliationMessage(reconciliation: LifecycleReconciliation): string {
  const details: string[] = [];
  if (reconciliation.task !== undefined) {
    details.push(`Task: ${titleCase(reconciliation.task.status)}`);
  }
  if (reconciliation.status !== undefined) {
    switch (reconciliation.status.kind) {
      case "local":
        details.push(`Lifecycle: ${titleCase(reconciliation.status.task.lifecycle)}`);
        details.push(`Session: ${titleCase(reconciliation.status.task.session)}`);
        break;
      case "missing":
        details.push("Status: Workspace Missing");
        break;
      case "ready":
        details.push("Status: Queue Ready");
        break;
      case "blocked":
        details.push("Status: Queue Blocked");
        break;
    }
  }
  if (!reconciliation.taskRefreshed || !reconciliation.statusRefreshed) {
    details.push("Refresh incomplete");
  }
  return details.length === 0
    ? "Task is absent from refreshed task and status data."
    : details.join(" · ");
}

async function invokeMutation({
  action,
  controller,
  mutations,
  reason,
  taskId,
}: {
  action: LifecycleAction;
  controller: AbortController;
  mutations: LifecycleMutations;
  reason?: string;
  taskId: string;
}): Promise<GroundcrewLifecycleResult> {
  switch (action) {
    case "start":
      return await mutations.startTask(taskId, { signal: controller.signal });
    case "stop":
      return await mutations.stopTask(taskId, {
        signal: controller.signal,
        ...(reason === undefined ? {} : { reason }),
      });
    case "resume":
      return await mutations.resumeTask(taskId, { signal: controller.signal });
    case "cleanup":
      return await mutations.cleanupTask(taskId, { signal: controller.signal });
  }
}

export function useLifecycleActionController({
  mutations,
  reconcile,
}: {
  mutations: LifecycleMutations;
  reconcile: (taskId: string) => Promise<LifecycleReconciliation>;
}): LifecycleActionController {
  const active = useRef(new Map<string, AbortController>());
  const [, render] = useState(0);

  useEffect(
    () => () => {
      for (const controller of active.current.values()) {
        controller.abort();
      }
      active.current.clear();
    },
    [],
  );

  const isMutating = useCallback((taskId: string) => active.current.has(taskId), []);
  const run = useCallback(
    async (
      action: LifecycleAction,
      taskId: string,
      options?: { reason?: string; targetTaskId?: string },
    ) => {
      if (active.current.has(taskId)) {
        return;
      }
      const controller = new AbortController();
      active.current.set(taskId, controller);
      render((current) => current + 1);
      const presentation = ACTION_PRESENTATION[action];
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: presentation.progress,
        primaryAction: { title: "Cancel", onAction: () => controller.abort() },
      });

      let result: GroundcrewLifecycleResult;
      try {
        result = await invokeMutation({
          action,
          controller,
          mutations,
          reason: options?.reason,
          taskId: options?.targetTaskId ?? taskId,
        });
      } catch (error) {
        result = {
          kind: "launch-failure",
          error: error instanceof Error ? error : new Error("Groundcrew could not be launched."),
          stdout: "",
          stderr: "",
        };
      }

      toast.primaryAction = undefined;
      toast.message = "Refreshing task and status data…";
      let reconciliation: LifecycleReconciliation;
      try {
        reconciliation = await reconcile(taskId);
      } catch {
        reconciliation = { statusRefreshed: false, taskRefreshed: false };
      }

      switch (result.kind) {
        case "success":
          toast.style = Toast.Style.Success;
          toast.title = presentation.success;
          break;
        case "canceled":
          toast.style = Toast.Style.Failure;
          toast.title = presentation.canceled;
          break;
        case "failure":
        case "timeout":
        case "launch-failure":
          toast.style = Toast.Style.Failure;
          toast.title = presentation.failure;
          break;
      }
      toast.message = reconciliationMessage(reconciliation);

      if (active.current.get(taskId) === controller) {
        active.current.delete(taskId);
        render((current) => current + 1);
      }
    },
    [mutations, reconcile],
  );

  return useMemo(() => ({ isMutating, run }), [isMutating, run]);
}

function StopTaskForm({
  controller,
  taskId,
  targetTaskId,
}: {
  controller: LifecycleActionController;
  taskId: string;
  targetTaskId: string;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={`Stop ${taskId}`}
      actions={
        <ActionPanel>
          {controller.isMutating(taskId) ? (
            <Action title="Stop Task" icon={Icon.Stop} />
          ) : (
            <Action.SubmitForm
              title="Stop Task"
              icon={Icon.Stop}
              onSubmit={async (values: { reason?: string }) => {
                const reason = values.reason;
                await controller.run("stop", taskId, {
                  ...(reason === undefined || reason.trim().length === 0 ? {} : { reason }),
                  targetTaskId,
                });
                pop();
              }}
            />
          )}
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="reason"
        title="Reason"
        placeholder="Optional reason for stopping this task"
      />
    </Form>
  );
}

export function LifecycleActions({
  controller,
  status,
  task,
  taskId,
}: {
  controller: LifecycleActionController;
  status?: LifecycleTaskSelection;
  task?: GroundcrewTask;
  taskId: string;
}) {
  const availability = getLifecycleAvailability(task, status);
  const disabled = controller.isMutating(taskId);
  const startTaskId = status?.kind === "ready" ? status.task.id : (task?.id ?? taskId);
  const localTaskId = status?.kind === "local" ? status.task.task : taskId;
  return (
    <>
      {availability.start ? (
        <Action
          title="Start Task"
          icon={Icon.Play}
          {...(disabled
            ? {}
            : {
                onAction: () => controller.run("start", taskId, { targetTaskId: startTaskId }),
              })}
        />
      ) : null}
      {availability.stop ? (
        disabled ? (
          <Action title="Stop Task" icon={Icon.Stop} />
        ) : (
          <Action.Push
            title="Stop Task"
            icon={Icon.Stop}
            target={
              <StopTaskForm controller={controller} taskId={taskId} targetTaskId={localTaskId} />
            }
          />
        )
      ) : null}
      {availability.resume ? (
        <Action
          title="Resume Task"
          icon={Icon.ArrowClockwise}
          {...(disabled
            ? {}
            : {
                onAction: () => controller.run("resume", taskId, { targetTaskId: localTaskId }),
              })}
        />
      ) : null}
      {availability.cleanup ? (
        <Action
          title="Cleanup Task"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          {...(disabled
            ? {}
            : {
                onAction: async () => {
                  const confirmed = await confirmAlert({
                    title: `Cleanup ${taskId}?`,
                    message: "This removes the preserved Groundcrew workspace for this task.",
                    primaryAction: {
                      title: "Cleanup Task",
                      style: Alert.ActionStyle.Destructive,
                    },
                  });
                  if (confirmed) {
                    await controller.run("cleanup", taskId, { targetTaskId: localTaskId });
                  }
                },
              })}
        />
      ) : null}
    </>
  );
}
