// ABOUTME: Tests for the project-lifecycle IPC bridge (TD-17, #472) — which backend command each
// ABOUTME: call names and with what arguments, since this is the app's only signal that a project
// ABOUTME: is open and therefore the only thing that binds that project's MCP server.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callBackendMock = vi.fn();
vi.mock("../backend", () => ({
  callBackend: (...args: unknown[]) => callBackendMock(...args),
}));

const listenForBackendEventMock = vi.fn();
vi.mock("./driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEventMock(...args),
}));

const {
  ancestorsOf,
  presentFilePaths,
  undescendedPaths,
  closeProject,
  currentProject,
  isProjectPathEnumerable,
  listenForProjectFilesRefreshes,
  movedPath,
  movedSubtreePath,
  openProject,
  routeProjectOpen,
  listenForProjectRouting,
  PROJECT_FILES_EVENT,
  PROJECT_ROUTING_EVENT,
} = await import("./project");

type Move = import("./project").ProjectFileMove;

function fileMove(oldPath: string, newPath: string): Move {
  return { old_path: oldPath, new_path: newPath, kind: "file" };
}

function directoryMove(oldPath: string, newPath: string): Move {
  return { old_path: oldPath, new_path: newPath, kind: "directory" };
}

type Entry = import("./project").ProjectFileEntry;

function file(path: string, kind: Entry["kind"] = "file"): Entry {
  return { path, name: path.split("/").pop() ?? path, kind, children: [], warning: null };
}

function directory(path: string, children: Entry[]): Entry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "directory",
    children,
    warning: null,
  };
}

/** A directory row the backend published because `read_dir` failed: present, but never enumerated. */
function unreadableDirectory(path: string): Entry {
  return { ...directory(path, []), warning: { kind: "unreadable", message: "permission denied" } };
}

describe("openProject", () => {
  it("calls open_project with the project root", async () => {
    callBackendMock.mockResolvedValueOnce(undefined);

    await openProject("/project");

    expect(callBackendMock).toHaveBeenCalledWith("open_project", {
      root: "/project",
    });
  });

  it("rejects when the backend cannot open the project", async () => {
    callBackendMock.mockRejectedValueOnce({
      kind: "Bind",
      message: "address in use",
    });

    await expect(openProject("/project")).rejects.toEqual({
      kind: "Bind",
      message: "address in use",
    });
  });
});

describe("routeProjectOpen", () => {
  it("calls the thin route_project_open IPC and returns its typed outcome", async () => {
    const outcome = { status: "focused_other", root: "/project" } as const;
    callBackendMock.mockResolvedValueOnce(outcome);

    await expect(routeProjectOpen("/project")).resolves.toEqual(outcome);

    expect(callBackendMock).toHaveBeenCalledWith("route_project_open", {
      root: "/project",
    });
  });
});

describe("listenForProjectRouting", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
  });

  it("subscribes to the backend-owned project-routing event", async () => {
    const unlisten = vi.fn();
    listenForBackendEventMock.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    await expect(listenForProjectRouting(handler)).resolves.toBe(unlisten);

    expect(listenForBackendEventMock).toHaveBeenCalledWith(
      PROJECT_ROUTING_EVENT,
      handler,
    );
  });
});

describe("currentProject", () => {
  it("hydrates the backend-owned startup project without arguments", async () => {
    callBackendMock.mockResolvedValueOnce("/routed project");

    await expect(currentProject()).resolves.toBe("/routed project");
    expect(callBackendMock).toHaveBeenCalledWith("current_project", {});
  });
});

describe("closeProject", () => {
  it("calls close_project with no arguments", async () => {
    callBackendMock.mockResolvedValueOnce(undefined);

    await closeProject();

    expect(callBackendMock).toHaveBeenCalledWith("close_project", {});
  });

  it("preserves the close-side RunActive refusal", async () => {
    const error = {
      kind: "RunActive",
      message: "finish or stop the active run before closing the project",
    };
    callBackendMock.mockRejectedValueOnce(error);

    await expect(closeProject()).rejects.toEqual(error);
  });
});

