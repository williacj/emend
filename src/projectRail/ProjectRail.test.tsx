// @vitest-environment jsdom
// ABOUTME: Pins J2's author-mode project-rail states, hierarchy, accessibility, and activation.
// ABOUTME: Refreshes retain trustworthy rows and never change the active document themselves.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ProjectRail, ProjectRailToggle } from "./ProjectRail";
import type { ProjectFileEntry, ProjectFilesSnapshot } from "./projectFiles";
import type { GroundingPayload } from "../stores/grounding";
import type { ProjectFilesRefreshNotice } from "../stores/project";

const SNAPSHOT: ProjectFilesSnapshot = {
  generation: 1,
  moves: [],
  entries: [
    {
      path: "notes",
      name: "notes",
      kind: "directory",
      warning: null,
      children: [
        {
          path: "notes/very/deep/outline.md",
          name: "outline.md",
          kind: "file",
          warning: null,
          children: [],
        },
        {
          path: "notes/source.pdf",
          name: "source.pdf",
          kind: "file",
          warning: null,
          children: [],
        },
      ],
    },
    {
      path: "private/very/deep/secrets.md",
      name: "secrets.md",
      kind: "unknown",
      warning: { kind: "unreadable", message: "permission denied" },
      children: [],
    },
  ],
};

function directory(path: string, children: ProjectFileEntry[]): ProjectFileEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "directory",
    warning: null,
    children,
  };
}

function markdown(path: string): ProjectFileEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "file",
    warning: null,
    children: [],
  };
}

function unreadable(path: string): ProjectFileEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "unknown",
    warning: { kind: "unreadable", message: "permission denied" },
    children: [],
  };
}

