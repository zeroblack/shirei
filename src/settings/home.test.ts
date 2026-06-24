import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import { setLocale } from "../i18n";
import { describeEnvironment } from "./section-home";

const base = {
  font: { family: "geist-mono", size: 13 },
  theme: { preset: "dark" },
  session: { keep_alive: true },
  layout: { default_template: "yagura", sidebar_width: 240 },
} as unknown as Config;

describe("describeEnvironment", () => {
  it("maps config state to readable rows", () => {
    setLocale("es");
    const rows = describeEnvironment(base);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.Tema).toBe("Oscuro");
    expect(byLabel["Sesiones persistentes"]).toBe("Activadas");
    expect(byLabel.Fuente).toBe("geist-mono");
  });
});
