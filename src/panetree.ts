/**
 * Flex-container direction, not the visual orientation of the divider: "h"
 * lays panes in a row (side by side, a vertical split to the user), "v" stacks
 * them in a column (a horizontal split). User-facing labels invert accordingly.
 */
export type Dir = "h" | "v";

export interface PaneLeaf {
  kind: "leaf";
  id: string;
  /** Command declared by a template or project layout. */
  command?: string;
  /**
   * Foreground command observed by the last snapshot; `null` means the shell
   * was idle then, `undefined` that no snapshot has run yet. Kept apart from
   * `command` so session restore can tell declared intent from captured state.
   */
  lastCommand?: string | null;
  cwd?: string;
}

export interface PaneSplit {
  kind: "split";
  dir: Dir;
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.a), ...leaves(node.b)];
}

export function splitLeaf(
  root: PaneNode,
  leafId: string,
  dir: Dir,
  added: PaneLeaf,
): PaneNode {
  if (root.kind === "leaf") {
    if (root.id !== leafId) return root;
    return { kind: "split", dir, ratio: 0.5, a: root, b: added };
  }
  return {
    ...root,
    a: splitLeaf(root.a, leafId, dir, added),
    b: splitLeaf(root.b, leafId, dir, added),
  };
}

export function closeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.kind === "leaf") return root.id === leafId ? null : root;
  const a = closeLeaf(root.a, leafId);
  const b = closeLeaf(root.b, leafId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...root, a, b };
}

/**
 * Structural template match: same splits/ratios and same declared commands.
 * Deliberately ignores leaf ids and cwd — it is not full equality.
 */
export function sameStructure(a: PaneNode, b: PaneNode): boolean {
  if (a.kind === "leaf" && b.kind === "leaf") return a.command === b.command;
  if (a.kind === "split" && b.kind === "split") {
    return (
      a.dir === b.dir &&
      a.ratio === b.ratio &&
      sameStructure(a.a, b.a) &&
      sameStructure(a.b, b.b)
    );
  }
  return false;
}

export function declaredCommands(node: PaneNode): string[] {
  return [
    ...new Set(
      leaves(node)
        .map((l) => l.command)
        .filter((c): c is string => !!c),
    ),
  ];
}

/**
 * The pane tree a new tab should open with given the configured default
 * template name. Returns `null` (caller opens a plain shell) when nothing is
 * selected, the name is unknown, or any command the template declares is not
 * available — so a missing `yagura` degrades to a normal tab instead of a pane
 * stuck on "command not found".
 */
export function resolveDefaultTemplate(
  templates: { name: string; tree: PaneNode }[],
  name: string,
  isAvailable: (command: string) => boolean,
): PaneNode | null {
  if (!name) return null;
  const tpl = templates.find((t) => t.name === name);
  if (!tpl) return null;
  if (!declaredCommands(tpl.tree).every(isAvailable)) return null;
  return tpl.tree;
}

export function instantiate(
  template: PaneNode,
  makeId: () => string,
  cwd: string,
): PaneNode {
  if (template.kind === "leaf") {
    return { kind: "leaf", id: makeId(), command: template.command, cwd };
  }
  return {
    kind: "split",
    dir: template.dir,
    ratio: template.ratio,
    a: instantiate(template.a, makeId, cwd),
    b: instantiate(template.b, makeId, cwd),
  };
}
