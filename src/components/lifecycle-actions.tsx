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
  run: (action: LifecycleAction, taskId: string, reason?: string) => Promise<void>;
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

function taskIdForms(taskId: string): Set<string> {
  const normalized = taskId.trim().toLowerCase();
  const separator = normalized.lastIndexOf(":");
  return new Set([normalized, separator < 0 ? normalized : normalized.slice(separator + 1)]);
}

function taskIdsMatch(left: string, right: string): boolean {
  const leftForms = taskIdForms(left);
  return [...taskIdForms(right)].some((candidate) => leftForms.has(candidate));
}

export function findCanonicalTask(
  tasks: readonly GroundcrewTask[],
  taskId: string,
): GroundcrewTask | undefined {
  return tasks.find((task) => taskIdsMatch(task.id, taskId));
}

export function findLifecycleTask(
  inventory: GroundcrewStatusInventory,
  taskId: string,
): LifecycleTaskSelection | undefined {
  const local = inventory.tasks.find(
    (task) =>
      taskIdsMatch(task.task, taskId) ||
      (task.source !== undefined && taskIdsMatch(task.source.id, taskId)),
  );
  if (local !== undefined) {
    return { kind: "local", task: local };
  }
  const missing = inventory.inProgressWithoutWorktree.find(
    (task) => taskIdsMatch(task.id, taskId) || taskIdsMatch(task.naturalId, taskId),
  );
  if (missing !== undefined) {
    return { kind: "missing", task: missing };
  }
  const ready = inventory.queueReady.find(
    (task) => taskIdsMatch(task.id, taskId) || taskIdsMatch(task.naturalId, taskId),
  );
  if (ready !== undefined) {
    return { kind: "ready", task: ready };
  }
  const blocked = inventory.queueBlocked.find(
    (task) => taskIdsMatch(task.id, taskId) || taskIdsMatch(task.naturalId, taskId),
  );
  return blocked === undefined ? undefined : { kind: "blocked", task: blocked };
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
    async (action: LifecycleAction, taskId: string, reason?: string) => {
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
        result = await invokeMutation({ action, controller, mutations, reason, taskId });
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
}: {
  controller: LifecycleActionController;
  taskId: string;
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
                await controller.run(
                  "stop",
                  taskId,
                  reason === undefined || reason.trim().length === 0 ? undefined : reason,
                );
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
  return (
    <>
      {availability.start ? (
        <Action
          title="Start Task"
          icon={Icon.Play}
          {...(disabled ? {} : { onAction: () => controller.run("start", taskId) })}
        />
      ) : null}
      {availability.stop ? (
        disabled ? (
          <Action title="Stop Task" icon={Icon.Stop} />
        ) : (
          <Action.Push
            title="Stop Task"
            icon={Icon.Stop}
            target={<StopTaskForm controller={controller} taskId={taskId} />}
          />
        )
      ) : null}
      {availability.resume ? (
        <Action
          title="Resume Task"
          icon={Icon.ArrowClockwise}
          {...(disabled ? {} : { onAction: () => controller.run("resume", taskId) })}
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
                    await controller.run("cleanup", taskId);
                  }
                },
              })}
        />
      ) : null}
    </>
  );
}
