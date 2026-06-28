import { Language, LanguageSupport } from "@codemirror/language";
import { diff } from "@codemirror/merge";
import {
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Input, Parser, PartialParse, TreeFragment } from "@lezer/common";
import { Parser as LezerParser } from "@lezer/common";
import { t } from "./i18n";
import { COMPARE } from "./icons";

const MARKERS = ["<<<<<<<", "=======", ">>>>>>>", "|||||||"];

function markerLineRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    if (MARKERS.some((m) => line.startsWith(m)))
      ranges.push([pos, pos + line.length]);
    pos += line.length + 1;
  }
  return ranges;
}

class BlankingInput implements Input {
  constructor(
    private readonly inner: Input,
    private readonly blanks: [number, number][],
  ) {}
  get length(): number {
    return this.inner.length;
  }
  get lineChunks(): boolean {
    return this.inner.lineChunks;
  }
  chunk(from: number): string {
    return this.blank(this.inner.chunk(from), from);
  }
  read(from: number, to: number): string {
    return this.blank(this.inner.read(from, to), from);
  }
  private blank(text: string, from: number): string {
    const to = from + text.length;
    let out: string[] | null = null;
    for (const [a, b] of this.blanks) {
      const lo = Math.max(a, from);
      const hi = Math.min(b, to);
      if (lo >= hi) continue;
      if (!out) out = [...text];
      for (let i = lo; i < hi; i++) out[i - from] = " ";
    }
    return out ? out.join("") : text;
  }
}

class ConflictTolerantParser extends LezerParser {
  constructor(private readonly inner: Parser) {
    super();
  }
  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const blanks = markerLineRanges(input.read(0, input.length));
    const wrapped = blanks.length ? new BlankingInput(input, blanks) : input;
    return this.inner.createParse(wrapped, fragments, ranges);
  }
}

// A file with live conflict markers is not valid source, so the language's
// full-grammar parser derails after the first `<<<<<<<` and downstream
// highlighting dies. This wraps the parser so marker lines read as blanks,
// letting each side highlight as the real language while the markers stay on disk.
export function conflictTolerant(support: LanguageSupport): LanguageSupport {
  try {
    const inner = support.language;
    const parser = new ConflictTolerantParser(inner.parser);
    const lang = new Language(inner.data, parser, [], inner.name);
    return new LanguageSupport(lang, support.support);
  } catch (e) {
    console.error("conflictTolerant: falling back to base language", e);
    return support;
  }
}

const toggleCompare = StateEffect.define<{ pos: number; on: boolean }>();

const compareField = StateField.define<Set<number>>({
  create() {
    return new Set();
  },
  update(set, tr) {
    let next = set;
    if (tr.docChanged) {
      next = new Set();
      const doc = tr.state.doc;
      for (const pos of set) {
        const mapped = tr.changes.mapPos(pos, 1);
        const line = doc.lineAt(mapped);
        if (line.from === mapped && line.text.startsWith("<<<<<<<"))
          next.add(mapped);
      }
    }
    for (const e of tr.effects) {
      if (!e.is(toggleCompare)) continue;
      if (next === set) next = new Set(set);
      if (e.value.on) next.add(e.value.pos);
      else next.delete(e.value.pos);
    }
    return next;
  },
});

interface Block {
  start: number;
  end: number;
  index: number;
  total: number;
  oursFrom: number;
  oursTo: number;
  theirsFrom: number;
  theirsTo: number;
  baseFrom: number;
  baseTo: number;
  sep: [number, number];
  baseMark: [number, number] | null;
  endMark: [number, number];
}

function lineSpan(
  doc: Text,
  fromLine: number,
  toLine: number,
): [number, number] {
  if (toLine < fromLine)
    return [doc.line(fromLine).from, doc.line(fromLine).from];
  return [doc.line(fromLine).from, doc.line(toLine).to];
}

function parseConflicts(doc: Text): Block[] {
  const blocks: Block[] = [];
  const n = doc.lines;
  let i = 1;
  while (i <= n) {
    if (!doc.line(i).text.startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    let base = -1;
    let mid = -1;
    let endLine = -1;
    for (let k = i + 1; k <= n; k++) {
      const tx = doc.line(k).text;
      if (tx.startsWith(">>>>>>>")) {
        endLine = k;
        break;
      }
      if (tx.startsWith("=======") && mid < 0) mid = k;
      else if (tx.startsWith("|||||||") && base < 0 && mid < 0) base = k;
    }
    if (mid < 0 || endLine < 0) {
      i++;
      continue;
    }
    const oursEnd = base > 0 ? base : mid;
    const [oursFrom, oursTo] = lineSpan(doc, i + 1, oursEnd - 1);
    const [baseFrom, baseTo] =
      base > 0 ? lineSpan(doc, base + 1, mid - 1) : [0, 0];
    const [theirsFrom, theirsTo] = lineSpan(doc, mid + 1, endLine - 1);
    blocks.push({
      start: doc.line(i).from,
      end: doc.line(endLine).to,
      index: 0,
      total: 0,
      oursFrom,
      oursTo,
      theirsFrom,
      theirsTo,
      baseFrom,
      baseTo,
      sep: [doc.line(mid).from, doc.line(mid).to],
      baseMark: base > 0 ? [doc.line(base).from, doc.line(base).to] : null,
      endMark: [doc.line(endLine).from, doc.line(endLine).to],
    });
    i = endLine + 1;
  }
  for (const b of blocks) b.total = blocks.length;
  blocks.forEach((b, idx) => {
    b.index = idx + 1;
  });
  return blocks;
}

function actionBtn(
  label: string,
  cls: string,
  run: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    run();
  });
  return b;
}