describe("isProjectPathEnumerable", () => {
  it("asks the backend rule owner about the exact project-relative path", async () => {
    callBackendMock.mockResolvedValueOnce(false);

    await expect(isProjectPathEnumerable("node_modules/pkg/README.md")).resolves.toBe(false);
    expect(callBackendMock).toHaveBeenCalledWith("project_path_is_enumerable", {
      path: "node_modules/pkg/README.md",
    });
  });
});

describe("movedPath", () => {
  it("follows only a move the backend actually proved for that exact path", () => {
    const moves = [
      directoryMove("drafts", "archive"),
      fileMove("drafts/kept.md", "archive/kept.md"),
    ];

    expect(movedPath("drafts/kept.md", moves)).toBe("archive/kept.md");
    expect(movedPath("drafts", moves)).toBe("archive");
    // TD-18: a directory move carries only *independently proven* descendants. `ambiguous.md` has
    // no move of its own, so its identity did not follow the directory — inferring one here would
    // manufacture exactly the correlation the backend refused to make.
    expect(movedPath("drafts/ambiguous.md", moves)).toBeNull();
    expect(movedPath("untouched.md", moves)).toBeNull();
    expect(movedPath("drafts/kept.md", [])).toBeNull();
  });

  it("treats a case-only spelling change as a real move", () => {
    expect(movedPath("Draft.md", [fileMove("Draft.md", "draft.md")])).toBe("draft.md");
  });

  it("never matches a sibling whose path merely starts with a moved path", () => {
    const moves = [directoryMove("drafts", "archive")];

    expect(movedPath("drafts-old/kept.md", moves)).toBeNull();
    expect(movedPath("drafts.md", moves)).toBeNull();
  });
});

describe("movedSubtreePath", () => {
  it("carries a descendant's position under a proven directory move", () => {
    const moves = [directoryMove("drafts", "archive")];

    expect(movedSubtreePath("drafts", moves)).toBe("archive");
    expect(movedSubtreePath("drafts/deep/notes", moves)).toBe("archive/deep/notes");
    expect(movedSubtreePath("drafts-old/notes", moves)).toBeNull();
    expect(movedSubtreePath("elsewhere", moves)).toBeNull();
  });

  it("prefers a descendant's own proven move over its ancestor's", () => {
    const moves = [
      directoryMove("drafts", "archive"),
      directoryMove("drafts/pinned", "pinned"),
    ];

    expect(movedSubtreePath("drafts/pinned", moves)).toBe("pinned");
    expect(movedSubtreePath("drafts/pinned/deep", moves)).toBe("pinned/deep");
  });

  it("does not follow a file move as if it were a directory", () => {
    expect(movedSubtreePath("draft.md/child", [fileMove("draft.md", "final.md")])).toBeNull();
  });
});

describe("presentFilePaths", () => {
  it("collects every non-folder row in the whole hierarchy", () => {
    const present = presentFilePaths([
      file("readme.md"),
      directory("notes", [file("notes/outline.md"), directory("notes/deep", [file("notes/deep/a.md")])]),
    ]);

    expect([...present].sort()).toEqual(["notes/deep/a.md", "notes/outline.md", "readme.md"]);
    // A folder is not a file: a document whose path is now a directory no longer has a file there.
    expect(present.has("notes")).toBe(false);
  });

  it("counts a row that exists but cannot be read, and a row Cowrite would not open", () => {
    // Presence is only "is this path still occupied by this document's file" — an unreadable file
    // has not been deleted, and a non-Markdown file the rail lists as context is still a file. Both
    // would otherwise be reported Missing on disk, sending the user recovery actions for a file
    // that is right there (J2).
    const unreadable: Entry = { ...file("locked.md", "unknown"), warning: { kind: "unreadable", message: "no" } };

    const present = presentFilePaths([unreadable, file("source.txt"), file("link.md", "symlink")]);

    expect([...present].sort()).toEqual(["link.md", "locked.md", "source.txt"]);
  });
});

