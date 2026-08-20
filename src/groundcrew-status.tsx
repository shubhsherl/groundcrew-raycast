import { getPreferenceValues } from "@raycast/api";
import { useCallback, useMemo } from "react";

import { createGroundcrewClient, type GroundcrewClient } from "./cli";
import { StatusDashboard } from "./components";

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
  const loadStatus = useCallback(async () => (await getClient()).getStatus(), [getClient]);

  return <StatusDashboard loadStatus={loadStatus} />;
}
