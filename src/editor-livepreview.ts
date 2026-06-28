import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { alpha, ensureContrast, mix } from "./colors";
import type { TerminalColors } from "./config";
import { t } from "./i18n";
import { CHECK, COPY, calloutIcon } from "./icons";

function paletteColor(p: TerminalColors, name: string): string {
  switch (name) {
    case "green":
      return p.green;
    case "magenta":
      return p.magenta;
    case "yellow":
      return p.yellow;
    case "red":
      return p.red;
    default:
      return p.blue;
  }
}

const HIDE = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
  "URL",
  "QuoteMark",
]);

const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
  Link: "cm-md-link",
};

const CALLOUT_COLOR: Record<string, string> = {
  note: "blue",
  info: "blue",
  abstract: "blue",
  quote: "blue",
  tip: "green",
  success: "green",
  example: "green",
  important: "magenta",
  warning: "yellow",
  caution: "red",
  question: "yellow",
  todo: "yellow",
  danger: "red",
  bug: "red",
  failure: "red",
};

const hideMark = Decoration.replace({});

function resolvePath(baseDir: string, rel: string): string {
  const parts = baseDir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = this.checked ? "cm-md-checkbox checked" : "cm-md-checkbox";
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.pos,
          to: this.pos + 3,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly label: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: CalloutTitleWidget): boolean {
    return (
      other.type === this.type &&
      other.label === this.label &&
      other.color === this.color
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-callout-title";
    const icon = document.createElement("span");
    icon.className = "cm-md-callout-icon";
    icon.innerHTML = calloutIcon(this.type, this.color);
    const label = document.createElement("span");
    label.textContent = this.label;
    el.append(icon, label);
    return el;
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    return el;
  }
}

class CodeBadgeWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }
  eq(other: CodeBadgeWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM(): HTMLElement {
    const bar = document.createElement("span");
    bar.className = "cm-md-cb-bar";
    const left = document.createElement("span");
    left.className = "cm-md-cb-side";
    const lang = document.createElement("span");
    lang.className = "cm-md-cb-lang";
    lang.textContent = this.lang || "text";
    const right = document.createElement("span");
    right.className = "cm-md-cb-side cm-md-cb-right";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-md-cb-copy";
    copy.title = t("ui.editor.copy");
    const setIdle = (): void => {
      copy.innerHTML = COPY;
      copy.append(t("ui.editor.copy"));
      copy.classList.remove("copied");
    };
    setIdle();
    copy.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void navigator.clipboard?.writeText(this.code);
      copy.innerHTML = CHECK;
      copy.append(t("ui.editor.copied"));
      copy.classList.add("copied");
      setTimeout(setIdle, 1200);
    });
    right.append(copy);
    bar.append(left, lang, right);
    return bar;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly baseDir: string,
  ) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return other.url === this.url;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.alt = this.alt;
    img.src = /^(https?:|data:)/.test(this.url)
      ? this.url
      : convertFileSrc(resolvePath(this.baseDir, this.url));
    return img;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function parseRow(line: string): string[] {
  return line
    .replace(/^\s*\|?/, "")
    .replace(/\|?\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.src === this.src;
  }
  toDOM(): HTMLElement {
    const rows = this.src.split("\n").filter((l) => l.trim());
    const aligns = parseRow(rows[1] ?? "").map((d) => {
      const l = d.startsWith(":");
      const r = d.endsWith(":");
      return r && l ? "center" : r ? "right" : l ? "left" : "";
    });
    const table = document.createElement("table");
    table.className = "cm-md-rendered-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    parseRow(rows[0] ?? "").forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      if (aligns[i]) th.style.textAlign = aligns[i];
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (let i = 2; i < rows.length; i++) {
      const tr = document.createElement("tr");
      parseRow(rows[i]).forEach((cell, j) => {
        const td = document.createElement("td");
        td.textContent = cell;
        if (aligns[j]) td.style.textAlign = aligns[j];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function inlineDecorations(
  view: EditorView,
  baseDir: string,
  palette: TerminalColors,
): {
  deco: DecorationSet;
  hidden: DecorationSet;
} {
  const { state } = view;
  const doc = state.doc;
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number;
    const last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const hide = (from: number, to: number): void => {
    const r = hideMark.range(from, to);
    all.push(r);
    hidden.push(r);
  };
  const replaceWith = (from: number, to: number, widget: WidgetType): void => {
    const r = Decoration.replace({ widget }).range(from, to);
    all.push(r);
    hidden.push(r);
  };
  const lineClass = (pos: number, cls: string): void => {
    all.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.to <= node.from && node.name !== "HorizontalRule") return;
        const name = node.name;
        const active = activeLines.has(doc.lineAt(node.from).number);

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          lineClass(node.from, `cm-md-h${heading[1]}`);
          return;
        }

        const cls = STYLE[name];
        if (cls)
          all.push(Decoration.mark({ class: cls }).range(node.from, node.to));

        if (name === "Image" && !active) {
          const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(
            doc.sliceString(node.from, node.to),
          );
          if (m)
            replaceWith(
              node.from,
              node.to,
              new ImageWidget(m[2], m[1], baseDir),
            );
          return;
        }

        if (name === "ListMark" && !active) {
          const txt = doc.sliceString(node.from, node.to);
          const line = doc.lineAt(node.from);
          if (/^[-*+]$/.test(txt) && !/^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) {
            replaceWith(node.from, node.to, new BulletWidget());
          }
          return;
        }

        if (name === "TaskMarker" && !active) {
          const line = doc.lineAt(node.from);
          const m = /^(\s*)[-*+](\s+)\[[ xX]\]/.exec(line.text);
          const start = m ? line.from + m[1].length : node.from;
          const checked = /\[[xX]\]/.test(doc.sliceString(node.from, node.to));
          replaceWith(start, node.to, new CheckboxWidget(checked, node.from));
          return;
        }

        if (name === "HorizontalRule") {
          lineClass(node.from, "cm-md-hr-line");
          if (!active) replaceWith(node.from, node.to, new RuleWidget());
          return;
        }

        if (name === "FencedCode") {
          const a = doc.lineAt(node.from).number;
          const b = doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let n = a; n <= b; n++) {
            const extra =
              n === a ? " cm-md-cb-first" : n === b ? " cm-md-cb-last" : "";
            lineClass(doc.line(n).from, `cm-md-codeblock${extra}`);
          }
          if (!active) {
            const openLine = doc.line(a);
            const lang =
              /^[`~]{3,}\s*([\w+#.-]*)/.exec(openLine.text)?.[1] ?? "";
            const code =
              a + 1 <= b - 1
                ? doc.sliceString(doc.line(a + 1).from, doc.line(b - 1).to)
                : "";
            replaceWith(
              openLine.from,
              openLine.to,
              new CodeBadgeWidget(lang, code),
            );
            const closeLine = doc.line(b);
            if (b > a && /^[`~]{3,}\s*$/.test(closeLine.text)) {
              hide(closeLine.from, closeLine.to);
            }
          }
          return;
        }

        if (name === "Blockquote") {
          const firstLine = doc.lineAt(node.from);
          const co = /^>\s*\[!(\w+)\]/i.exec(firstLine.text);
          const a = doc.lineAt(node.from).number;
          const b = doc.lineAt(Math.max(node.from, node.to - 1)).number;
          if (co) {
            const type = co[1].toLowerCase();
            const color = CALLOUT_COLOR[type] ?? "blue";
            for (let n = a; n <= b; n++) {
              const edge =
                n === a
                  ? " cm-md-callout-first"
                  : n === b
                    ? " cm-md-callout-last"
                    : "";
              lineClass(
                doc.line(n).from,
                `cm-md-callout cm-md-callout-${color}${edge}`,
              );
            }
            if (!active) {
              const tagStart = firstLine.text.indexOf("[!");
              const tagEnd = firstLine.text.indexOf("]", tagStart);
              if (tagStart >= 0 && tagEnd > tagStart) {
                const label = type[0].toUpperCase() + type.slice(1);
                const iconColor = ensureContrast(
                  paletteColor(palette, color),
                  palette.bg,
                  palette.fg,
                  60,
                );
                replaceWith(
                  firstLine.from + tagStart,
                  firstLine.from + tagEnd + 1,
                  new CalloutTitleWidget(type, label, iconColor),
                );
              }
            }
          } else {
            for (let n = a; n <= b; n++) {
              const edge =
                n === a
                  ? " cm-md-quote-first"
                  : n === b
                    ? " cm-md-quote-last"
                    : "";
              lineClass(doc.line(n).from, `cm-md-quote${edge}`);
            }
          }
          return;
        }

        // Only style raw table lines when active; inactive tables are replaced
        // by the block widget (StateField), so line decorations here would clash.
        if (active) {
          if (name === "TableHeader")
            lineClass(node.from, "cm-md-table cm-md-th");
          else if (name === "TableDelimiter")
            lineClass(node.from, "cm-md-table cm-md-table-sep");
          else if (name === "TableRow") lineClass(node.from, "cm-md-table");
        }

        if (!active && HIDE.has(name)) hide(node.from, node.to);
      },
    });
  }

  return {
    deco: Decoration.set(all, true),
    hidden: Decoration.set(hidden, true),
  };
}

