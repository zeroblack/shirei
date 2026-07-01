export type Scope = "project" | "home";

export const SCOPES: Scope[] = ["project", "home"];

export interface ScopeRoots {
  project: string | null;
  home: string;
  projectLabel: string;
  projectColor: string | null;
}

export function resolveSearchRoot(ctx: {
  projectPath: string | null;
  openedFrom: string | null;
  shellCwd: string | null;
  home: string;
}): string {
  return ctx.projectPath ?? ctx.openedFrom ?? ctx.shellCwd ?? ctx.home;
}

export function cycleScope(current: Scope, dir: 1 | -1): Scope {
  const i = SCOPES.indexOf(current);
  return SCOPES[(i + dir + SCOPES.length) % SCOPES.length];
}

export function rootForScope(scope: Scope, roots: ScopeRoots): string | null {
  return scope === "project" ? roots.project : roots.home;
}
