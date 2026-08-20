import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import taskDetailFixture from "./fixtures/task-detail.json";
import taskListFixture from "./fixtures/task-list.json";
import { GroundcrewClientError } from "../cli";
import { TaskBrowser, TaskDetail } from "../components/task-browser";
import type { GroundcrewTask } from "../types/groundcrew";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@raycast/api", () => {
  function mockComponent(name: string, renderProps: string[] = []) {
    return function MockComponent(props: Record<string, unknown>) {
      const children = [props.children, ...renderProps.map((property) => props[property])];
      return createElement(name, props, ...children);
    };
  }

  const List = Object.assign(mockComponent("raycast-list", ["searchBarAccessory", "actions"]), {
    Dropdown: Object.assign(mockComponent("raycast-list-dropdown"), {
      Item: mockComponent("raycast-list-dropdown-item"),
    }),
    EmptyView: mockComponent("raycast-list-empty-view", ["actions"]),
    Item: mockComponent("raycast-list-item", ["actions"]),
    Section: mockComponent("raycast-list-section"),
  });
  const Detail = Object.assign(mockComponent("raycast-detail", ["metadata", "actions"]), {
    Metadata: Object.assign(mockComponent("raycast-detail-metadata"), {
      Label: mockComponent("raycast-detail-metadata-label"),
      Link: mockComponent("raycast-detail-metadata-link"),
      Separator: mockComponent("raycast-detail-metadata-separator"),
      TagList: Object.assign(mockComponent("raycast-detail-metadata-tag-list"), {
        Item: mockComponent("raycast-detail-metadata-tag-list-item"),
      }),
    }),
  });
  const Action = Object.assign(mockComponent("raycast-action"), {
    OpenInBrowser: mockComponent("raycast-action-open-in-browser"),
    Push: mockComponent("raycast-action-push"),
  });

  return {
    Action,
    ActionPanel: mockComponent("raycast-action-panel"),
    Color: {
      Blue: "blue",
      Green: "green",
      Purple: "purple",
      Red: "red",
      SecondaryText: "secondary",
      Yellow: "yellow",
    },
    Detail,
    Icon: new Proxy({}, { get: (_target, property) => String(property) }),
    Keyboard: { Shortcut: { Common: { Refresh: { modifiers: ["cmd"], key: "r" } } } },
    List,
    openExtensionPreferences: vi.fn(),
    showToast: vi.fn(),
    Toast: { Style: { Failure: "failure" } },
  };
});

const tasks = taskListFixture as GroundcrewTask[];
const taskDetail = taskDetailFixture as GroundcrewTask;