describe("undescendedPaths", () => {
  it("names every row the generation listed but did not enumerate beneath", () => {
    // Each of these is a row the backend publishes without descending: a directory whose read_dir
    // failed keeps a typed warning and no children, and a symlink, an `other`, or an `unknown` row
    // (metadata unreadable, so its shape is not even known) is listed as context and never walked.
    // `unknown` carries its warning because that is the only way the backend produces one: a row
    // whose `symlink_metadata` failed, so not even its shape is known (`unreadable_entry`).
    const opaque: Entry = {
      ...file("opaque", "unknown"),
      warning: { kind: "unreadable", message: "no" },
    };
    const undescended = undescendedPaths([
      unreadableDirectory("locked"),
      file("linked", "symlink"),
      file("socket", "other"),
      opaque,
      directory("notes", [file("notes/a.md"), unreadableDirectory("notes/locked")]),
    ]);

    expect([...undescended].sort()).toEqual([
      "linked",
      "locked",
      "notes/locked",
      "opaque",
      "socket",
    ]);
  });

  it("excludes files and directories the generation did enumerate", () => {
    // A file's empty children are proof (nothing lives beneath a file), not ignorance — including
    // an unreadable one, whose warning is about opening it, not about listing it. A directory that
    // read cleanly enumerated its whole subtree, which is what makes absence there evidence.
    const unreadableFile: Entry = {
      ...file("locked.md"),
      warning: { kind: "unreadable", message: "no" },
    };

    const undescended = undescendedPaths([
      unreadableFile,
      directory("notes", [file("notes/a.md"), directory("notes/deep", [file("notes/deep/b.md")])]),
    ]);

    expect([...undescended]).toEqual([]);
  });

  it("does not name a directory that is absent altogether", () => {
    // A deleted folder is not listed at all, so it cannot be a prefix here — which is exactly the
    // evidence that the documents under it really are missing (J2), not merely unenumerated.
    expect([...undescendedPaths([file("readme.md")])]).toEqual([]);
  });
});

describe("ancestorsOf", () => {
  it("names every folder that must be open for a row to be reachable", () => {
    expect(ancestorsOf("notes/very/deep/outline.md")).toEqual([
      "notes",
      "notes/very",
      "notes/very/deep",
    ]);
    expect(ancestorsOf("outline.md")).toEqual([]);
    expect(ancestorsOf("")).toEqual([]);
  });
});

describe("listenForProjectFilesRefreshes", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
  });

  it("hands every automatic-refresh transition through on the backend's own event", async () => {
    let emit: ((payload: unknown) => void) | undefined;
    const unlisten = vi.fn();
    listenForBackendEventMock.mockImplementation(
      (_name: string, cb: (payload: unknown) => void) => {
        emit = cb;
        return Promise.resolve(unlisten);
      },
    );

    const handler = vi.fn();
    const stop = await listenForProjectFilesRefreshes(handler);

    expect(listenForBackendEventMock).toHaveBeenCalledWith(
      PROJECT_FILES_EVENT,
      expect.any(Function),
    );
    // The three transitions exactly as Rust `ProjectFilesRefreshNotice` serializes them.
    const started = { status: "started" };
    const completed = {
      status: "completed",
      snapshot: { generation: 3, entries: [], moves: [] },
    };
    const failed = {
      status: "failed",
      error: {
        kind: "UpdateFailed",
        message: "enumeration could not complete",
      },
    };
    emit?.(started);
    emit?.(completed);
    emit?.(failed);

    expect(handler).toHaveBeenNthCalledWith(1, started);
    expect(handler).toHaveBeenNthCalledWith(2, completed);
    expect(handler).toHaveBeenNthCalledWith(3, failed);

    stop();
    expect(unlisten).toHaveBeenCalled();
  });

});
