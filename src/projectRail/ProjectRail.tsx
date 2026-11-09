// ABOUTME: J2's persistent author-mode project navigator for workshop and document layouts.
// ABOUTME: Renders immutable TD-18 snapshots without letting refreshes steal document focus.
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { errorDetail } from "../backend";
import { isMac } from "../editor/keymap";
import { discoverGrounding, type GroundingPayload } from "../stores/grounding";
import {
  listenForProjectFilesRefreshes,
  movedSubtreePath,
  type ProjectFileMove,
  type ProjectFilesRefreshNotice,
} from "../stores/project";
import { subscribeWhileMounted } from "../stores/subscriptions";
import {
  refreshProjectFiles,
  type ProjectFilesError,
  type ProjectFilesSnapshot,
} from "./projectFiles";
import { projectRailRows, type RailNode } from "./railProjection";

export interface ProjectRailProps {
  projectName?: string;
  projectRoot?: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  refresh?: () => Promise<ProjectFilesSnapshot>;
  discover?: (root: string) => Promise<GroundingPayload>;
  /**
   * TD-18's automatic-refresh announcements (#928). Injected only so tests can drive a generation
   * by hand; production subscribes to the real backend event.
   */
  subscribe?: (
    handler: (notice: ProjectFilesRefreshNotice) => void,
  ) => Promise<() => void>;
  /**
   * Each newly applied completed generation, at most once — the app's one route from a completed
   * generation to document *identity*: its correlated path transitions (the open tab set, its
   * buffers, and the active marker) and its enumeration (which open documents still have a file at
   * all — J2 Missing on disk, #933).
   *
   * The whole snapshot rather than only its `moves` because the two questions are answered from one
   * generation, in one order: a document that moved is not a document that disappeared, and only a
   * consumer holding both halves can tell them apart. Splitting them across two callbacks would
   * make that ordering an accident of subscription.
   *
   * This rail is the app's sole consumer of project-files generations: first load, `[Refresh]`, and
   * the automatic announcement channel all land here, and a generation committed on any of them
   * must reach the tab layer exactly once (a retried rekey re-announces the generation it
   * committed). Funnelling through the one component that already dedupes generations is what makes
   * "once" true; a second subscriber would have to re-derive the same accounting to stay in step.
   */
  onGeneration?: (snapshot: ProjectFilesSnapshot) => void;
  platform?: ProjectRailPlatform;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export type ProjectRailPlatform = "win" | "mac";

export interface ProjectRailToggleProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

/** macOS owns the files-rail affordance in its title bar (3b); Windows keeps it in the rail. */
export function ProjectRailToggle({
  collapsed,
  onCollapsedChange,
}: ProjectRailToggleProps) {
  const label = collapsed ? "Show project files" : "Hide project files";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      className="project-rail__titlebar-toggle"
      aria-label={label}
      aria-pressed={collapsed}
      onClick={() => onCollapsedChange(!collapsed)}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function projectFilesError(error: unknown): ProjectFilesError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "ProjectUnavailable" || error.kind === "UpdateFailed") &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { kind: error.kind, message: error.message };
  }
  // Anything the mirrored-type check above does not recognise is still a failed update, and
  // `errorDetail` is the app's one reader of whatever message it carries (#2230). The generic
  // sentence stays this surface's own no-detail wording, passed explicitly rather than re-decided.
  return {
    kind: "UpdateFailed",
    message: errorDetail(error, "The project could not be scanned."),
  };
}

interface RailRowsProps {
  entries: RailNode[];
  activePath: string | null;
  expanded: ReadonlySet<string>;
  tabStopId: string | null;
  registerItem: (id: string, item: HTMLLIElement | null) => void;
  onFocusId: (id: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLLIElement>, entry: RailNode) => void;
  onActivate: (entry: RailNode) => void;
  depth?: number;
  retained?: boolean;
  setSize?: number;
  positionOffset?: number;
}

