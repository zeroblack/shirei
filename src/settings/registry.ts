export const SECTION_LAYOUT = [
  { id: "home", group: "workspace" },
  { id: "appearance", group: "workspace" },
  { id: "editor", group: "workspace" },
  { id: "git", group: "workspace" },
  { id: "projects", group: "workspace" },
  { id: "shortcuts", group: "workspace" },
  { id: "terminal", group: "terminal" },
  { id: "sessions", group: "terminal" },
  { id: "tabs", group: "terminal" },
  { id: "recording", group: "tools" },
  { id: "performance", group: "tools" },
  { id: "advanced", group: "system" },
  { id: "about", group: "system" },
] as const satisfies readonly { id: string; group: string }[];

export type SectionId = (typeof SECTION_LAYOUT)[number]["id"];