class HeaderWidget extends WidgetType {
  constructor(
    readonly block: Block,
    readonly compareOn: boolean,
  ) {
    super();
  }
  eq(other: HeaderWidget): boolean {
    return (
      other.block.start === this.block.start &&
      other.block.index === this.block.index &&
      other.block.total === this.block.total &&
      other.compareOn === this.compareOn
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const b = this.block;
    const bar = document.createElement("span");
    bar.className = "cm-conflict-header";

    const count = document.createElement("span");
    count.className = "cm-conflict-count";
    count.textContent = t("ui.editor.conflict.index", {
      current: b.index,
      total: b.total,
    });

    const current = document.createElement("span");
    current.className = "cm-conflict-current";
    current.textContent = t("ui.editor.conflict.current");

    const branch = document.createElement("span");
    branch.className = "cm-conflict-branch";
    const dot = document.createElement("span");
    dot.className = "cm-conflict-dot";
    branch.append(dot, document.createTextNode("HEAD"));

    const actions = document.createElement("span");
    actions.className = "cm-conflict-actions";
    const slice = (from: number, to: number): string =>
      to > from ? view.state.sliceDoc(from, to) : "";
    const resolve = (text: string): void => {
      view.dispatch({ changes: { from: b.start, to: b.end, insert: text } });
    };

    const compareBtn = document.createElement("button");
    compareBtn.type = "button";
    compareBtn.className = this.compareOn
      ? "cm-conflict-compare active"
      : "cm-conflict-compare";
    compareBtn.title = t("ui.editor.conflict.compareHint");
    compareBtn.setAttribute("aria-label", t("ui.editor.conflict.compare"));
    compareBtn.innerHTML = COMPARE;
    compareBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        effects: toggleCompare.of({ pos: b.start, on: !this.compareOn }),
      });
    });

    actions.append(
      compareBtn,
      actionBtn(t("ui.editor.conflict.ours"), "cm-conflict-btn ours", () =>
        resolve(slice(b.oursFrom, b.oursTo)),
      ),
      actionBtn(t("ui.editor.conflict.theirs"), "cm-conflict-btn theirs", () =>
        resolve(slice(b.theirsFrom, b.theirsTo)),
      ),
      actionBtn(t("ui.editor.conflict.both"), "cm-conflict-btn", () => {
        const ours = slice(b.oursFrom, b.oursTo);
        const theirs = slice(b.theirsFrom, b.theirsTo);
        resolve(ours && theirs ? `${ours}\n${theirs}` : ours + theirs);
      }),
    );

    bar.append(count, current, branch, actions);
    return bar;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class LabelWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super();
  }
  eq(other: LabelWidget): boolean {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

function build(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const compare = view.state.field(compareField, false);
  const all: Range<Decoration>[] = [];
  const lineCls = (pos: number, cls: string): void => {
    all.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  };
  const replace = (from: number, to: number, widget?: WidgetType): void => {
    all.push(Decoration.replace(widget ? { widget } : {}).range(from, to));
  };
  const tintRange = (from: number, to: number, cls: string): void => {
    for (let p = from; p <= to; ) {
      const line = doc.lineAt(p);
      lineCls(line.from, cls);
      if (line.to >= to) break;
      p = line.to + 1;
    }
  };
  const markDiff = (block: Block): void => {
    const ours = view.state.sliceDoc(block.oursFrom, block.oursTo);
    const theirs = view.state.sliceDoc(block.theirsFrom, block.theirsTo);
    for (const ch of diff(ours, theirs)) {
      if (ch.toA > ch.fromA)
        all.push(
          Decoration.mark({ class: "cm-conflict-diff-current" }).range(
            block.oursFrom + ch.fromA,
            block.oursFrom + ch.toA,
          ),
        );
      if (ch.toB > ch.fromB)
        all.push(
          Decoration.mark({ class: "cm-conflict-diff-incoming" }).range(
            block.theirsFrom + ch.fromB,
            block.theirsFrom + ch.toB,
          ),
        );
    }
  };
  for (const block of parseConflicts(doc)) {
    const startLine = doc.lineAt(block.start);
    const endLine = doc.lineAt(block.end);
    for (let ln = startLine.number; ln <= endLine.number; ln++) {
      const edge =
        ln === startLine.number
          ? " cm-conflict-first"
          : ln === endLine.number
            ? " cm-conflict-last"
            : "";
      lineCls(doc.line(ln).from, `cm-conflict${edge}`);
    }
    const compareOn = compare?.has(block.start) ?? false;
    replace(startLine.from, startLine.to, new HeaderWidget(block, compareOn));
    replace(
      block.sep[0],
      block.sep[1],
      new LabelWidget(t("ui.editor.conflict.incoming"), "cm-conflict-sep"),
    );
    if (block.baseMark) {
      replace(
        block.baseMark[0],
        block.baseMark[1],
        new LabelWidget(t("ui.editor.conflict.base"), "cm-conflict-baselabel"),
      );
    }
    replace(block.endMark[0], block.endMark[1]);
    tintRange(block.oursFrom, block.oursTo, "cm-conflict-ours");
    tintRange(block.theirsFrom, block.theirsTo, "cm-conflict-theirs");
    if (block.baseTo > block.baseFrom) {
      tintRange(block.baseFrom, block.baseTo, "cm-conflict-base");
    }
    if (compareOn) markDiff(block);
  }
  return Decoration.set(all, true);
}

export function conflictResolver(): Extension {
  return [
    compareField,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate): void {
          if (
            u.docChanged ||
            u.viewportChanged ||
            u.startState.field(compareField, false) !==
              u.state.field(compareField, false)
          )
            this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
