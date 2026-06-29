import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { typescriptLanguage } from "@codemirror/lang-javascript";
import { LanguageSupport, syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Input, parseMixed, type SyntaxNodeRef } from "@lezer/common";

// Astro has no CodeMirror grammar. We parse the template with the HTML grammar
// and mix in TypeScript for the `---` frontmatter and `{…}` expressions, plus
// TS/CSS for <script>/<style> — the bulk of real Astro highlighting without a
// hand-written Lezer grammar. Directive-specific coloring (client:* in its own
// hue) would need that grammar and is left for later.

const ts = typescriptLanguage.parser;
const css = cssLanguage.parser;

interface Span {
  from: number;
  to: number;
}

// Top-level `{…}` spans inside a text node, skipping braces inside strings.
function expressionSpans(text: string, base: number): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 1;
    let quote = "";
    let j = i + 1;
    for (; j < text.length && depth > 0; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote && text[j - 1] !== "\\") quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth === 0 && j - 1 > i + 1) {
      spans.push({ from: base + i + 1, to: base + j - 1 });
      i = j - 1;
    }
  }
  return spans;
}

// The TS body between the opening and closing `---` of the frontmatter.
function frontmatterSpan(text: string, base: number): Span | null {
  const open = /^﻿?\s*---[^\n]*\n/.exec(text);
  if (!open) return null;
  const start = open[0].length;
  const close = text.indexOf("\n---", start);
  if (close <= start) return null;
  return { from: base + start, to: base + close };
}

function astroNest(node: SyntaxNodeRef, input: Input) {
  const name = node.type.name;
  if (name === "ScriptText") return { parser: ts };
  if (name === "StyleText") return { parser: css };
  if (name === "Text") {
    const text = input.read(node.from, node.to);
    if (node.from <= 3) {
      const fm = frontmatterSpan(text, node.from);
      if (fm) return { parser: ts, overlay: [fm] };
    }
    const spans = expressionSpans(text, node.from);
    if (spans.length) return { parser: ts, overlay: spans };
  }
  return null;
}

const astroLanguage = htmlLanguage.configure(
  { wrap: parseMixed(astroNest) },
  "astro",
);

// PascalCase tags are components, not HTML elements; `client:`/`is:`/etc. are
// Astro directives, not plain attributes. The HTML grammar can't tell them
// apart by name, so we mark them here; colors live in the palette-derived theme.
const componentMark = Decoration.mark({ class: "cm-astro-component" });
const directiveMark = Decoration.mark({ class: "cm-astro-directive" });
const DIRECTIVE = /^(client|server|transition|set|is|define):/;

function astroMarks(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "TagName") {
          const ch = view.state.sliceDoc(node.from, node.from + 1);
          if (ch >= "A" && ch <= "Z") {
            ranges.push(componentMark.range(node.from, node.to));
          }
        } else if (node.name === "AttributeName") {
          if (DIRECTIVE.test(view.state.sliceDoc(node.from, node.to))) {
            ranges.push(directiveMark.range(node.from, node.to));
          }
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const astroHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = astroMarks(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = astroMarks(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function astro(): LanguageSupport {
  return new LanguageSupport(astroLanguage, [astroHighlight]);
}
