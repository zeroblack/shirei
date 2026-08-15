// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderAdapterRow } from "./section-memory";

describe("renderAdapterRow", () => {
  it("shows state and the right primary action", () => {
    const onRegister = vi.fn();
    const onUnregister = vi.fn();
    const row = renderAdapterRow(
      {
        id: "claude",
        detected: true,
        state: "missing",
        config_path: "/u/.claude.json",
      },
      "Claude Code",
      { onRegister, onUnregister },
    );
    expect(row.textContent).toContain("Claude Code");
    expect(row.dataset.state).toBe("missing");
    (
      row.querySelector("button[data-action='register']") as HTMLButtonElement
    ).click();
    expect(onRegister).toHaveBeenCalledWith("claude");
    const reg = renderAdapterRow(
      {
        id: "codex",
        detected: false,
        state: "registered",
        config_path: "/u/.codex/config.toml",
      },
      "Codex",
      { onRegister, onUnregister },
    );
    expect(
      reg.querySelector("button[data-action='unregister']"),
    ).not.toBeNull();
    expect(reg.querySelector("button[data-action='register']")).toBeNull();
  });
});