function findByType(renderer: ReactTestRenderer, type: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === type);
}

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(element);
    await Promise.resolve();
  });
  if (renderer === undefined) {
    throw new Error("Renderer was not created.");
  }
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TaskBrowser", () => {
  it("shows loading, then source-neutral grouped rows with search fields and canonical filters", async () => {
    let resolveTasks: ((value: GroundcrewTask[]) => void) | undefined;
    const loadTasks = vi.fn(
      () =>
        new Promise<GroundcrewTask[]>((resolve) => {
          resolveTasks = resolve;
        }),
    );
    const renderer = await render(
      <TaskBrowser loadTasks={loadTasks} loadTask={async () => taskDetail} />,
    );

    expect(findByType(renderer, "raycast-list")[0]?.props.isLoading).toBe(true);
    expect(findByType(renderer, "raycast-list-empty-view")[0]?.props.title).toBe(
      "Loading Groundcrew Tasks",
    );

    await act(async () => {
      resolveTasks?.(tasks);
      await Promise.resolve();
    });

    expect(
      findByType(renderer, "raycast-list-section").map((section) => section.props.title),
    ).toEqual(["Ready Todo", "Active", "In Review", "Blocked", "Completed", "Other"]);
    const readyTask = findByType(renderer, "raycast-list-item").find(
      (item) => item.props.id === "tracker:TEM-3895",
    );
    expect(readyTask?.props).toMatchObject({
      title: "Build the Groundcrew task browser",
      subtitle: "tracker:TEM-3895 · ClipboardHealth/groundcrew-raycast",
      keywords: expect.arrayContaining(["todo", "work-tracker", "codex"]),
      accessories: expect.arrayContaining([
        expect.objectContaining({ text: "codex" }),
        expect.objectContaining({ tag: expect.objectContaining({ value: "Todo" }) }),
      ]),
    });
    const blockedTask = findByType(renderer, "raycast-list-item").find(
      (item) => item.props.id === "queue:BLOCKED-3",
    );
    expect(blockedTask?.props.accessories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.objectContaining({ value: "Blocked" }) }),
      ]),
    );

    const statusFilter = findByType(renderer, "raycast-list-dropdown")[0];
    await act(async () => statusFilter?.props.onChange("in-progress"));
    expect(findByType(renderer, "raycast-list-item").map((item) => item.props.id)).toEqual([
      "queue:RUN-42",
    ]);
  });

  it("supports manual refresh and distinguishes empty, setup, command, and incompatible CLI states", async () => {
    const loadTasks = vi
      .fn<() => Promise<GroundcrewTask[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new GroundcrewClientError("COMMAND_FAILED", "crew task list --json exited with code 1."),
      );
    const renderer = await render(
      <TaskBrowser loadTasks={loadTasks} loadTask={async () => taskDetail} />,
    );

    expect(findByType(renderer, "raycast-list-empty-view")[0]?.props.title).toBe(
      "No Groundcrew Tasks",
    );
    const refresh = findByType(renderer, "raycast-action").find(
      (action) => action.props.title === "Refresh Tasks",
    );
    await act(async () => {
      await refresh?.props.onAction();
    });
    expect(loadTasks).toHaveBeenCalledTimes(2);
    expect(findByType(renderer, "raycast-list-empty-view")[0]?.props).toMatchObject({
      title: "Couldn’t Load Groundcrew Tasks",
      description: "crew task list --json exited with code 1.",
    });

    const setupRenderer = await render(
      <TaskBrowser
        loadTasks={async () => {
          throw new GroundcrewClientError(
            "EXECUTABLE_NOT_FOUND",
            "Set the absolute Groundcrew Executable Path preference.",
          );
        }}
        loadTask={async () => taskDetail}
      />,
    );
    expect(findByType(setupRenderer, "raycast-list-empty-view")[0]?.props.title).toBe(
      "Groundcrew Setup Required",
    );

    const incompatibleRenderer = await render(
      <TaskBrowser
        loadTasks={async () => {
          throw new GroundcrewClientError(
            "INCOMPATIBLE_VERSION",
            "Upgrade Groundcrew and try again.",
          );
        }}
        loadTask={async () => taskDetail}
      />,
    );
    expect(findByType(incompatibleRenderer, "raycast-list-empty-view")[0]?.props).toMatchObject({
      title: "Groundcrew CLI Is Incompatible",
      description: "Upgrade Groundcrew and try again.",
    });
  });
});

describe("TaskDetail", () => {
  it("loads canonical detail fields and exposes Open Task only when the CLI supplies a URL", async () => {
    const loadTask = vi.fn(async () => taskDetail);
    const renderer = await render(<TaskDetail task={tasks[0]!} loadTask={loadTask} />);

    expect(loadTask).toHaveBeenCalledWith("tracker:TEM-3895");
    const detail = findByType(renderer, "raycast-detail")[0];
    expect(detail?.props.markdown).toContain(taskDetail.description);
    expect(detail?.props.markdown).toContain("Publish shared contract");
    expect(
      findByType(renderer, "raycast-detail-metadata-label").map((item) => item.props.title),
    ).toEqual(
      expect.arrayContaining(["Task ID", "Status", "Source", "Repository", "Blockers", "Priority"]),
    );
    expect(findByType(renderer, "raycast-detail-metadata-link")[0]?.props).toMatchObject({
      title: "Task URL",
      target: taskDetail.url,
    });
    expect(findByType(renderer, "raycast-action-open-in-browser")[0]?.props).toMatchObject({
      title: "Open Task",
      url: taskDetail.url,
    });

    const withoutUrl = { ...taskDetail, url: undefined };
    const withoutUrlRenderer = await render(
      <TaskDetail task={withoutUrl} loadTask={async () => withoutUrl} />,
    );
    expect(findByType(withoutUrlRenderer, "raycast-action-open-in-browser")).toHaveLength(0);
    expect(findByType(withoutUrlRenderer, "raycast-detail-metadata-link")).toHaveLength(0);
  });
});