function RailRows({
  entries,
  activePath,
  expanded,
  tabStopId,
  registerItem,
  onFocusId,
  onKeyDown,
  onActivate,
  depth = 0,
  retained = false,
  setSize = entries.length,
  positionOffset = 0,
}: RailRowsProps) {
  return (
    <>
      {entries.map((entry, index) => {
        const disclosure = entry.kind === "directory" || entry.kind === "skill";
        const expandable = disclosure && entry.children.length > 0;
        const open = expandable && expanded.has(entry.id);
        const active = (entry.kind === "document" || entry.kind === "workflow") &&
          activePath === entry.path;
        const label = entry.warning
          ? `${entry.path}. ${entry.warning.message}. Try again`
          : entry.kind === "skill"
            ? `${entry.name}. ${entry.description}`
            : entry.kind === "workflow"
              ? `${entry.name}. ${entry.path}`
              : entry.path;
        return (
          <li
            className={`project-rail__item${retained ? " project-rail__item--retained" : ""}`}
            key={entry.id}
            role="treeitem"
            ref={(item) => registerItem(entry.id, item)}
            tabIndex={entry.id === tabStopId ? 0 : -1}
            aria-label={label}
            title={entry.path}
            aria-level={depth + 1}
            aria-setsize={setSize}
            aria-posinset={positionOffset + index + 1}
            aria-expanded={expandable ? open : undefined}
            aria-current={active ? "page" : undefined}
            onFocus={() => onFocusId(entry.id)}
            onKeyDown={(event) => onKeyDown(event, entry)}
            onClick={(event) => {
              const target = event.target as Element;
              const targetRow = target.closest(".project-rail__row");
              if (
                target === event.currentTarget ||
                targetRow?.parentElement === event.currentTarget
              ) {
                onActivate(entry);
              }
            }}
          >
            <div
              className={`project-rail__row${entry.warning ? " project-rail__row--warning" : ""}`}
            >
              {entry.warning ? (
                <>
                  <span
                    className="project-rail__label project-rail__label--warning"
                    title={entry.path}
                  >
                    {entry.name}
                  </span>
                  <span className="project-rail__warning">{entry.warning.message}</span>
                  <span className="project-rail__retry">Try again</span>
                </>
              ) : disclosure ? (
                <div
                  className={`project-rail__entry${entry.kind === "skill" ? " project-rail__entry--skill" : ""}`}
                  title={entry.path}
                >
                  {expandable &&
                    (open ? (
                      <ChevronDown className="project-rail__chevron" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="project-rail__chevron" aria-hidden="true" />
                    ))}
                  {entry.kind === "skill" ? (
                    <span className="project-rail__stack">
                      <span className="project-rail__label">{entry.name}</span>
                      <span className="project-rail__description">{entry.description}</span>
                    </span>
                  ) : <span className="project-rail__label">{entry.name}</span>}
                </div>
              ) : (
                <div
                  className={`project-rail__entry project-rail__entry--file${depth === 0 && entry.kind === "document" ? " project-rail__entry--root-file" : ""}${entry.kind === "workflow" ? " project-rail__entry--workflow" : ""}`}
                  title={entry.path}
                >
                  {entry.kind === "workflow" ? (
                    <span className="project-rail__stack">
                      <span className="project-rail__label">{entry.name}</span>
                      <span className="project-rail__workflow-path">{entry.path}</span>
                    </span>
                  ) : <span className="project-rail__label">{entry.name}</span>}
                  {active && (
                    <span className="project-rail__active-dot" aria-hidden="true" />
                  )}
                </div>
              )}
            </div>
            {expandable && open && (
              <ul className="project-rail__tree" role="group">
                <RailRows
                  entries={entry.children}
                  activePath={activePath}
                  expanded={expanded}
                  tabStopId={tabStopId}
                  registerItem={registerItem}
                  onFocusId={onFocusId}
                  onKeyDown={onKeyDown}
                  onActivate={onActivate}
                  depth={depth + 1}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

interface VisibleRailNode {
  entry: RailNode;
  parentId: string | null;
}

function visibleRailNodes(
  entries: RailNode[],
  expanded: ReadonlySet<string>,
  parentId: string | null = null,
): VisibleRailNode[] {
  const visible: VisibleRailNode[] = [];
  for (const entry of entries) {
    visible.push({ entry, parentId });
    if ((entry.kind === "directory" || entry.kind === "skill") && expanded.has(entry.id)) {
      visible.push(...visibleRailNodes(entry.children, expanded, entry.id));
    }
  }
  return visible;
}

function activeAncestors(
  entries: RailNode[],
  activePath: string,
  parents: string[] = [],
): { id: string; parents: string[] } | null {
  for (const entry of entries) {
    if ((entry.kind === "document" || entry.kind === "workflow") && entry.path === activePath) {
      return { id: entry.id, parents };
    }
    const found = activeAncestors(entry.children, activePath, [...parents, entry.id]);
    if (found) return found;
  }
  return null;
}

export function ProjectRail({
  projectName = "Project",
  projectRoot,
  activePath,
  onOpen,
  refresh = refreshProjectFiles,
  discover = discoverGrounding,
  subscribe = listenForProjectFilesRefreshes,
  onGeneration,
  platform = isMac ? "mac" : "win",
  collapsed: controlledCollapsed,
  onCollapsedChange,
}: ProjectRailProps) {
  const [snapshot, setSnapshot] = useState<ProjectFilesSnapshot | null>(null);
  const [skillMaterialSnapshot, setSkillMaterialSnapshot] = useState<ProjectFilesSnapshot | null>(null);
  const latestSnapshot = useRef<ProjectFilesSnapshot | null>(null);
  const documentsRefreshPending = useRef(false);
  const skillAwaitingDocuments = useRef(false);
  const latestMoves = useRef<readonly ProjectFileMove[]>([]);
  const pendingSkillFocusId = useRef<string | null>(null);
  const [error, setError] = useState<ProjectFilesError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The backend refreshing on its own behalf (TD-18), tracked apart from `refreshing` so an
  // announced completion cannot clear the chrome of an explicit refresh still in flight, or vice
  // versa. Only `refreshing` disables `[Refresh]`: an automatic refresh is not the user's action.
  const [announcedRefreshing, setAnnouncedRefreshing] = useState(false);
  const [discovery, setDiscovery] = useState<GroundingPayload | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const discoveryRequest = useRef(0);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const treeItems = useRef(new Map<string, HTMLLIElement>());
  // The newest generation already on screen. Held in a ref, not read off `snapshot`, because it
  // gates side effects (the expansion remap and the `onGeneration` funnel) that must happen once
  // per generation — a state read inside an event handler can lag, and a state *updater* is the
  // wrong place for an effect.
  const appliedGeneration = useRef<number | null>(null);
  // Kept in a ref so an owner passing an inline callback cannot re-key the subscription effect.
  const onGenerationRef = useRef(onGeneration);
  onGenerationRef.current = onGeneration;

  /**
   * Takes one completed generation, wherever it came from (first load, `[Refresh]`, or the
   * announcement channel). A generation no newer than the one on screen is dropped: within a
   * project generations only ever increase, so a stale or repeated one carries nothing new — and
   * repeating its moves would move a document that has already moved.
   */
  const applyCompleted = useCallback((next: ProjectFilesSnapshot) => {
    if (appliedGeneration.current !== null && next.generation <= appliedGeneration.current) return;
    appliedGeneration.current = next.generation;
    latestMoves.current = next.moves;
    // First load may enumerate after discovery. A later paired Refresh may likewise finish
    // Skills first; in both cases its material catches up when Documents succeeds.
    if (latestSnapshot.current === null || skillAwaitingDocuments.current) {
      setSkillMaterialSnapshot(next);
      skillAwaitingDocuments.current = false;
    }
    latestSnapshot.current = next;
    setSnapshot(next);
    setError(null);
    // Folder disclosure follows the tree, so it follows a *subtree* move: a row under a moved
    // folder is rendered at the new prefix by this very generation whether or not its own identity
    // was provable. Document identity is the stricter, exact-move question and is the tab layer's
    // (`onGeneration` → `stores/tabs.rekeyTabPaths`).
    if (next.moves.length > 0) {
      setExpanded((current) => {
        const remapped = new Set<string>();
        let moved = false;
        for (const id of current) {
          const skill = id.startsWith("skill:");
          const path = skill ? id.slice("skill:".length) : id;
          const to = movedSubtreePath(path, next.moves);
          if (to !== null) moved = true;
          // The discovery result can arrive after the file generation. Keep the old skill ID
          // open while its last trustworthy row is retained, then open the moved identity too.
          if (skill && to !== null) remapped.add(id);
          remapped.add(to === null ? id : skill ? `skill:${to}` : to);
        }
        // Same set back when the generation's moves touched no open folder — a rename elsewhere in
        // the project costs this component no re-render.
        return moved ? remapped : current;
      });
    }
    // Every completed generation is announced, moves or not: its enumeration is also what tells the
    // tab layer which open documents still have a file (J2 Missing on disk) — and a deletion
    // produces a generation with no moves at all.
    onGenerationRef.current?.(next);
  }, []);

  const runRefresh = useCallback(async () => {
    documentsRefreshPending.current = true;
    setRefreshing(true);
    setError(null);
    try {
      applyCompleted(await refresh());
    } catch (cause) {
      skillAwaitingDocuments.current = false;
      setError(projectFilesError(cause));
    } finally {
      documentsRefreshPending.current = false;
      setRefreshing(false);
    }
  }, [refresh, applyCompleted]);

  const runSkillsRefresh = useCallback(async () => {
    const request = ++discoveryRequest.current;
    if (projectRoot === undefined) {
      setDiscovery({ skills: [], workflows: [], instructionFile: null });
      return;
    }
    setDiscovering(true);
    setDiscoveryFailed(false);
    try {
      const result = await discover(projectRoot);
      if (request === discoveryRequest.current) {
        const focusedSkillId = [...treeItems.current].find(([id, item]) =>
          id.startsWith("skill:") && item === document.activeElement,
        )?.[0];
        if (focusedSkillId) {
          const moved = movedSubtreePath(focusedSkillId.slice("skill:".length), latestMoves.current);
          if (moved && result.skills.some((skill) => skill.path === moved)) {
            pendingSkillFocusId.current = `skill:${moved}`;
          }
        }
        setDiscovery(result);
        skillAwaitingDocuments.current = documentsRefreshPending.current;
        setSkillMaterialSnapshot(latestSnapshot.current);
        const foundSkillIds = new Set(result.skills.map((skill) => `skill:${skill.path}`));
        setExpanded((current) => {
          const kept = new Set([...current].filter((id) =>
            !id.startsWith("skill:") || foundSkillIds.has(id),
          ));
          return kept.size === current.size ? current : kept;
        });
      }
    } catch {
      if (request === discoveryRequest.current) {
        setDiscoveryFailed(true);
      }
    } finally {
      if (request === discoveryRequest.current) {
        setDiscovering(false);
      }
    }
  }, [projectRoot, discover]);

  const runBothRefreshes = useCallback(() => {
    void runRefresh();
    void runSkillsRefresh();
  }, [runRefresh, runSkillsRefresh]);

  useEffect(() => {
    runBothRefreshes();
  }, [runBothRefreshes]);

  /**
   * TD-18's automatic refreshes (#928): the backend watches the project itself and announces each
   * transition. The rail only ever *renders* what it is told — a completed notice carries the whole
   * generation, so nothing is merged client-side, and a failed one means the last completed
   * generation is still the truth (J2 `Update failed`, never an emptied tree).
   *
   * Torn down through the shared `subscribeWhileMounted`, so a project switch — the rail is keyed
   * on the project — cannot leave a listener alive to paint the project the user left, even if the
   * subscription had not resolved by the time the rail unmounted.
   *
   * That per-project key is also what terminates `announcedRefreshing`'s one open-ended case: a
   * project closing mid-scan announces `started` and then, by design, nothing further
   * (`AutomaticRefresh`'s own `Drop`), so only the remount clears the `Updating…` chrome. It is
   * load-bearing here, not incidental — a rail shared across projects would need its own terminal.
   */
  useEffect(() => {
    return subscribeWhileMounted(subscribe, (notice, isCancelled) => {
      if (isCancelled()) return;
      if (notice.status === "started") {
        setAnnouncedRefreshing(true);
        return;
      }
      setAnnouncedRefreshing(false);
      if (notice.status === "completed") applyCompleted(notice.snapshot);
      else setError(notice.error);
      void runSkillsRefresh();
    });
  }, [subscribe, applyCompleted, runSkillsRefresh]);

  const documentProjection = useMemo(
    () => projectRailRows(snapshot?.entries ?? [], discovery),
    [snapshot, discovery],
  );
  const skillProjection = useMemo(
    () => projectRailRows(skillMaterialSnapshot?.entries ?? [], discovery),
    [skillMaterialSnapshot, discovery],
  );
  const projection = useMemo(() => ({
    documents: documentProjection.documents,
    skills: skillProjection.skills,
    workflows: skillProjection.workflows,
  }), [documentProjection, skillProjection]);
  const topLevelRows = useMemo(
    () => [...projection.documents, ...projection.skills, ...projection.workflows],
    [projection],
  );
  useLayoutEffect(() => {
    const target = pendingSkillFocusId.current;
    if (!target) return;
    const item = treeItems.current.get(target);
    if (!item) return;
    pendingSkillFocusId.current = null;
    item.focus();
  }, [topLevelRows]);
  const revealedActiveOwner = useRef<string | null>(null);

  // Reveal the actual owner of a newly active path, including a skill disclosure when its
  // material owns the file. Background generations never re-open a folder the author closed.
  useEffect(() => {
    if (activePath === null) {
      revealedActiveOwner.current = null;
      return;
    }
    const match = activeAncestors(topLevelRows, activePath);
    if (!match) return;
    // Discovery can rehome an already-active file without changing its path. Reveal the new
    // owner once, while still respecting a disclosure the author subsequently closes.
    const owner = JSON.stringify([match.id, match.parents]);
    if (owner === revealedActiveOwner.current) return;
    revealedActiveOwner.current = owner;
    setExpanded((current) => {
      if (match.parents.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of match.parents) next.add(ancestor);
      return next;
    });
  }, [activePath, topLevelRows]);

  const collapsed = controlledCollapsed ?? internalCollapsed;

  function setCollapsed(next: boolean) {
    if (controlledCollapsed === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleItems = visibleRailNodes(topLevelRows, expanded);
  const visibleIds = new Set(visibleItems.map(({ entry }) => entry.id));
  const activeItem = visibleItems.find(({ entry }) =>
    (entry.kind === "document" || entry.kind === "workflow") && entry.path === activePath,
  );
  const tabStopId =
    (focusedId !== null && visibleIds.has(focusedId) ? focusedId : null) ??
    activeItem?.entry.id ??
    visibleItems[0]?.entry.id ??
    null;

  function registerItem(id: string, item: HTMLLIElement | null) {
    if (item !== null) treeItems.current.set(id, item);
    else treeItems.current.delete(id);
  }

  function focusTreeItem(id: string) {
    setFocusedId(id);
    treeItems.current.get(id)?.focus();
  }

  function activateTreeItem(entry: RailNode) {
    if (entry.warning) {
      if (entry.section === "skills") runBothRefreshes();
      else void runRefresh();
    }
    else if ((entry.kind === "directory" || entry.kind === "skill") && entry.children.length > 0) {
      toggle(entry.id);
    } else if (entry.kind === "document" || entry.kind === "workflow") onOpen(entry.path);
  }

  function handleTreeKeyDown(
    event: ReactKeyboardEvent<HTMLLIElement>,
    entry: RailNode,
  ) {
    const index = visibleItems.findIndex(({ entry: visible }) => visible.id === entry.id);
    if (index < 0) return;
    const current = visibleItems[index];
    if (
      ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "]
        .includes(event.key)
    ) {
      event.stopPropagation();
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (index < visibleItems.length - 1) focusTreeItem(visibleItems[index + 1].entry.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index > 0) focusTreeItem(visibleItems[index - 1].entry.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        if ((entry.kind !== "directory" && entry.kind !== "skill") || entry.children.length === 0) break;
        if (!expanded.has(entry.id)) toggle(entry.id);
        else focusTreeItem(entry.children[0].id);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (
          (entry.kind === "directory" || entry.kind === "skill") &&
          entry.children.length > 0 &&
          expanded.has(entry.id)
        ) {
          toggle(entry.id);
        } else if (current.parentId !== null) focusTreeItem(current.parentId);
        break;
      case "Home":
        event.preventDefault();
        focusTreeItem(visibleItems[0].entry.id);
        break;
      case "End":
        event.preventDefault();
        focusTreeItem(visibleItems[visibleItems.length - 1].entry.id);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activateTreeItem(entry);
        break;
    }
  }

  if (collapsed) {
    return (
      <aside
        className="project-rail project-rail--collapsed"
        aria-label="Project files"
        data-platform={platform}
      >
        {platform === "win" && (
          <button
            type="button"
            className="project-rail__restore"
            aria-label="Show project files"
            onClick={() => setCollapsed(false)}
          >
            <PanelLeftOpen aria-hidden="true" />
          </button>
        )}
      </aside>
    );
  }

  const unavailable = error?.kind === "ProjectUnavailable";
  const updating = refreshing || announcedRefreshing;
  const documentsRetained = updating || error?.kind === "UpdateFailed";
  const skillsRetained = discovering || discoveryFailed;
  const rowProps = {
    activePath,
    expanded,
    tabStopId,
    registerItem,
    onFocusId: setFocusedId,
    onKeyDown: handleTreeKeyDown,
    onActivate: activateTreeItem,
  };
  return (
    <aside className="project-rail" aria-label="Project files" data-platform={platform}>
      <header className="project-rail__header">
        <strong className="project-rail__project-name" title={projectName}>{projectName}</strong>
        <div className="project-rail__actions">
          <button
            type="button"
            aria-label="Refresh project files"
            onClick={runBothRefreshes}
            disabled={refreshing || discovering}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          {platform === "win" && (
            <button
              type="button"
              aria-label="Hide project files"
              onClick={() => setCollapsed(true)}
            >
              <PanelLeftClose aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div className="project-rail__content">
        {unavailable && (
          <div className="project-rail__empty" role="status">
            <strong>Project files unavailable</strong>
            <span>{error.message}</span>
            <button type="button" onClick={runBothRefreshes}>
              Try again
            </button>
          </div>
        )}
        {!unavailable && (
          <ul className="project-rail__tree" role="tree" aria-label="Project files">
            <li role="presentation" className="project-rail__section-label">DOCUMENTS</li>
            <RailRows
              {...rowProps}
              entries={projection.documents}
              retained={documentsRetained}
              setSize={topLevelRows.length}
            />
            {snapshot === null && updating && (
              <li role="presentation" className="project-rail__status">Loading documents…</li>
            )}
            {snapshot !== null && updating && (
              <li role="presentation" className="project-rail__status">Updating documents…</li>
            )}
            {snapshot !== null && !updating && !error && projection.documents.length === 0 && (
              <li role="presentation" className="project-rail__empty">
                No documents yet — this project may contain other file types
              </li>
            )}
            {error?.kind === "UpdateFailed" && (
              <li role="presentation">
                <div className="project-rail__status project-rail__status--warning" role="status">
                  <span>Couldn’t update documents</span>
                  <button type="button" onClick={() => void runRefresh()}>Try again</button>
                </div>
              </li>
            )}
            <li role="presentation" className="project-rail__section-label project-rail__section-label--skills">SKILLS</li>
            <RailRows
              {...rowProps}
              entries={projection.skills}
              retained={skillsRetained}
              setSize={topLevelRows.length}
              positionOffset={projection.documents.length}
            />
            {discovery?.workflows.length ? (
              <li role="presentation" className="project-rail__section-label project-rail__section-label--workflows">WORKFLOWS</li>
            ) : null}
            <RailRows
              {...rowProps}
              entries={projection.workflows}
              retained={skillsRetained}
              setSize={topLevelRows.length}
              positionOffset={projection.documents.length + projection.skills.length}
            />
            {discovery === null && discovering && (
              <li role="presentation" className="project-rail__status">Finding skills and workflows…</li>
            )}
            {discovery !== null && discovering && (
              <li role="presentation" className="project-rail__status">Updating skills…</li>
            )}
            {discovery !== null && !discovering && !discoveryFailed &&
              projection.skills.length + projection.workflows.length === 0 && (
                <li role="presentation" className="project-rail__empty">No skills found</li>
              )}
            {discoveryFailed && (
              <li role="presentation">
                <div className="project-rail__status project-rail__status--warning" role="status">
                  <span>Couldn’t update skills</span>
                  <button type="button" onClick={() => void runSkillsRefresh()}>Try again</button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <footer className="project-rail__footer">
        <span className="project-rail__footer-dot" aria-hidden="true" />
        <span>Refresh to check for changes</span>
      </footer>
    </aside>
  );
}
