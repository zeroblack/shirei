// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderAdapterRow, renderHandshakeRow } from "./section-memory";

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
        shim_path: "/u/.shirei/bin/shirei-memory",
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
        shim_path: "/u/.shirei/bin/shirei-memory",
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

describe("renderHandshakeRow", () => {
  const shim = "/u/.shirei/bin/shirei-memory";

  it("reports the server and how many tools answered", () => {
    const row = renderHandshakeRow({
      ok: true,
      shim_path: shim,
      server: "rmcp",
      tools: ["memory_overview", "memory_init"],
      error: "",
    });
    expect(row.dataset.ok).toBe("true");
    expect(row.textContent).toContain("rmcp");
    expect(row.textContent).toContain("2 tools");
  });

  it("surfaces the failure reason instead of a silent green state", () => {
    const row = renderHandshakeRow({
      ok: false,
      shim_path: shim,
      server: "",
      tools: [],
      error: "No such file or directory (os error 2)",
    });
    expect(row.dataset.ok).toBe("false");
    expect(row.textContent).toContain("os error 2");
    expect(
      row.querySelector<HTMLElement>(".memory-adapter-state")?.dataset.state,
    ).toBe("missing");
  });
});
