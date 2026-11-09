// ABOUTME: Public frontend surface for J2's project rail and TD-18 snapshot IPC.
// ABOUTME: Keeps app-shell imports independent of the project-rail module's internal file layout.
export { ProjectRail, ProjectRailToggle } from "./ProjectRail";
export type { ProjectRailPlatform, ProjectRailToggleProps } from "./ProjectRail";
export { refreshProjectFiles } from "./projectFiles";
export type {
  ProjectFileEntry,
  ProjectFileEntryKind,
  ProjectFileMove,
  ProjectFilesError,
  ProjectFilesSnapshot,
} from "./projectFiles";
