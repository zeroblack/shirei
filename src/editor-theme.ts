import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { alpha, ensureContrast, mix } from "./colors";
import type { TerminalColors } from "./config";

const SYNTAX_FLOOR = 45;
const DIM_FLOOR = 22;

export type SyntaxRole =
  | "keyword"
  | "string"
  | "number"
  | "function"
  | "type"
  | "variable"
  | "operator"
  | "comment"
  | "tag"
  | "attribute";

// Maps the palette's curated ANSI colors to syntax roles, lifting each toward
// `fg` only as far as legibility requires against `bg`. Comments stay dim on
// purpose; everything else clears the body-text floor on any background.
export function editorSyntaxColors(
  p: TerminalColors,
): Record<SyntaxRole, string> {
  const lift = (c: string, floor = SYNTAX_FLOOR): string =>
    ensureContrast(c, p.bg, p.fg, floor);
  return {
    keyword: lift(p.magenta),
    string: lift(p.green),
    number: lift(p.yellow),
    function: lift(p.blue),
    type: lift(p.brightCyan),
    variable: lift(p.fg),
    operator: lift(mix(p.fg, p.bg, 0.35), DIM_FLOOR),
    comment: lift(mix(p.fg, p.bg, 0.45), DIM_FLOOR),
    tag: lift(p.red),
    attribute: lift(p.cyan),
  };
}