function tableBlocks(
  state: {
    doc: { lineAt: (p: number) => { from: number; to: number } };
    selection: { main: { from: number; to: number } };
    sliceDoc: (a: number, b: number) => string;
    // biome-ignore lint/suspicious/noExplicitAny: CM6 EditorState shape, narrowed for tables
  } & any,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const sel = state.selection.main;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(Math.max(node.from, node.to - 1)).to;
      if (sel.from <= to && sel.to >= from) return;
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(state.sliceDoc(from, to)),
          block: true,
        }).range(from, to),
      );
    },
  });
  return Decoration.set(ranges, true);
}

function calloutCss(
  p: TerminalColors,
  name: string,
  color: string,
): Record<string, Record<string, string>> {
  return {
    [`.cm-md-callout-${name}`]: {
      background: alpha(color, 0.07),
      borderColor: alpha(color, 0.26),
    },
    [`.cm-md-callout-${name} .cm-md-callout-title`]: {
      color: ensureContrast(color, p.bg, p.fg, 60),
    },
  };
}

function proseChrome(p: TerminalColors): Extension {
  return EditorView.theme({
    ".cm-content": { fontFamily: "var(--font-ui)", lineHeight: "1.7" },
    ".cm-gutters": { display: "none" },
    ".cm-md-h1": { fontSize: "1.7em", fontWeight: "700", lineHeight: "1.3" },
    ".cm-md-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
    ".cm-md-h3": { fontSize: "1.25em", fontWeight: "650" },
    ".cm-md-h4": { fontSize: "1.1em", fontWeight: "650" },
    ".cm-md-h5": { fontSize: "1em", fontWeight: "650" },
    ".cm-md-h6": { fontSize: "0.92em", fontWeight: "650", opacity: "0.75" },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-strike": { textDecoration: "line-through", opacity: "0.7" },
    ".cm-md-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.92em",
      background: alpha(p.fg, 0.08),
      padding: "0.05em 0.34em",
      borderRadius: "4px",
    },
    ".cm-md-link": { cursor: "pointer", textDecoration: "underline" },
    ".cm-md-bullet": { color: ensureContrast(p.blue, p.bg, p.fg, 45) },
    // Block system: every block is a radius-8 card; only the color changes.
    ".cm-md-callout": {
      borderStyle: "solid",
      borderWidth: "0 1px",
      borderColor: "transparent",
      padding: "0 16px",
    },
    ".cm-md-callout-first": {
      borderTopWidth: "1px",
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      paddingTop: "10px",
      marginTop: "8px",
    },
    ".cm-md-callout-last": {
      borderBottomWidth: "1px",
      borderBottomLeftRadius: "8px",
      borderBottomRightRadius: "8px",
      paddingBottom: "10px",
      marginBottom: "8px",
    },
    ".cm-md-callout-title": {
      display: "inline-flex",
      alignItems: "center",
      gap: "8px",
      fontWeight: "600",
      letterSpacing: "-0.01em",
    },
    ".cm-md-callout-icon": { display: "inline-flex", alignItems: "center" },
    ".cm-md-quote": {
      background: alpha(p.fg, 0.035),
      padding: "0 16px",
      color: mix(p.fg, p.bg, 0.22),
    },
    ".cm-md-quote-first": {
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      paddingTop: "8px",
      marginTop: "8px",
    },
    ".cm-md-quote-last": {
      borderBottomLeftRadius: "8px",
      borderBottomRightRadius: "8px",
      paddingBottom: "8px",
      marginBottom: "8px",
    },
    ".cm-md-codeblock": {
      background: alpha(p.fg, 0.04),
      fontFamily: "var(--font-mono)",
      fontSize: "0.92em",
    },
    ".cm-md-cb-first": {
      borderTopLeftRadius: "8px",
      borderTopRightRadius: "8px",
      paddingTop: "4px",
    },
    ".cm-md-cb-last": {
      borderBottomLeftRadius: "8px",
      borderBottomRightRadius: "8px",
      paddingBottom: "6px",
    },
    ".cm-md-cb-bar": {
      display: "flex",
      alignItems: "center",
      paddingBottom: "4px",
      borderBottom: `1px solid ${alpha(p.fg, 0.08)}`,
      marginBottom: "4px",
    },
    ".cm-md-cb-side": { flex: "1", display: "flex", alignItems: "center" },
    ".cm-md-cb-right": { justifyContent: "flex-end" },
    ".cm-md-cb-lang": {
      fontFamily: "var(--font-mono)",
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.07em",
      color: mix(p.fg, p.bg, 0.5),
    },
    ".cm-md-cb-copy": {
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      border: "none",
      background: "transparent",
      color: mix(p.fg, p.bg, 0.45),
      borderRadius: "5px",
      padding: "2px 7px",
      fontSize: "11px",
      cursor: "pointer",
    },
    ".cm-md-cb-copy:hover": { background: alpha(p.fg, 0.1), color: p.fg },
    ".cm-md-cb-copy.copied": { color: ensureContrast(p.green, p.bg, p.fg, 45) },
    ".cm-md-image": {
      maxWidth: "100%",
      borderRadius: "8px",
      display: "block",
      margin: "0.4em 0",
    },
    ".cm-md-table": { fontFamily: "var(--font-mono)", fontSize: "0.92em" },
    ".cm-md-th": { fontWeight: "700" },
    ".cm-md-table-sep": { opacity: "0.4" },
    ".cm-md-table-wrap": {
      overflowX: "auto",
      border: `1px solid ${alpha(p.fg, 0.1)}`,
      borderRadius: "8px",
      margin: "0.6em 0",
    },
    ".cm-md-rendered-table": {
      borderCollapse: "collapse",
      width: "100%",
      fontFamily: "var(--font-ui)",
    },
    ".cm-md-rendered-table th, .cm-md-rendered-table td": {
      padding: "8px 14px",
      textAlign: "left",
      fontVariantNumeric: "tabular-nums",
    },
    ".cm-md-rendered-table thead th": {
      fontWeight: "600",
      background: alpha(p.fg, 0.06),
      borderBottom: `1px solid ${alpha(p.fg, 0.14)}`,
    },
    ".cm-md-rendered-table tbody tr": {
      borderTop: `1px solid ${alpha(p.fg, 0.06)}`,
    },
    ".cm-md-rendered-table tbody tr:hover": {
      background: alpha(p.fg, 0.03),
      transition: "background 120ms ease",
    },
    ".cm-md-checkbox": {
      display: "inline-block",
      width: "1em",
      height: "1em",
      verticalAlign: "-0.12em",
      marginRight: "0.5em",
      borderRadius: "4px",
      border: `1.5px solid ${alpha(p.fg, 0.4)}`,
      cursor: "pointer",
    },
    ".cm-md-checkbox.checked": {
      background: ensureContrast(p.brightBlue, p.bg, p.fg, 45),
      borderColor: ensureContrast(p.brightBlue, p.bg, p.fg, 45),
    },
    ".cm-md-hr": {
      display: "inline-block",
      width: "100%",
      borderTop: `1px solid ${alpha(p.fg, 0.25)}`,
      verticalAlign: "middle",
    },
    ...calloutCss(p, "blue", p.blue),
    ...calloutCss(p, "green", p.green),
    ...calloutCss(p, "magenta", p.magenta),
    ...calloutCss(p, "yellow", p.yellow),
    ...calloutCss(p, "red", p.red),
  });
}

export function livePreview(
  palette: TerminalColors,
  baseDir: string,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      hidden: DecorationSet;
      constructor(view: EditorView) {
        const b = inlineDecorations(view, baseDir, palette);
        this.deco = b.deco;
        this.hidden = b.hidden;
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          const b = inlineDecorations(u.view, baseDir, palette);
          this.deco = b.deco;
          this.hidden = b.hidden;
        }
      }
    },
    {
      decorations: (v) => v.deco,
      provide: (p) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(p)?.hidden ?? Decoration.none,
        ),
    },
  );

  const tables = StateField.define<DecorationSet>({
    create: (state) => tableBlocks(state),
    update: (deco, tr) =>
      tr.docChanged || tr.selection ? tableBlocks(tr.state) : deco,
    provide: (f) => EditorView.decorations.from(f),
  });

  return [plugin, tables, proseChrome(palette)];
}
