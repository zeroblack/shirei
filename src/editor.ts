import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  LanguageDescription,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { readFile, writeFile } from "./commands";
import { errorCode, errorMessage } from "./errors";
import { basename } from "./path";

const languageConf = new Compartment();
const themeConf = new Compartment();
const vimConf = new Compartment();
const readingConf = new Compartment();

export interface SaveResult {
  ok: boolean;
  conflict?: boolean;
  error?: string;
}

export interface ReadingConfig {
  prose_width: string;
  wrap_prose: boolean;
  code_width: string;
  wrap_code: boolean;
}

const PROSE_EXTS = new Set(["md", "markdown", "mdx", "txt", "text"]);

function isProse(path: string): boolean {
  const ext = (path.split("/").pop() ?? path).split(".").pop()?.toLowerCase();
  return ext !== undefined && PROSE_EXTS.has(ext);
}

// Prose (markdown/txt) wraps to a readable measure; code keeps no-wrap with
// horizontal scroll so indentation stays intact. The cap is a CSS max-width on
// the block container — never on .cm-line's inline children, which breaks the
// caret and click-to-position.
function readingFor(path: string, cfg: ReadingConfig): Extension {
  const prose = isProse(path);
  const wrap = prose ? cfg.wrap_prose : cfg.wrap_code;
  const width = prose ? cfg.prose_width : cfg.code_width;
  const exts: Extension[] = [];
  if (wrap) exts.push(EditorView.lineWrapping);
  if (width)
    exts.push(EditorView.theme({ ".cm-content": { maxWidth: width } }));
  return exts;
}

function themeFor(fontSize: number, fontFamily: string, bg: string) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: `${fontSize}px`,
        color: "#e6e6e6",
        backgroundColor: bg,
      },
      ".cm-content": { caretColor: "#e6e6e6" },
      ".cm-gutters": { backgroundColor: bg, color: "#5c6370", border: "none" },
      ".cm-scroller": { fontFamily, overflow: "auto" },
    },
    { dark: true },
  );
}

async function languageFor(path: string): Promise<LanguageSupport | null> {
  const name = basename(path);
  let desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "astro" || ext === "svelte") {
      desc = languages.find((l) => l.name === "HTML") ?? null;
    }
  }
  return desc ? desc.load() : null;
}

export class EditorSession {
  readonly id: string;
  readonly path: string;
  private readonly container: HTMLElement;
  private view: EditorView | null = null;
  private baseMtime = 0;
  private fontSize: number;
  private fontFamily: string;
  private bg: string;
  private vimOn: boolean;
  private reading: ReadingConfig;
  onDirtyChange?: (dirty: boolean) => void;

  constructor(
    id: string,
    path: string,
    container: HTMLElement,
    look: {
      fontFamily: string;
      fontSize: number;
      bg: string;
      vim: boolean;
      reading: ReadingConfig;
    },
  ) {
    this.id = id;
    this.path = path;
    this.container = container;
    this.fontSize = look.fontSize;
    this.fontFamily = look.fontFamily;
    this.bg = look.bg;
    this.vimOn = look.vim;
    this.reading = look.reading;
  }

  async open(): Promise<void> {
    const file = await readFile(this.path);
    this.baseMtime = file.mtime;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        vimConf.of(this.vimOn ? vim() : []),
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languageConf.of([]),
        readingConf.of(readingFor(this.path, this.reading)),
        syntaxHighlighting(oneDarkHighlightStyle),
        themeConf.of(themeFor(this.fontSize, this.fontFamily, this.bg)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onDirtyChange?.(true);
        }),
      ],
    });
    this.view = new EditorView({ state, parent: this.container });
    const lang = await languageFor(this.path);
    if (lang) this.view.dispatch({ effects: languageConf.reconfigure(lang) });
  }

  async save(): Promise<SaveResult> {
    return this.write(this.baseMtime);
  }

  async saveForce(): Promise<SaveResult> {
    return this.write(null);
  }

  private async write(known: number | null): Promise<SaveResult> {
    if (!this.view) return { ok: false };
    const data = this.view.state.doc.toString();
    try {
      this.baseMtime = await writeFile(this.path, data, known);
      this.onDirtyChange?.(false);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        conflict: errorCode(e) === "write-conflict",
        error: errorMessage(e),
      };
    }
  }

  show(visible: boolean): void {
    this.container.classList.toggle("active", visible);
  }

  focus(): void {
    this.view?.focus();
  }

  setVim(on: boolean): void {
    this.vimOn = on;
    this.view?.dispatch({
      effects: vimConf.reconfigure(on ? vim() : []),
    });
  }

  setReading(reading: ReadingConfig): void {
    this.reading = reading;
    this.view?.dispatch({
      effects: readingConf.reconfigure(readingFor(this.path, reading)),
    });
  }

  private reapplyTheme(): void {
    this.view?.dispatch({
      effects: themeConf.reconfigure(
        themeFor(this.fontSize, this.fontFamily, this.bg),
      ),
    });
  }

  applyLook(family: string, size: number, bg: string): void {
    this.fontFamily = family;
    this.fontSize = size;
    this.bg = bg;
    this.reapplyTheme();
  }

  setBg(bg: string): void {
    this.bg = bg;
    this.reapplyTheme();
  }

  dispose(): void {
    this.view?.destroy();
    this.view = null;
    this.container.remove();
  }
}
