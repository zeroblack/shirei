import { describe, expect, it } from "vitest";
import {
  contentBounds,
  normalizeUrl,
  resolveColorScheme,
  shouldShowBrowser,
} from "./browser-core";

describe("normalizeUrl", () => {
  it("adds https:// to a bare host", () => {
    expect(normalizeUrl("youtube.com")).toBe("https://youtube.com/");
  });
  it("keeps http(s)", () => {
    expect(normalizeUrl("http://localhost:5173")).toBe(
      "http://localhost:5173/",
    );
  });
  it("rejects non-http schemes and empty", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("tauri://x")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });
});

describe("contentBounds", () => {
  it("is parent-relative: offsets only by the chrome height", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(contentBounds(rect, 32)).toEqual({
      x: 100,
      y: 82,
      width: 400,
      height: 268,
    });
  });
  it("clamps a collapsed pane to at least 1x1", () => {
    const rect = { left: 5, top: 5, width: 0, height: 10 };
    expect(contentBounds(rect, 32)).toEqual({
      x: 5,
      y: 37,
      width: 1,
      height: 1,
    });
  });
});

describe("shouldShowBrowser", () => {
  it("shows only when active, frontmost, no overlay", () => {
    expect(
      shouldShowBrowser({
        paneActive: true,
        contentFrontmost: true,
        overlayOpen: false,
      }),
    ).toBe(true);
  });
  it("hides under any overlay (fail safe)", () => {
    expect(
      shouldShowBrowser({
        paneActive: true,
        contentFrontmost: true,
        overlayOpen: true,
      }),
    ).toBe(false);
  });
  it("hides when not frontmost or pane inactive", () => {
    expect(
      shouldShowBrowser({
        paneActive: false,
        contentFrontmost: true,
        overlayOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowBrowser({
        paneActive: true,
        contentFrontmost: false,
        overlayOpen: false,
      }),
    ).toBe(false);
  });
});

describe("resolveColorScheme", () => {
  it("passes dark/light through unchanged", () => {
    expect(resolveColorScheme("dark", "light", false)).toBe("dark");
    expect(resolveColorScheme("light", "dark", true)).toBe("light");
  });
  it("theme follows the app's theme preset", () => {
    expect(resolveColorScheme("theme", "light", false)).toBe("light");
    expect(resolveColorScheme("theme", "dark", true)).toBe("dark");
  });
  it("auto follows the OS media query", () => {
    expect(resolveColorScheme("auto", "light", true)).toBe("dark");
    expect(resolveColorScheme("auto", "dark", false)).toBe("light");
  });
});
