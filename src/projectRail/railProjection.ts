// ABOUTME: Projects project-file generations and discovered grounding into J2's disjoint rail rows.
// ABOUTME: Keeps workflow ownership ahead of the deepest discovered skill, then Documents.
import type { GroundingPayload } from "../stores/grounding";
import { isSupportedDocumentPath } from "../stores/project";
import type { ProjectFileEntry, ProjectFileWarning } from "./projectFiles";

export type RailNodeKind = "directory" | "document" | "skill" | "workflow";

export interface RailNode {
  id: string;
  path: string;
  name: string;
  kind: RailNodeKind;
  section: "documents" | "skills";
  children: RailNode[];
  description?: string;
  warning?: ProjectFileWarning | null;
}

export interface RailProjection {
  documents: RailNode[];
  skills: RailNode[];
  workflows: RailNode[];
}

function isDotPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function skillRoot(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function contains(root: string, path: string): boolean {
  return root === "" || path.startsWith(`${root}/`);
}

function byName(left: RailNode, right: RailNode): number {
  return left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
    left.name.localeCompare(right.name);
}

function findDirectory(entries: ProjectFileEntry[], path: string): ProjectFileEntry[] {
  if (path === "") return entries;
  const parts = path.split("/");
  let current = entries;
  for (const part of parts) {
    const directory = current.find((entry) => entry.kind === "directory" && entry.name === part);
    if (!directory) return [];
    current = directory.children;
  }
  return current;
}

export function projectRailRows(
  entries: ProjectFileEntry[],
  discovery: GroundingPayload | null,
): RailProjection {
  const skills = discovery?.skills.filter((skill) => typeof skill.path === "string") ?? [];
  const workflows = discovery?.workflows.filter((workflow) => typeof workflow.path === "string") ?? [];
  const workflowPaths = new Set(workflows.map((workflow) => workflow.path));
  const roots = skills.map((skill) => ({ path: skill.path, root: skillRoot(skill.path) }));
  const warnings = new Map<string, ProjectFileWarning>();
  function collectWarnings(source: ProjectFileEntry[]): void {
    for (const entry of source) {
      if (entry.warning) warnings.set(entry.path, entry.warning);
      collectWarnings(entry.children);
    }
  }
  collectWarnings(entries);

  function owner(path: string): string | null {
    if (workflowPaths.has(path)) return `workflow:${path}`;
    const matching = roots.filter(({ root }) => contains(root, path));
    matching.sort((a, b) => b.root.length - a.root.length);
    return matching.length > 0 ? `skill:${matching[0].path}` : null;
  }

  function projectFiles(source: ProjectFileEntry[], target: string | null, hideDot: boolean): RailNode[] {
    const projected: RailNode[] = [];
    for (const entry of source) {
      if (hideDot && isDotPath(entry.path)) continue;
      if (entry.kind === "directory") {
        const children = projectFiles(entry.children, target, hideDot);
        if (children.length > 0 || (entry.warning && owner(entry.path) === target)) {
          projected.push({
            id: entry.path,
            path: entry.path,
            name: entry.name,
            kind: "directory",
            section: target === null ? "documents" : "skills",
            children,
            warning: entry.warning,
          });
        }
      } else if (
        (entry.kind === "file" || (entry.kind === "unknown" && entry.warning)) &&
        isSupportedDocumentPath(entry.path) &&
        owner(entry.path) === target
      ) {
        projected.push({
          id: entry.path,
          path: entry.path,
          name: entry.name,
          kind: "document",
          section: target === null ? "documents" : "skills",
          children: [],
          warning: entry.warning,
        });
      }
    }
    return projected.sort(byName);
  }

  const skillRows = skills.map((skill): RailNode => {
    const root = skillRoot(skill.path);
    const skillOwner = `skill:${skill.path}`;
    const material = projectFiles(findDirectory(entries, root), skillOwner, false);
    if (!material.some((entry) => entry.path === skill.path)) {
      material.push({
        id: skill.path,
        path: skill.path,
        name: "SKILL.md",
        kind: "document",
        section: "skills",
        children: [],
      });
      material.sort(byName);
    }
    return {
      id: skillOwner,
      path: skill.path,
      name: skill.name,
      description: skill.description,
      kind: "skill",
      section: "skills",
      children: material,
    };
  }).sort(byName);

  return {
    documents: projectFiles(entries, null, true),
    skills: skillRows,
    workflows: workflows.map((workflow): RailNode => ({
      id: workflow.path,
      path: workflow.path,
      name: workflow.name,
      kind: "workflow",
      section: "skills",
      children: [],
      warning: warnings.get(workflow.path) ?? null,
    })).sort(byName),
  };
}
