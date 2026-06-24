import { beforeEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "./i18n";

beforeEach(() => setLocale("en"));

describe("t", () => {
  it("returns the english source by default", () => {
    expect(getLocale()).toBe("en");
    expect(t("settings.language.label")).toBe("Language");
  });

  it("returns the spanish translation when the locale is es", () => {
    setLocale("es");
    expect(t("settings.language.label")).toBe("Idioma");
  });

  it("interpolates named params", () => {
    expect(t("ui.template.saved", { name: "Foo" })).toBe(
      'Template "Foo" saved.',
    );
  });

  it("keeps the placeholder when a param is missing", () => {
    expect(t("ui.template.saved")).toBe('Template "{name}" saved.');
  });
});
