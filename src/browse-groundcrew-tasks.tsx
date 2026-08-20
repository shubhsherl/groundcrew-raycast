import { getPreferenceValues } from "@raycast/api";
import { useCallback, useMemo } from "react";

import { createGroundcrewClient, type GroundcrewClient } from "./cli";
import { TaskBrowser } from "./components";

interface Preferences {
  crewPath?: string;
}

export default function Command() {
  const { crewPath } = getPreferenceValues<Preferences>();
  const getClient = useMemo(() => {
    let clientPromise: Promise<GroundcrewClient> | undefined;
    return async () => {
      clientPromise ??= createGroundcrewClient({
        ...(crewPath?.trim() ? { executablePath: crewPath.trim() } : {}),
      });
      try {
        return await clientPromise;
      } catch (error) {
        clientPromise = undefined;
        throw error;
      }
    };
  }, [crewPath]);
  const loadTasks = useCallback(async () => (await getClient()).listTasks(), [getClient]);
  const loadTask = useCallback(
    async (taskId: string) => (await getClient()).getTask(taskId),
    [getClient],
  );

  return <TaskBrowser loadTasks={loadTasks} loadTask={loadTask} />;
}