export function editorThemeFromPalette(
  p: TerminalColors,
  preset: "dark" | "light",
  fontSize: number,
  fontFamily: string,
): Extension {
  const c = editorSyntaxColors(p);

  const theme = EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: `${fontSize}px`,
        color: p.fg,
        backgroundColor: p.bg,
      },
      ".cm-content": { caretColor: p.cursor },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: p.cursor,
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: alpha(p.brightBlue, 0.24) },
      ".cm-activeLine": { backgroundColor: alpha(p.fg, 0.035) },
      ".cm-gutters": {
        backgroundColor: p.bg,
        color: mix(p.fg, p.bg, 0.6),
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: p.fg },
      ".cm-matchingBracket": {
        backgroundColor: alpha(p.brightBlue, 0.3),
        outline: "none",
      },
      ".cm-selectionMatch": { backgroundColor: alpha(p.fg, 0.08) },
      ".cm-astro-component": { color: `${c.type} !important` },
      ".cm-astro-directive": { color: `${c.keyword} !important` },
      ".cm-conflict": {
        borderLeft: `1px solid ${alpha(p.fg, 0.12)}`,
        borderRight: `1px solid ${alpha(p.fg, 0.12)}`,
        padding: "0 12px",
      },
      ".cm-conflict-first": {
        borderTop: `1px solid ${alpha(p.fg, 0.12)}`,
        borderTopLeftRadius: "8px",
        borderTopRightRadius: "8px",
        background: mix(p.bg, p.fg, 0.04),
        marginTop: "8px",
      },
      ".cm-conflict-last": {
        borderBottom: `1px solid ${alpha(p.fg, 0.12)}`,
        borderBottomLeftRadius: "8px",
        borderBottomRightRadius: "8px",
        marginBottom: "8px",
      },
      ".cm-conflict-ours": { backgroundColor: alpha(p.green, 0.1) },
      ".cm-conflict-theirs": { backgroundColor: alpha(p.blue, 0.1) },
      ".cm-conflict-base": { backgroundColor: alpha(p.fg, 0.04) },
      ".cm-conflict-header": {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "100%",
      },
      ".cm-conflict-count": {
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        color: mix(p.fg, p.bg, 0.55),
      },
      ".cm-conflict-current": {
        fontFamily: '"Geist Mono", var(--font-mono)',
        fontSize: "11px",
        fontWeight: "600",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: ensureContrast(p.green, p.bg, p.fg, 62),
      },
      ".cm-conflict-branch": {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        color: mix(p.fg, p.bg, 0.4),
      },
      ".cm-conflict-dot": {
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: ensureContrast(p.green, p.bg, p.fg, 45),
      },
      ".cm-conflict-actions": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        marginLeft: "auto",
      },
      ".cm-conflict-btn": {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        border: `1px solid ${alpha(p.fg, 0.14)}`,
        background: alpha(p.fg, 0.06),
        color: mix(p.fg, p.bg, 0.25),
        borderRadius: "6px",
        padding: "2px 9px",
        fontSize: "11px",
        cursor: "pointer",
      },
      ".cm-conflict-btn:hover": { background: alpha(p.fg, 0.14), color: p.fg },
      ".cm-conflict-btn.ours:hover": {
        background: alpha(p.green, 0.16),
        color: ensureContrast(p.green, p.bg, p.fg, 60),
        borderColor: alpha(p.green, 0.3),
      },
      ".cm-conflict-btn.theirs:hover": {
        background: alpha(p.blue, 0.16),
        color: ensureContrast(p.blue, p.bg, p.fg, 60),
        borderColor: alpha(p.blue, 0.3),
      },
      ".cm-conflict-sep": {
        fontFamily: '"Geist Mono", var(--font-mono)',
        fontSize: "11px",
        fontWeight: "600",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: ensureContrast(p.blue, p.bg, p.fg, 62),
      },
      ".cm-conflict-baselabel": {
        fontFamily: '"Geist Mono", var(--font-mono)',
        fontSize: "11px",
        fontWeight: "600",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: mix(p.fg, p.bg, 0.62),
      },
      ".cm-searchMatch": { backgroundColor: alpha(p.yellow, 0.3) },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: alpha(p.yellow, 0.55),
      },
      ".cm-scroller": { fontFamily, overflow: "auto" },
      ".cm-scroller::-webkit-scrollbar": { width: "10px", height: "10px" },
      ".cm-scroller::-webkit-scrollbar-thumb": {
        backgroundColor: alpha(p.fg, 0.18),
        borderRadius: "5px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        color: mix(p.fg, p.bg, 0.55),
        cursor: "pointer",
        padding: "0 4px",
      },
      ".cm-foldGutter .cm-gutterElement:hover": { color: p.fg },
      ".cm-fold-marker": {
        display: "inline-flex",
        alignItems: "center",
        transition: "opacity 120ms ease, color 120ms ease",
      },
      ".cm-fold-open": { opacity: "0" },
      ".cm-foldGutter .cm-gutterElement:hover .cm-fold-open": {
        opacity: "0.6",
      },
      ".cm-fold-marker.cm-fold-open:hover": { opacity: "1", color: p.fg },
      ".cm-fold-folded": { opacity: "0.75" },
      ".cm-foldPlaceholder": {
        backgroundColor: alpha(p.fg, 0.08),
        color: mix(p.fg, p.bg, 0.6),
        border: "none",
        borderRadius: "4px",
        padding: "0 6px",
        margin: "0 4px",
      },
      ".cm-panels": { backgroundColor: mix(p.bg, p.fg, 0.05), color: p.fg },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${alpha(p.fg, 0.12)}`,
      },
      ".cm-search-premium": {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px 10px",
      },
      ".cm-search-row": { display: "flex", alignItems: "center", gap: "6px" },
      ".cm-search-input": {
        flex: "1 1 auto",
        minWidth: "120px",
        backgroundColor: p.bg,
        color: p.fg,
        border: `1px solid ${alpha(p.fg, 0.15)}`,
        borderRadius: "5px",
        padding: "4px 8px",
        fontFamily: "inherit",
        fontSize: "12px",
        outline: "none",
      },
      ".cm-search-input:focus": { borderColor: alpha(p.brightBlue, 0.6) },
      ".cm-search-count": {
        flex: "0 0 auto",
        minWidth: "64px",
        textAlign: "right",
        whiteSpace: "nowrap",
        fontFamily: "var(--type-mono, monospace)",
        fontSize: "11px",
        color: mix(p.fg, p.bg, 0.55),
      },
      ".cm-search-count.cm-search-zero": {
        color: ensureContrast(p.red, p.bg, p.fg, 45),
      },
      ".cm-search-icon": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "24px",
        height: "24px",
        padding: "0",
        border: "none",
        borderRadius: "5px",
        background: "transparent",
        color: mix(p.fg, p.bg, 0.6),
        cursor: "pointer",
      },
      ".cm-search-icon:hover": {
        backgroundColor: alpha(p.fg, 0.08),
        color: p.fg,
      },
      ".cm-search-close": { fontSize: "16px", lineHeight: "1" },
      ".cm-search-disclosure svg": { transition: "transform 120ms ease" },
      ".cm-search-disclosure.active svg": { transform: "rotate(90deg)" },
      ".cm-search-pill": {
        minWidth: "26px",
        height: "24px",
        padding: "0 6px",
        border: "none",
        borderRadius: "5px",
        backgroundColor: alpha(p.fg, 0.06),
        color: mix(p.fg, p.bg, 0.6),
        cursor: "pointer",
        fontFamily: "var(--type-mono, monospace)",
        fontSize: "11px",
      },
      ".cm-search-pill:hover": { backgroundColor: alpha(p.fg, 0.12) },
      ".cm-search-pill.active": {
        backgroundColor: alpha(p.brightBlue, 0.18),
        color: ensureContrast(p.brightBlue, p.bg, p.fg, 60),
      },
      ".cm-search-text": {
        height: "24px",
        padding: "0 10px",
        border: "none",
        borderRadius: "5px",
        backgroundColor: alpha(p.fg, 0.08),
        color: p.fg,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: "12px",
      },
      ".cm-search-text:hover": { backgroundColor: alpha(p.fg, 0.15) },
    },
    { dark: preset === "dark" },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.operatorKeyword], color: c.keyword },
    { tag: t.special(t.variableName), color: c.keyword, fontStyle: "italic" },
    {
      tag: [t.string, t.special(t.string), t.regexp, t.escape],
      color: c.string,
    },
    {
      tag: [t.number, t.bool, t.atom, t.constant(t.name)],
      color: c.number,
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: c.function,
    },
    { tag: [t.typeName, t.className, t.namespace], color: c.type },
    { tag: t.variableName, color: c.variable },
    {
      tag: [t.propertyName, t.definition(t.propertyName)],
      color: c.attribute,
    },
    {
      tag: [t.operator, t.punctuation, t.separator, t.bracket],
      color: c.operator,
    },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: c.comment,
      fontStyle: "italic",
    },
    { tag: t.tagName, color: c.tag },
    { tag: t.attributeName, color: c.attribute },
    { tag: t.attributeValue, color: c.string },
    { tag: t.link, color: c.attribute, textDecoration: "underline" },
    { tag: t.url, color: c.attribute },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid, color: p.brightRed },
  ]);

  return [theme, syntaxHighlighting(highlight)];
}

// Indentation guides tinted from the palette (kept in their own extension so a
// theme switch re-derives them), since the library bakes colors at config time.
export function editorIndentMarkers(p: TerminalColors): Extension {
  const inactive = mix(p.bg, p.fg, 0.13);
  const active = mix(p.bg, p.fg, 0.34);
  return indentationMarkers({
    highlightActiveBlock: true,
    colors: {
      light: inactive,
      dark: inactive,
      activeLight: active,
      activeDark: active,
    },
  });
}
