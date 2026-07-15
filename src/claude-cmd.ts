export function isClaudeCommand(cmd: string | undefined): cmd is string {
  return cmd !== undefined && cmd.trim().split(/\s+/)[0] === "claude";
}

// Every claude pane spawns with --resume so each picks the session it belongs
// to. A pane's observed command is snapshotted and respawned verbatim, so a
// `--continue` captured before this rule existed would otherwise come back on
// every restore — it is rewritten, not preserved: `--continue` attaches to the
// most recent conversation in the directory, and panes opening at once race
// onto that same one and clobber each other.
export function withClaudeResume(cmd: string): string {
  if (/(^|\s)(--resume|-r)(\s|$)/.test(cmd)) return cmd;
  return `${cmd.replace(/\s*(--continue|-c)(?=\s|$)/g, "")} --resume`;
}