/** A hand-driven stand-in for the backend's automatic-refresh announcements (TD-18, #928). */
function announcer() {
  const unsubscribe = vi.fn();
  let handler: ((notice: ProjectFilesRefreshNotice) => void) | undefined;
  const subscribe = vi.fn(async (next: (notice: ProjectFilesRefreshNotice) => void) => {
    handler = next;
    return unsubscribe;
  });
  return {
    subscribe,
    unsubscribe,
    announce: (notice: ProjectFilesRefreshNotice) => handler?.(notice),
    mounted: () => handler !== undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("projectRail/ProjectRail", () => {
  it("D27 projects Documents and Skills without duplicate paths", async () => {
    const snapshot: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: [
        directory("drafts", [markdown("drafts/report.md"), markdown("drafts/notes.rs")]),
        directory(".claude", [
          directory(".claude/skills", [
            directory(".claude/skills/review", [
              markdown(".claude/skills/review/SKILL.md"),
              markdown(".claude/skills/review/reference.md"),
              directory(".claude/skills/review/nested", [
                markdown(".claude/skills/review/nested/SKILL.md"),
              ]),
              directory(".claude/skills/review/workflows", [
                markdown(".claude/skills/review/workflows/polish.md"),
              ]),
            ]),
          ]),
        ]),
      ],
    };
    render(
      <ProjectRail
        projectRoot="/project"
        activePath=".claude/skills/review/workflows/polish.md"
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(snapshot)}
        discover={vi.fn().mockResolvedValue({
          skills: [
            { name: "Review", description: "Review drafts.", path: ".claude/skills/review/SKILL.md" },
            { name: "Nested", description: "Inspect details.", path: ".claude/skills/review/nested/SKILL.md" },
          ],
          workflows: [
            { name: "polish", path: ".claude/skills/review/workflows/polish.md" },
          ],
          instructionFile: null,
        })}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "Project files" });
    expect(within(rail).getAllByRole("tree")).toHaveLength(1);
    expect(within(rail).getByText("DOCUMENTS")).toBeInTheDocument();
    expect(within(rail).getByText("SKILLS")).toBeInTheDocument();
    expect(await within(rail).findByText("WORKFLOWS")).toBeInTheDocument();
    expect(within(rail).getByRole("treeitem", { name: "drafts" })).toBeInTheDocument();
    expect(within(rail).queryByRole("treeitem", { name: "drafts/notes.rs" })).not.toBeInTheDocument();
    const reviewSkill = within(rail).getByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(reviewSkill);
    expect(reviewSkill).toHaveAttribute("aria-expanded", "true");
    expect(within(rail).getByRole("treeitem", { name: ".claude/skills/review/reference.md" })).toBeInTheDocument();
    const nestedSkill = within(rail).getByRole("treeitem", { name: /Nested.*Inspect details/ });
    expect(within(rail).queryByRole("treeitem", { name: ".claude/skills/review/nested/SKILL.md" })).not.toBeInTheDocument();
    fireEvent.click(nestedSkill);
    const workflow = within(rail).getByRole("treeitem", { name: /polish.*\.claude\/skills\/review\/workflows\/polish\.md/ });
    expect(workflow).not.toHaveAttribute("aria-expanded");
    expect(workflow).toHaveAttribute("aria-current", "page");
    expect(within(rail).getAllByRole("treeitem", { current: "page" })).toHaveLength(1);
    expect(within(rail).getAllByRole("treeitem", { name: ".claude/skills/review/SKILL.md" })).toHaveLength(1);
    expect(within(rail).getAllByRole("treeitem", { name: ".claude/skills/review/nested/SKILL.md" })).toHaveLength(1);
  });

  it("D27 retries unreadable skill material through its owning Skills section", async () => {
    const onOpen = vi.fn();
    const discover = vi.fn().mockResolvedValue({
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    });
    const refresh = vi.fn()
      .mockResolvedValueOnce({
        generation: 1,
        moves: [],
        entries: [directory("skills", [directory("skills/review", [
          markdown("skills/review/SKILL.md"),
          unreadable("skills/review/reference.md"),
        ])])],
      })
      .mockResolvedValueOnce({
        generation: 2,
        moves: [],
        entries: [directory("skills", [directory("skills/review", [
          markdown("skills/review/SKILL.md"),
          markdown("skills/review/reference.md"),
        ])])],
      });
    render(<ProjectRail projectRoot="/project" activePath={null} onOpen={onOpen} refresh={refresh} discover={discover} />);
    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(skill);
    const warning = screen.getByRole("treeitem", { name: /skills\/review\/reference\.md.*permission denied/ });
    fireEvent.click(warning);
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    const recovered = await screen.findByRole("treeitem", { name: "skills/review/reference.md" });
    fireEvent.click(recovered);
    expect(onOpen).toHaveBeenCalledWith("skills/review/reference.md");
  });

  it("D27 keeps an unreadable discovered workflow non-actionable until its Skills retry", async () => {
    const onOpen = vi.fn();
    const discovery: GroundingPayload = {
      skills: [],
      workflows: [{ name: "polish", path: "workflows/polish.md" }],
      instructionFile: null,
    };
    const discover = vi.fn().mockResolvedValue(discovery);
    const refresh = vi.fn()
      .mockResolvedValueOnce({
        generation: 1,
        moves: [],
        entries: [directory("workflows", [unreadable("workflows/polish.md")])],
      })
      .mockResolvedValueOnce({
        generation: 2,
        moves: [],
        entries: [directory("workflows", [markdown("workflows/polish.md")])],
      });
    render(<ProjectRail projectRoot="/project" activePath={null} onOpen={onOpen} refresh={refresh} discover={discover} />);
    const warning = await screen.findByRole("treeitem", { name: /workflows\/polish\.md.*permission denied/ });
    expect(screen.getAllByRole("treeitem", { name: /workflows\/polish\.md/ })).toHaveLength(1);
    fireEvent.click(warning);
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    const recovered = await screen.findByRole("treeitem", { name: /polish.*workflows\/polish\.md/ });
    fireEvent.click(recovered);
    expect(onOpen).toHaveBeenCalledWith("workflows/polish.md");
  });

  it("D27 reveals an active document when discovery moves it under a Skill", async () => {
    const pendingDiscovery = deferred<GroundingPayload>();
    render(
      <ProjectRail
        projectRoot="/project"
        activePath="skills/review/SKILL.md"
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue({
          generation: 1,
          moves: [],
          entries: [directory("skills", [directory("skills/review", [markdown("skills/review/SKILL.md")])])],
        })}
        discover={vi.fn(() => pendingDiscovery.promise)}
      />,
    );

    const before = await screen.findByRole("treeitem", { name: "skills/review/SKILL.md" });
    expect(before).toHaveAttribute("aria-current", "page");
    pendingDiscovery.resolve({
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    });
    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    await waitFor(() => expect(skill).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("treeitem", { name: "skills/review/SKILL.md" })).toHaveAttribute("aria-current", "page");
  });

  it("D27 keeps one roving keyboard tree across sections", async () => {
    const onOpen = vi.fn();
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={onOpen}
        refresh={vi.fn().mockResolvedValue({
          generation: 1,
          moves: [],
          entries: [markdown("readme.md"), directory("skills", [directory("skills/review", [markdown("skills/review/SKILL.md")])])],
        })}
        discover={vi.fn().mockResolvedValue({
          skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
          workflows: [{ name: "polish", path: "workflows/polish.md" }],
          instructionFile: null,
        })}
      />,
    );

    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    const readme = screen.getByRole("treeitem", { name: "readme.md" });
    const workflow = screen.getByRole("treeitem", { name: /polish.*workflows\/polish\.md/ });
    const tree = screen.getByRole("tree", { name: "Project files" });
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toEqual([readme]);

    readme.focus();
    fireEvent.keyDown(readme, { key: "ArrowDown" });
    expect(document.activeElement).toBe(skill);
    fireEvent.keyDown(skill, { key: "ArrowRight" });
    expect(skill).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(skill, { key: "ArrowRight" });
    const material = screen.getByRole("treeitem", { name: "skills/review/SKILL.md" });
    expect(document.activeElement).toBe(material);
    fireEvent.keyDown(material, { key: "End" });
    expect(document.activeElement).toBe(workflow);
    fireEvent.keyDown(workflow, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("workflows/polish.md");
    fireEvent.keyDown(workflow, { key: "Home" });
    expect(document.activeElement).toBe(readme);
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toEqual([readme]);
  });

  it("D27 keeps Documents and Skills lifecycle states independent", async () => {
    const firstSkills = deferred<GroundingPayload>();
    const retriedSkills = deferred<GroundingPayload>();
    const updatedSkills = deferred<GroundingPayload>();
    const updatedDocuments = deferred<ProjectFilesSnapshot>();
    const discovery: GroundingPayload = {
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    };
    const discover = vi.fn()
      .mockImplementationOnce(() => firstSkills.promise)
      .mockImplementationOnce(() => retriedSkills.promise)
      .mockImplementationOnce(() => updatedSkills.promise);
    const refresh = vi.fn()
      .mockResolvedValueOnce({ generation: 1, moves: [], entries: [markdown("readme.md")] })
      .mockImplementationOnce(() => updatedDocuments.promise);
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={vi.fn()}
        refresh={refresh}
        discover={discover}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: "readme.md" })).toBeInTheDocument();
    expect(screen.getByText("Finding skills and workflows…")).toBeInTheDocument();
    firstSkills.reject(new Error("discovery failed"));
    const failedSkills = await screen.findByRole("status");
    expect(failedSkills).toHaveTextContent("Couldn’t update skills");
    expect(screen.queryByText("No skills found")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "readme.md" })).toBeInTheDocument();

    fireEvent.click(within(failedSkills).getByRole("button", { name: "Try again" }));
    retriedSkills.resolve(discovery);
    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh project files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Updating documents…")).toBeInTheDocument();
    expect(screen.getByText("Updating skills…")).toBeInTheDocument();
    expect(skill).toBeInTheDocument();

    updatedSkills.resolve(discovery);
    updatedDocuments.reject({ kind: "UpdateFailed", message: "scan interrupted" });
    const failedDocuments = await screen.findByRole("status");
    expect(failedDocuments).toHaveTextContent("Couldn’t update documents");
    expect(screen.getByRole("treeitem", { name: "readme.md" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Review.*Review drafts/ })).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t update skills")).not.toBeInTheDocument();
  });

  it("D27 retains skill material while its discovery update fails after Documents advances", async () => {
    const updatingSkills = deferred<GroundingPayload>();
    const discovery: GroundingPayload = {
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    };
    const first: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: [directory("skills", [directory("skills/review", [
        markdown("skills/review/SKILL.md"),
        markdown("skills/review/old.md"),
      ])])],
    };
    const second: ProjectFilesSnapshot = {
      generation: 2,
      moves: [],
      entries: [directory("skills", [directory("skills/review", [
        markdown("skills/review/SKILL.md"),
        markdown("skills/review/new.md"),
      ])])],
    };
    const discover = vi.fn()
      .mockResolvedValueOnce(discovery)
      .mockImplementationOnce(() => updatingSkills.promise)
      .mockResolvedValueOnce(discovery);
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)}
        discover={discover}
      />,
    );
    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(skill);
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    expect(await screen.findByText("Updating skills…")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "skills/review/new.md" })).not.toBeInTheDocument();

    updatingSkills.reject(new Error("discovery failed"));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Couldn’t update skills");
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    fireEvent.click(within(status).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("treeitem", { name: "skills/review/new.md" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "skills/review/old.md" })).not.toBeInTheDocument();
  });

  it("D27 waits for Skills success after a Documents retry and automatic generation", async () => {
    const bus = announcer();
    const pendingDiscovery = deferred<GroundingPayload>();
    const discovery: GroundingPayload = {
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    };
    const source = (generation: number, material: string): ProjectFilesSnapshot => ({
      generation,
      moves: [],
      entries: [directory("skills", [directory("skills/review", [
        markdown("skills/review/SKILL.md"),
        markdown(`skills/review/${material}`),
      ])])],
    });
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValueOnce(source(1, "old.md"))
          .mockResolvedValueOnce(source(2, "new.md"))}
        discover={vi.fn().mockResolvedValueOnce(discovery)
          .mockResolvedValueOnce(discovery)
          .mockImplementationOnce(() => pendingDiscovery.promise)}
        subscribe={bus.subscribe}
      />,
    );
    const skill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(skill);
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    await waitFor(() => expect(bus.mounted()).toBe(true));
    bus.announce({ status: "failed", error: { kind: "UpdateFailed", message: "scan failed" } });
    const failedDocuments = await screen.findByRole("status");
    fireEvent.click(within(failedDocuments).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Updating documents…")).not.toBeInTheDocument());
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "skills/review/new.md" })).not.toBeInTheDocument();

    bus.announce({ status: "completed", snapshot: source(3, "latest.md") });
    expect(await screen.findByText("Updating skills…")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "skills/review/old.md" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "skills/review/latest.md" })).not.toBeInTheDocument();
    pendingDiscovery.resolve(discovery);
    expect(await screen.findByRole("treeitem", { name: "skills/review/latest.md" })).toBeInTheDocument();
  });

  it("D27 reconciles new skill material when Skills finishes before Documents", async () => {
    const updatingDocuments = deferred<ProjectFilesSnapshot>();
    const movedSkill: GroundingPayload = {
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/edited/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    };
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn()
          .mockResolvedValueOnce({
            generation: 1,
            moves: [],
            entries: [directory("skills", [directory("skills/review", [markdown("skills/review/SKILL.md")])])],
          })
          .mockImplementationOnce(() => updatingDocuments.promise)}
        discover={vi.fn()
          .mockResolvedValueOnce({
            skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
            workflows: [],
            instructionFile: null,
          })
          .mockResolvedValueOnce(movedSkill)}
      />,
    );
    await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Review.*Review drafts/ }))
      .toHaveAttribute("title", "skills/edited/SKILL.md"));
    updatingDocuments.resolve({
      generation: 2,
      moves: [{ old_path: "skills/review", new_path: "skills/edited", kind: "directory" }],
      entries: [directory("skills", [directory("skills/edited", [
        markdown("skills/edited/SKILL.md"),
        markdown("skills/edited/reference.md"),
      ])])],
    });
    const skill = screen.getByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(skill);
    expect(await screen.findByRole("treeitem", { name: "skills/edited/reference.md" }))
      .toBeInTheDocument();
  });

  it("D27 keeps a skill disclosure open across a correlated directory move", async () => {
    const movedDiscovery = deferred<GroundingPayload>();
    const discover = vi.fn()
      .mockResolvedValueOnce({
        skills: [{ name: "Review", description: "Review drafts.", path: "skills/review/SKILL.md" }],
        workflows: [],
        instructionFile: null,
      })
      .mockImplementationOnce(() => movedDiscovery.promise)
      .mockResolvedValueOnce({
        skills: [
          { name: "Review", description: "Review drafts.", path: "skills/edited/SKILL.md" },
          { name: "New", description: "New skill.", path: "skills/review/SKILL.md" },
        ],
        workflows: [],
        instructionFile: null,
      });
    render(
      <ProjectRail
        projectRoot="/project"
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn()
          .mockResolvedValueOnce({
            generation: 1,
            moves: [],
            entries: [directory("skills", [directory("skills/review", [markdown("skills/review/SKILL.md")])])],
          })
          .mockResolvedValueOnce({
            generation: 2,
            moves: [{ old_path: "skills/review", new_path: "skills/edited", kind: "directory" }],
            entries: [directory("skills", [directory("skills/edited", [markdown("skills/edited/SKILL.md")])])],
          })
          .mockResolvedValueOnce({
            generation: 3,
            moves: [],
            entries: [directory("skills", [
              directory("skills/edited", [markdown("skills/edited/SKILL.md")]),
              directory("skills/review", [markdown("skills/review/SKILL.md")]),
            ])],
          })}
        discover={discover}
      />,
    );
    const oldSkill = await screen.findByRole("treeitem", { name: /Review.*Review drafts/ });
    fireEvent.click(oldSkill);
    expect(oldSkill).toHaveAttribute("aria-expanded", "true");
    oldSkill.focus();
    expect(document.activeElement).toBe(oldSkill);
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    expect(await screen.findByText("Updating skills…")).toBeInTheDocument();
    expect(oldSkill).toHaveAttribute("aria-expanded", "true");
    movedDiscovery.resolve({
      skills: [{ name: "Review", description: "Review drafts.", path: "skills/edited/SKILL.md" }],
      workflows: [],
      instructionFile: null,
    });
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Review.*Review drafts/ }))
      .toHaveAttribute("title", "skills/edited/SKILL.md"));
    const movedSkill = screen.getByRole("treeitem", { name: /Review.*Review drafts/ });
    expect(movedSkill).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(movedSkill);
    expect(screen.getByRole("treeitem", { name: "skills/edited/SKILL.md" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh project files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    const newSkill = await screen.findByRole("treeitem", { name: "New. New skill." });
    expect(newSkill).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("treeitem", { name: /Review.*Review drafts/ }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("renders the 3a and 3b files-rail structure and platform controls", async () => {
    const first = deferred<ProjectFilesSnapshot>();
    const { rerender } = render(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={vi.fn()}
        platform="win"
        refresh={vi.fn(() => first.promise)}
      />,
    );

    const winRail = await screen.findByRole("complementary", { name: "Project files" });
    expect(winRail).toHaveAttribute("data-platform", "win");
    expect(within(winRail).getByText("DOCUMENTS")).toBeInTheDocument();
    expect(within(winRail).getByRole("button", { name: "Refresh project files" })).toContainElement(
      within(winRail).getByRole("button", { name: "Refresh project files" }).querySelector("svg"),
    );
    expect(within(winRail).getByRole("button", { name: "Hide project files" })).toContainElement(
      within(winRail).getByRole("button", { name: "Hide project files" }).querySelector("svg"),
    );
    first.resolve(SNAPSHOT);
    // No click to expand: the active document's own ancestors are revealed for it (see the reveal
    // suite below), which is what makes the marked row reachable here.
    const notes = await within(winRail).findByRole("treeitem", { name: "notes" });
    await waitFor(() => expect(notes).toHaveAttribute("aria-expanded", "true"));
    const active = within(winRail).getByRole("treeitem", {
      name: "notes/very/deep/outline.md",
    });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector(".project-rail__active-dot")).not.toBeNull();
    expect(within(winRail).getByText("Refresh to check for changes")).toBeInTheDocument();
    expect(winRail).not.toHaveTextContent(/[▾▸◇⟳‹›]/);

    rerender(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={vi.fn()}
        platform="mac"
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
      />,
    );
    const macRail = screen.getByRole("complementary", { name: "Project files" });
    expect(macRail).toHaveAttribute("data-platform", "mac");
    expect(within(macRail).queryByRole("button", { name: "Hide project files" })).not.toBeInTheDocument();

  });

  it("gives the macOS title bar a labeled files-rail collapse affordance", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = render(
      <ProjectRailToggle collapsed={false} onCollapsedChange={onCollapsedChange} />,
    );

    const hide = screen.getByRole("button", { name: "Hide project files" });
    expect(hide).toContainElement(hide.querySelector("svg"));
    fireEvent.click(hide);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(<ProjectRailToggle collapsed onCollapsedChange={onCollapsedChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Show project files" }));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it("shows Loading before the first completed snapshot, then preserves hierarchy and path context", async () => {
    const first = deferred<ProjectFilesSnapshot>();
    const refresh = vi.fn(() => first.promise);
    render(<ProjectRail activePath={null} onOpen={vi.fn()} refresh={refresh} />);

    expect(screen.getByText("Loading documents…")).toBeInTheDocument();
    first.resolve(SNAPSHOT);

    const folder = await screen.findByRole("treeitem", { name: "notes" });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(folder);

    const markdown = screen.getByRole("treeitem", { name: "notes/very/deep/outline.md" });
    expect(markdown).toHaveAttribute("title", "notes/very/deep/outline.md");
    expect(screen.queryByRole("treeitem", { name: "notes/source.pdf" })).not.toBeInTheDocument();
  });

  it("exposes one tree whose nested groups carry correct depth and sibling positions", async () => {
    const nested: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: [
        directory("drafts", [
          directory("drafts/sermons", [
            markdown("drafts/sermons/first.md"),
            markdown("drafts/sermons/second.md"),
          ]),
          markdown("drafts/notes.md"),
        ]),
        markdown("readme.md"),
      ],
    };
    render(
      <ProjectRail
        activePath="drafts/sermons/second.md"
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(nested)}
      />,
    );

    await screen.findByText("second.md");
    expect(screen.getAllByRole("tree")).toHaveLength(1);
    expect(screen.getByRole("tree", { name: "Project files" })).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(2);

    const drafts = screen.getByRole("treeitem", { name: "drafts" });
    expect(drafts).toHaveAttribute("aria-level", "1");
    expect(drafts).toHaveAttribute("aria-setsize", "2");
    expect(drafts).toHaveAttribute("aria-posinset", "1");
    expect(drafts).toHaveAttribute("aria-expanded", "true");

    const sermons = screen.getByRole("treeitem", { name: "drafts/sermons" });
    expect(sermons).toHaveAttribute("aria-level", "2");
    expect(sermons).toHaveAttribute("aria-setsize", "2");
    expect(sermons).toHaveAttribute("aria-posinset", "2");
    expect(sermons).toHaveAttribute("aria-expanded", "true");

    const second = screen.getByRole("treeitem", { name: "drafts/sermons/second.md" });
    expect(second).toHaveAttribute("aria-level", "3");
    expect(second).toHaveAttribute("aria-setsize", "2");
    expect(second).toHaveAttribute("aria-posinset", "2");
    expect(second).not.toHaveAttribute("aria-expanded");
  });

  it("presents exactly one tree tab stop even with expanded and retryable rows", async () => {
    render(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
      />,
    );

    const tree = await screen.findByRole("tree");
    await screen.findByText("outline.md");
    const tabStops = Array.from(
      tree.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
      ),
    );
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]).toHaveAttribute("role", "treeitem");
  });

  it("prunes folders without documents until a document appears beneath them", async () => {
    const bus = announcer();
    const emptyCases = [
      { path: "empty-right", key: "ArrowRight" },
      { path: "empty-enter", key: "Enter" },
      { path: "empty-space", key: " " },
    ] as const;
    const emptyPaths = emptyCases.map(({ path }) => path);
    const emptyDirectory: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: emptyPaths.map((path) => directory(path, [])),
    };
    render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(emptyDirectory)}
        subscribe={bus.subscribe}
      />,
    );

    expect(await screen.findByText("No documents yet — this project may contain other file types")).toBeInTheDocument();
    for (const { path } of emptyCases) {
      expect(screen.queryByRole("treeitem", { name: path })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    await waitFor(() => expect(bus.mounted()).toBe(true));

    bus.announce({
      status: "completed",
      snapshot: {
        generation: 2,
        moves: [],
        entries: emptyPaths.map((path) =>
          directory(path, [markdown(`${path}/now-present.md`)]),
        ),
      },
    });

    await waitFor(() => {
      for (const path of emptyPaths) {
        expect(screen.getByRole("treeitem", { name: path })).toHaveAttribute(
          "aria-expanded",
          "false",
        );
      }
    });
    for (const { path, key } of emptyCases) {
      const row = screen.getByRole("treeitem", { name: path });
      row.focus();
      fireEvent.keyDown(row, { key });
      expect(row).toHaveAttribute("aria-expanded", key === "ArrowRight" || key === "Enter" || key === " " ? "true" : "false");
    }
    expect(screen.getAllByText("now-present.md").length).toBeGreaterThan(0);
  });

  it("implements the visible-row arrow Home End and activation keyboard contract", async () => {
    const onOpen = vi.fn();
    const nested: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: [
        directory("drafts", [
          directory("drafts/sermons", [
            markdown("drafts/sermons/first.md"),
            markdown("drafts/sermons/second.md"),
          ]),
          markdown("drafts/notes.md"),
        ]),
        markdown("readme.md"),
      ],
    };
    render(
      <ProjectRail activePath={null} onOpen={onOpen} refresh={vi.fn().mockResolvedValue(nested)} />,
    );

    const drafts = await screen.findByRole("treeitem", { name: "drafts" });
    drafts.focus();
    fireEvent.keyDown(drafts, { key: "ArrowRight" });
    expect(drafts).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(drafts);

    fireEvent.keyDown(drafts, { key: "ArrowRight" });
    const sermons = screen.getByRole("treeitem", { name: "drafts/sermons" });
    const notes = screen.getByRole("treeitem", { name: "drafts/notes.md" });
    expect(document.activeElement).toBe(notes);
    fireEvent.keyDown(notes, { key: "ArrowDown" });
    expect(document.activeElement).toBe(sermons);
    fireEvent.keyDown(sermons, { key: "ArrowRight" });
    expect(sermons).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(sermons, { key: "ArrowRight" });

    const first = screen.getByRole("treeitem", { name: "drafts/sermons/first.md" });
    const second = screen.getByRole("treeitem", { name: "drafts/sermons/second.md" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });

    const readme = screen.getByRole("treeitem", { name: "readme.md" });
    expect(document.activeElement).toBe(readme);
    fireEvent.keyDown(readme, { key: "Home" });
    expect(document.activeElement).toBe(drafts);

    fireEvent.keyDown(drafts, { key: "ArrowRight" });
    expect(document.activeElement).toBe(notes);
    fireEvent.keyDown(notes, { key: "ArrowDown" });
    expect(document.activeElement).toBe(sermons);
    fireEvent.keyDown(sermons, { key: "ArrowLeft" });
    expect(sermons).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(sermons, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(drafts);

    fireEvent.keyDown(drafts, { key: " " });
    expect(drafts).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(drafts, { key: "Enter" });
    expect(drafts).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(drafts, { key: "End" });
    fireEvent.keyDown(readme, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("readme.md");
  });

  it("opens only owned document rows and marks only the confirmed active path", async () => {
    const onOpen = vi.fn();
    render(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={onOpen}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
      />,
    );
    // Already revealed, because the active document lives inside it.
    await screen.findByRole("treeitem", { name: "notes" });

    const markdown = await screen.findByRole("treeitem", { name: "notes/very/deep/outline.md" });
    expect(markdown).toHaveAttribute("aria-current", "page");
    fireEvent.click(markdown);
    expect(onOpen).toHaveBeenCalledWith("notes/very/deep/outline.md");
    expect(screen.queryByRole("button", { name: "notes/source.pdf" })).not.toBeInTheDocument();
  });

  it("collapses to a labeled restore control without losing folder expansion", async () => {
    render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "notes" }));
    expect(screen.getByText("outline.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide project files" }));
    expect(screen.queryByText("outline.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show project files" }));
    expect(screen.getByText("outline.md")).toBeInTheDocument();
  });

  it("retains the last completed rows while Updating and after an update failure", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
    document.head.append(style);
    onTestFinished(() => style.remove());
    const second = deferred<ProjectFilesSnapshot>();
    const retry = deferred<ProjectFilesSnapshot>();
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(SNAPSHOT)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => retry.promise);
    render(<ProjectRail activePath={null} onOpen={vi.fn()} refresh={refresh} />);
    await screen.findByRole("treeitem", { name: "notes" });
    const tree = screen.getByRole("tree", { name: "Project files" });
    expect(getComputedStyle(tree).opacity).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    const updatingStatus = screen.getByText("Updating documents…");
    expect(updatingStatus).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "notes" })).toBeInTheDocument();
    expect(getComputedStyle(screen.getByRole("treeitem", { name: "notes" })).opacity).toBe("0.55");
    expect(Boolean(tree.compareDocumentPosition(updatingStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(getComputedStyle(updatingStatus).fontSize).toBe("11.5px");

    second.reject({ kind: "UpdateFailed", message: "scan interrupted" });
    const failedStatus = await screen.findByText("Couldn’t update documents");
    expect(failedStatus).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "notes" })).toBeInTheDocument();
    expect(getComputedStyle(screen.getByRole("treeitem", { name: "notes" })).opacity).toBe("0.55");
    expect(getComputedStyle(screen.getByRole("status")).opacity).toBe("1");
    expect(Boolean(tree.compareDocumentPosition(failedStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(getComputedStyle(failedStatus).fontSize).toBe("11.5px");
    expect(
      within(screen.getByRole("status")).getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("Couldn’t update documents")).not.toBeInTheDocument();
    expect(screen.getByText("Updating documents…")).toBeInTheDocument();
    retry.resolve(SNAPSHOT);
    await waitFor(() => expect(getComputedStyle(screen.getByRole("treeitem", { name: "notes" })).opacity).toBe("1"));
  });

  it("distinguishes an empty project from an unavailable project", async () => {
    const { rerender } = render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue({ generation: 1, entries: [], moves: [] })}
      />,
    );
    expect(await screen.findByText("No documents yet — this project may contain other file types")).toBeInTheDocument();

    rerender(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockRejectedValue({
          kind: "ProjectUnavailable",
          message: "root disappeared",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    expect(await screen.findByText("Project files unavailable")).toBeInTheDocument();
    expect(screen.getByText("root disappeared")).toBeInTheDocument();
  });

  it("keeps an unreadable row visible, non-actionable, and retryable", async () => {
    const refresh = vi.fn().mockResolvedValue(SNAPSHOT);
    render(<ProjectRail activePath={null} onOpen={vi.fn()} refresh={refresh} />);

    const warning = await screen.findByText("secrets.md");
    const row = warning.closest('[role="treeitem"]');
    expect(row).not.toBeNull();
    expect(
      screen.getByRole("treeitem", { name: /private\/very\/deep\/secrets\.md/ }),
    ).toHaveAttribute("title", "private/very/deep/secrets.md");
    expect(within(row as HTMLElement).getByText("permission denied")).toBeInTheDocument();
    fireEvent.click(within(row as HTMLElement).getByText("Try again"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("paints a background addition under its existing ancestors without expanding or activating anything", async () => {
    const bus = announcer();
    const onOpen = vi.fn();
    render(
      <ProjectRail
        activePath={null}
        onOpen={onOpen}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
        subscribe={bus.subscribe}
      />,
    );
    const folder = await screen.findByRole("treeitem", { name: "notes" });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(bus.mounted()).toBe(true));

    bus.announce({ status: "started" });
    expect(await screen.findByText("Updating documents…")).toBeInTheDocument();

    bus.announce({
      status: "completed",
      snapshot: {
        generation: 2,
        moves: [],
        entries: [directory("notes", [markdown("notes/agent-wrote-this.md")])],
      },
    });

    await waitFor(() => expect(screen.queryByText("Updating documents…")).not.toBeInTheDocument());
    // The row exists in the generation but stays behind its collapsed ancestor: an addition the
    // user did not ask for never opens a folder, moves the marker, or opens a document (J2).
    expect(screen.getByRole("treeitem", { name: "notes" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("agent-wrote-this.md")).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reveals the ancestors of the document that just became active, without taking focus or scrolling", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const deep: ProjectFilesSnapshot = {
      generation: 1,
      moves: [],
      entries: [
        directory("notes", [
          directory("notes/very", [
            directory("notes/very/deep", [markdown("notes/very/deep/outline.md")]),
          ]),
        ]),
      ],
    };
    const first = deferred<ProjectFilesSnapshot>();
    const refresh = vi.fn(() => first.promise);
    const { rerender } = render(
      <ProjectRail activePath={null} onOpen={vi.fn()} refresh={refresh} />,
    );
    const refreshButton = await screen.findByRole("button", { name: "Refresh project files" });
    expect(refreshButton).toBeDisabled();
    // The header is present before the initial refresh settles. Wait on a snapshot-derived row so
    // focus is established only after the button is enabled, independent of runner load (#1608).
    first.resolve(deep);
    await screen.findByRole("treeitem", { name: "notes" });
    expect(refreshButton).toBeEnabled();
    refreshButton.focus();
    // jsdom leaves a focused button focused when it becomes disabled, unlike Chromium. Reproduce
    // the browser boundary so a refresh accidentally started by this reveal loses focus here too.
    const browserFocusBoundary = new MutationObserver(() => {
      if (refreshButton.hasAttribute("disabled")) {
        document.body.tabIndex = -1;
        document.body.focus();
      }
    });
    browserFocusBoundary.observe(refreshButton, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    onTestFinished(() => {
      browserFocusBoundary.disconnect();
      document.body.removeAttribute("tabindex");
    });
    expect(screen.queryByText("outline.md")).not.toBeInTheDocument();

    rerender(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={vi.fn()}
        refresh={refresh}
      />,
    );

    const row = await screen.findByRole("treeitem", { name: "notes/very/deep/outline.md" });
    // Changing the active document is disclosure-only. In particular it must not look like a new
    // refresh request: disabling this focused control is enough for Chromium to move focus to body.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(row).toHaveAttribute("aria-current", "page");
    for (const ancestor of ["notes", "notes/very", "notes/very/deep"]) {
      expect(screen.getByRole("treeitem", { name: ancestor })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    }
    // Revealing a row is a disclosure, not a navigation: keyboard focus and the editor/timeline
    // scroll position both belong to whatever the user was doing.
    expect(document.activeElement).toBe(refreshButton);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("carries folder expansion to a correlated move and reports the generation once for document identity", async () => {
    const bus = announcer();
    const onGeneration = vi.fn();
    render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
        subscribe={bus.subscribe}
        onGeneration={onGeneration}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "notes" }));
    expect(screen.getByText("outline.md")).toBeInTheDocument();
    await waitFor(() => expect(bus.mounted()).toBe(true));

    // The first load is itself a completed generation and is reported as one: its enumeration is
    // what tells the tab layer which open documents still have a file (#933), so "only generations
    // carrying moves are announced" would leave a deletion — which carries none — unreported.
    await waitFor(() => expect(onGeneration).toHaveBeenCalledTimes(1));
    expect(onGeneration).toHaveBeenLastCalledWith(SNAPSHOT);

    const moves = [
      { old_path: "notes", new_path: "archive", kind: "directory" as const },
      {
        old_path: "notes/very/deep/outline.md",
        new_path: "archive/very/deep/outline.md",
        kind: "file" as const,
      },
    ];
    const moved_snapshot = {
      generation: 2,
      moves,
      entries: [directory("archive", [markdown("archive/very/deep/outline.md")])],
    };
    bus.announce({ status: "completed", snapshot: moved_snapshot });

    const moved = await screen.findByRole("treeitem", { name: "archive" });
    expect(moved).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("treeitem", { name: "archive/very/deep/outline.md" }),
    ).toBeInTheDocument();
    expect(onGeneration).toHaveBeenCalledTimes(2);
    expect(onGeneration).toHaveBeenLastCalledWith(moved_snapshot);
  });

  it("keeps the completed tree when an announced refresh fails, and applies the retried move once", async () => {
    const bus = announcer();
    const onGeneration = vi.fn();
    const moves = [{ old_path: "notes", new_path: "archive", kind: "directory" as const }];
    const committed: ProjectFilesSnapshot = {
      generation: 2,
      moves,
      entries: [directory("archive", [markdown("archive/very/deep/outline.md")])],
    };
    const refresh = vi.fn().mockResolvedValueOnce(SNAPSHOT).mockResolvedValue(committed);
    render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={refresh}
        subscribe={bus.subscribe}
        onGeneration={onGeneration}
      />,
    );
    await screen.findByRole("treeitem", { name: "notes" });
    await waitFor(() => expect(bus.mounted()).toBe(true));

    // TD-18: a rekey the backend could not commit reports `UpdateFailed` and retains both the last
    // completed generation and the candidate — the tree the user is looking at must not change.
    bus.announce({
      status: "failed",
      error: { kind: "UpdateFailed", message: "history rekey failed" },
    });
    expect(await screen.findByText("Couldn’t update documents")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "notes" })).toBeInTheDocument();
    // Only the first load has been reported: a *failed* refresh completes no generation at all, so
    // nothing about document identity may be concluded from it.
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenLastCalledWith(SNAPSHOT);

    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Try again" }));
    await screen.findByRole("treeitem", { name: "archive" });
    expect(screen.queryByText("Couldn’t update documents")).not.toBeInTheDocument();
    expect(onGeneration).toHaveBeenCalledTimes(2);
    expect(onGeneration).toHaveBeenLastCalledWith(committed);

    // The very same generation also arrives on the announcement channel, as it does in production
    // whenever a native event re-drives the service. One generation is one transition: rekeying a
    // second time would move a document that has already moved.
    bus.announce({ status: "completed", snapshot: committed });
    await waitFor(() => expect(onGeneration).toHaveBeenCalledTimes(2));
  });

  it("ignores an announced generation that is not newer than the one on screen", async () => {
    const bus = announcer();
    const onGeneration = vi.fn();
    render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue({ ...SNAPSHOT, generation: 4 })}
        subscribe={bus.subscribe}
        onGeneration={onGeneration}
      />,
    );
    await screen.findByRole("treeitem", { name: "notes" });
    await waitFor(() => expect(bus.mounted()).toBe(true));

    bus.announce({
      status: "completed",
      snapshot: {
        generation: 3,
        moves: [{ old_path: "notes", new_path: "archive", kind: "directory" }],
        entries: [directory("archive", [])],
      },
    });

    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "notes" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("treeitem", { name: "archive" })).not.toBeInTheDocument();
    // The stale generation is dropped whole — it reaches document identity no more than it reaches
    // the tree, so an open tab absent from *its* enumeration is not concluded to be missing either.
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenLastCalledWith({ ...SNAPSHOT, generation: 4 });
  });

  it("stops listening when the rail unmounts", async () => {
    const bus = announcer();
    const { unmount } = render(
      <ProjectRail
        activePath={null}
        onOpen={vi.fn()}
        refresh={vi.fn().mockResolvedValue(SNAPSHOT)}
        subscribe={bus.subscribe}
      />,
    );
    await waitFor(() => expect(bus.mounted()).toBe(true));

    unmount();

    await waitFor(() => expect(bus.unsubscribe).toHaveBeenCalled());
  });

  it("refresh never activates or changes a document", async () => {
    const onOpen = vi.fn();
    const refresh = vi.fn().mockResolvedValue(SNAPSHOT);
    render(
      <ProjectRail
        activePath="notes/very/deep/outline.md"
        onOpen={onOpen}
        refresh={refresh}
      />,
    );
    await screen.findByRole("treeitem", { name: "notes" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// #2230: `projectFilesError` was the second of four independent readers of a rejected call's
// message and now routes through `backend.errorDetail`, keeping its own "The project could not be
// scanned." as an explicit fallback argument. The rendered claim is that NOTHING here changes: the
// fallback branch always yields `kind: "UpdateFailed"`, and the UpdateFailed banner renders the
// fixed "Couldn't update files" wording — `error.message` reaches the screen only on the
// `ProjectUnavailable` branch, which only the typed-`kind` check above produces and this card does
// not touch. The axis varied is the rejection's SHAPE (typed ProjectUnavailable, typed
// UpdateFailed, thrown Error, bare string, duck-typed {message}, message-less object); the axis
// held fixed is that all six arrive through the same `refresh()` rejection.
describe("projectRail/ProjectRail — one reader of a rejected refresh's message (#2230, FR-X-5)", () => {
  async function bannerAfterRejecting(
    rejection: unknown,
  ): Promise<{ banner: HTMLElement; unmount: () => void }> {
    const failing = deferred<ProjectFilesSnapshot>();
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(SNAPSHOT)
      .mockImplementationOnce(() => failing.promise);
    const { unmount } = render(<ProjectRail activePath={null} onOpen={vi.fn()} refresh={refresh} />);
    await screen.findByRole("treeitem", { name: "notes" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh project files" }));
    failing.reject(rejection);
    await screen.findByRole("status");
    return { banner: screen.getByRole("status"), unmount };
  }

  it("keeps the typed ProjectUnavailable rejection's own message on the unavailable panel", async () => {
    const { banner } = await bannerAfterRejecting({
      kind: "ProjectUnavailable",
      message: "the project folder was moved",
    });
    expect(banner.textContent).toContain("Project files unavailable");
    expect(banner.textContent).toContain("the project folder was moved");
  });

  // Every shape the typed check does not recognise lands on the same UpdateFailed banner, whose
  // wording carries no detail at all — so the reader swap is invisible here by construction.
  // One literal-titled case sweeping the shapes rather than the `it.each` used elsewhere in this
  // file: `scripts/check-test-matrix.mjs` resolves a matrix id against literal source text, and an
  // `it.each` title is built by interpolation, so the row naming this would resolve to nothing
  // (#1239's JS_DYNAMIC_TITLE_HINT is exactly this case).
  it("renders the same detail-free Couldn’t update documents banner for every unrecognised rejection shape", async () => {
    const shapes: unknown[] = [
      { kind: "UpdateFailed", message: "scan interrupted" },
      new Error("the IPC bridge went away"),
      "the IPC bridge went away",
      { message: "the IPC bridge went away" },
      {},
      undefined,
    ];
    for (const rejection of shapes) {
      const { banner, unmount } = await bannerAfterRejecting(rejection);
      // The WHOLE banner text, not a set of `not.toContain` guards. Three negatives inside one
      // sweep cannot each discriminate: the first shape to leak reddens the loop and masks the rest,
      // so an adjudicating mutation proves at most one of them (#2230's own `--adjudicate` run
      // reported exactly that). One exact string is unmaskable and says the same thing — no detail
      // reaches this banner for any shape, so which reader produced `ProjectFilesError.message` on
      // this branch is invisible to the user by construction.
      expect(banner.textContent).toBe("Couldn’t update documentsTry again");
      expect(within(banner).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      unmount();
    }
  });
});
