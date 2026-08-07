// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseRow, renderInlineMd } from "./editor-livepreview";

function html(text: string): string {
  const div = document.createElement("div");
  div.appendChild(renderInlineMd(text));
  return div.innerHTML;
}

describe("parseRow", () => {
  it("splits cells and trims", () => {
    expect(parseRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("keeps escaped pipes inside a cell", () => {
    expect(parseRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });
});

describe("renderInlineMd", () => {
  it("passes plain text through", () => {
    expect(html("plain text")).toBe("plain text");
  });

  it("renders bold", () => {
    expect(html("**Imprescindible**")).toBe(
      '<span class="cm-md-strong">Imprescindible</span>',
    );
  });

  it("renders code spans literally", () => {
    expect(html("`player_id`")).toBe(
      '<span class="cm-md-code">player_id</span>',
    );
    expect(html("`a **b**`")).toBe('<span class="cm-md-code">a **b**</span>');
  });

  it("renders italics and strikethrough", () => {
    expect(html("*em* and ~~gone~~")).toBe(
      '<span class="cm-md-em">em</span> and <span class="cm-md-strike">gone</span>',
    );
  });

  it("renders links as styled spans with the url as title", () => {
    expect(html("[docs](https://a.b)")).toBe(
      '<span class="cm-md-link" title="https://a.b">docs</span>',
    );
  });

  it("nests inline styles", () => {
    expect(html("**bold `code`**")).toBe(
      '<span class="cm-md-strong">bold <span class="cm-md-code">code</span></span>',
    );
  });

  it("mixes text and tokens in order", () => {
    expect(html("texto o `entero`, y **fin**")).toBe(
      'texto o <span class="cm-md-code">entero</span>, y <span class="cm-md-strong">fin</span>',
    );
  });

  it("does not treat lone asterisks or underscores as markup", () => {
    expect(html("a * b * c_d")).toBe("a * b * c_d");
  });
});
