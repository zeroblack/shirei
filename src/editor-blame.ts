import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { GitBlameLine } from "./commands";
import { absoluteDate, compactAge } from "./dates";

interface BlameConfig {
  delayMs: number;
}

let card: HTMLElement | null = null;
let cardTimer: ReturnType<typeof setTimeout> | null = null;

function ensureCard(): HTMLElement {
  if (!card) {
    card = document.createElement("div");
    card.className = "cm-blame-card";
    document.body.appendChild(card);
  }
  return card;
}

function showCard(anchor: HTMLElement, info: GitBlameLine): void {
  const el = ensureCard();
  el.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "cm-blame-card-summary";
  summary.textContent = info.summary;
  const meta = document.createElement("div");
  meta.className = "cm-blame-card-meta";
  meta.append(
    document.createTextNode(`${info.author} · ${absoluteDate(info.date)} · `),
  );
  const sha = document.createElement("span");
  sha.className = "cm-blame-card-sha";
  sha.textContent = info.shortSha;
  meta.append(sha);
  el.append(summary, meta);

  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  el.style.left = `${left}px`;
  el.style.top = `${rect.bottom + 6}px`;
  requestAnimationFrame(() => el.classList.add("cm-blame-card--in"));
}

function hideCard(): void {
  if (cardTimer) {
    clearTimeout(cardTimer);
    cardTimer = null;
  }
  card?.classList.remove("cm-blame-card--in");
}

class BlameWidget extends WidgetType {
  constructor(
    readonly info: GitBlameLine,
    readonly active: boolean,
    readonly delayMs: number,
  ) {
    super();
  }
  eq(other: BlameWidget): boolean {
    return (
      other.info.sha === this.info.sha &&
      other.info.line === this.info.line &&
      other.active === this.active
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.active
      ? "cm-blame-annotation cm-blame-active"
      : "cm-blame-annotation";
    const field = (cls: string, text: string): HTMLElement => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const sep = (): HTMLElement => field("cm-blame-sep", "·");
    el.append(
      field("cm-blame-author", this.info.author),
      sep(),
      field("cm-blame-age", compactAge(this.info.date)),
      sep(),
      field("cm-blame-sha", this.info.shortSha),
    );
    el.addEventListener("mouseenter", () => {
      cardTimer = setTimeout(() => showCard(el, this.info), this.delayMs);
    });
    el.addEventListener("mouseleave", hideCard);
    return el;
  }
}

export function blameAnnotations(
  lines: GitBlameLine[],
  cfg: BlameConfig,
): Extension {
  const byLine = new Map<number, GitBlameLine>();
  for (const line of lines) byLine.set(line.line, line);

  // Collapse runs: metadata shows only on the first line of each commit run,
  // so consecutive lines from the same commit stay quiet.
  const runStart = new Set<number>();
  for (const line of lines)
    if (byLine.get(line.line - 1)?.sha !== line.sha) runStart.add(line.line);

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet)
          this.decorations = this.build(u.view);
      }
      destroy(): void {
        hideCard();
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const cursorLine = view.state.doc.lineAt(
          view.state.selection.main.head,
        ).number;
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            const info = byLine.get(line.number);
            if (
              info &&
              (runStart.has(line.number) || line.number === cursorLine)
            ) {
              builder.add(
                line.to,
                line.to,
                Decoration.widget({
                  widget: new BlameWidget(
                    info,
                    line.number === cursorLine,
                    cfg.delayMs,
                  ),
                  side: 1,
                }),
              );
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
