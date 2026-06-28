import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
} from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { gitBlame, gitFileHead, readFile, writeFile } from "./commands";
import type { Config, TerminalColors } from "./config";
import { astro } from "./editor-astro";
import { blameAnnotations } from "./editor-blame";
import { conflictResolver, conflictTolerant } from "./editor-conflict";
import { livePreview } from "./editor-livepreview";
import { markdownEditKeymap } from "./editor-mdkeys";
import { searchPanel } from "./editor-search";
import { editorIndentMarkers, editorThemeFromPalette } from "./editor-theme";
import { errorCode, errorMessage } from "./errors";
import { t } from "./i18n";
import { BLAME, CHEVRON, HISTORY, REVERT } from "./icons";
import { basename, parentDir } from "./path";
import { showToast } from "./toast";

type EditorConfig = Config["editor"];
type GitConfig = Config["git"];

const languageConf = new Compartment();
const themeConf = new Compartment();
const indentConf = new Compartment();
const featuresConf = new Compartment();
const livePreviewConf = new Compartment();
const diffConf = new Compartment();
const blameConf = new Compartment();
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

function foldMarkerDOM(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = open
    ? "cm-fold-marker cm-fold-open"
    : "cm-fold-marker cm-fold-folded";
  el.innerHTML = CHEVRON;
  el.style.transform = open ? "rotate(90deg)" : "rotate(0deg)";
  return el;
}

function foldSummary(
  state: EditorState,
  range: { from: number; to: number },
): string {
  const text = state.sliceDoc(range.from, range.to);
  const total = text.match(/[-*]\s\[[ xX]\]/g)?.length ?? 0;
  if (total > 0) {
    const done = text.match(/[-*]\s\[[xX]\]/g)?.length ?? 0;
    return t("ui.editor.fold.tasks", { done, total });
  }
  const lines =
    state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number;
  return t("ui.editor.fold.lines", { n: Math.max(1, lines) });
}

function foldPlaceholderDOM(
  summary: string,
  onclick: (e: Event) => void,
): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-foldPlaceholder";
  el.textContent = `⋯ ${summary}`;
  el.onclick = onclick;
  return el;
}

function editorFeatures(cfg: EditorConfig): Extension[] {
  const ext: Extension[] = [];
  if (cfg.line_numbers) ext.push(lineNumbers());
  if (cfg.folding) {
    ext.push(
      foldGutter({ markerDOM: foldMarkerDOM }),
      codeFolding({
        preparePlaceholder: (state, range) => foldSummary(state, range),
        placeholderDOM: (_view, onclick, prepared) =>
          foldPlaceholderDOM(String(prepared ?? ""), onclick),
      }),
    );
  }
  if (cfg.active_line) {
    ext.push(highlightActiveLine(), highlightActiveLineGutter());
  }
  if (cfg.bracket_matching) ext.push(bracketMatching());
  if (cfg.close_brackets) ext.push(closeBrackets());
  if (cfg.highlight_matches) ext.push(highlightSelectionMatches());
  return ext;
}

export async function languageFor(
  path: string,
): Promise<LanguageSupport | null> {
  const name = basename(path);
  const lower = name.split(".").pop()?.toLowerCase() ?? "";
  if (lower === "md" || lower === "markdown" || lower === "mdx") {
    return conflictTolerant(
      markdown({ base: markdownLanguage, codeLanguages: languages }),
    );
  }
  if (lower === "astro") return conflictTolerant(astro());
  let desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) {
    // Svelte has no CodeMirror grammar; HTML is the closest approximation.
    if (lower === "svelte") {
      desc = languages.find((l) => l.name === "HTML") ?? null;
    }
  }
  return desc ? conflictTolerant(await desc.load()) : null;
}

// The diff compares against the in-memory HEAD snapshot, which Shirei never
// writes back. "Reject" reverts a hunk to its committed text; "accept" would
// only dismiss the highlight without committing anything (commits live in the
// console), so we surface revert only and swallow the misleading accept control.
function diffControl(
  type: "reject" | "accept",
  action: (e: MouseEvent) => void,
): HTMLElement {
  if (type === "accept") {
    const hidden = document.createElement("span");
    hidden.style.display = "none";
    return hidden;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-diff-revert";
  b.title = t("ui.editor.diff.revertHint");
  b.setAttribute("aria-label", t("ui.editor.diff.revert"));
  b.innerHTML = REVERT;
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    action(e);
  });
  return b;
}

export class EditorSession {
  readonly id: string;
  readonly path: string;
  private readonly container: HTMLElement;
  private view: EditorView | null = null;
  private baseMtime = 0;
  private fontSize: number;
  private fontFamily: string;
  private palette: TerminalColors;
  private preset: "dark" | "light";
  private editorCfg: EditorConfig;
  private gitCfg: GitConfig;
  private diffOn = false;
  private blameOn = false;
  private blameBtn: HTMLButtonElement | null = null;
  onDirtyChange?: (dirty: boolean) => void;
  onHistory?: () => void;

  constructor(
    id: string,
    path: string,
    container: HTMLElement,
    look: {
      fontFamily: string;
      fontSize: number;
      palette: TerminalColors;
      preset: "dark" | "light";
      editor: EditorConfig;
      git: GitConfig;
    },
  ) {
    this.id = id;
    this.path = path;
    this.container = container;
    this.fontSize = look.fontSize;
    this.fontFamily = look.fontFamily;
    this.palette = look.palette;
    this.preset = look.preset;
    this.editorCfg = look.editor;
    this.gitCfg = look.git;
  }

  private indentExt(): Extension {
    return this.editorCfg.indent_guides
      ? editorIndentMarkers(this.palette)
      : [];
  }

  private liveExt(): Extension {
    return isProse(this.path) && this.editorCfg.live_preview
      ? livePreview(this.palette, parentDir(this.path))
      : [];
  }

  // Toggles an inline diff of the working file against its committed (HEAD)
  // version; chunks can be reverted in place. Git commits stay in the console.
  async toggleDiff(): Promise<void> {
    if (!this.view) return;
    if (this.diffOn) {
      this.diffOn = false;
      this.view.dispatch({ effects: diffConf.reconfigure([]) });
      return;
    }
    const head = await gitFileHead(this.path);
    if (head == null) {
      showToast(t("ui.editor.diff.none"));
      return;
    }
    this.diffOn = true;
    this.view.dispatch({
      effects: diffConf.reconfigure([
        unifiedMergeView({
          original: head,
          mergeControls: diffControl,
          collapseUnchanged: { margin: 3, minSize: 6 },
        }),
        EditorState.phrases.of({
          "$ unchanged lines": t("ui.editor.diff.collapsed"),
        }),
      ]),
    });
  }

  async open(): Promise<void> {
    const file = await readFile(this.path);
    this.baseMtime = file.mtime;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        vimConf.of(this.editorCfg.vim ? vim() : []),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        scrollPastEnd(),
        featuresConf.of(editorFeatures(this.editorCfg)),
        indentConf.of(this.indentExt()),
        livePreviewConf.of(this.liveExt()),
        conflictResolver(),
        diffConf.of([]),
        blameConf.of([]),
        keymap.of([
          {
            key: "Mod-Alt-d",
            run: () => {
              void this.toggleDiff();
              return true;
            },
          },
        ]),
        search({
          top: true,
          createPanel: (view) => searchPanel(view, this.editorCfg),
        }),
        isProse(this.path) ? keymap.of(markdownEditKeymap) : [],
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        languageConf.of([]),
        readingConf.of(readingFor(this.path, this.editorCfg)),
        themeConf.of(
          editorThemeFromPalette(
            this.palette,
            this.preset,
            this.fontSize,
            this.fontFamily,
          ),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onDirtyChange?.(true);
        }),
      ],
    });
    this.view = new EditorView({ state, parent: this.container });
    this.container.appendChild(this.chromeButtons());
    const lang = await languageFor(this.path);
    if (lang) this.view.dispatch({ effects: languageConf.reconfigure(lang) });
    if (this.gitCfg.blame.enabled) void this.setBlame(true, false);
  }

  private chromeButtons(): HTMLElement {
    const group = document.createElement("div");
    group.className = "editor-chrome";
    const history = this.chromeButton(HISTORY, t("cmd.git.history"), () =>
      this.onHistory?.(),
    );
    this.blameBtn = this.chromeButton(BLAME, t("cmd.git.blame-toggle"), () =>
      this.toggleBlame(),
    );
    group.append(history, this.blameBtn);
    return group;
  }

  private chromeButton(
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "editor-chrome-btn";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = icon;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    return btn;
  }

  toggleBlame(): void {
    void this.setBlame(!this.blameOn, true);
  }

  private async setBlame(on: boolean, explicit: boolean): Promise<void> {
    if (!this.view) return;
    if (!on) {
      this.blameOn = false;
      this.view.dispatch({ effects: blameConf.reconfigure([]) });
      this.blameBtn?.classList.remove("active");
      return;
    }
    const lines = await gitBlame(this.path);
    if (!this.view) return;
    if (lines.length === 0) {
      if (explicit) showToast(t("ui.git.blame.notRepo"));
      return;
    }
    this.blameOn = true;
    this.view.dispatch({
      effects: blameConf.reconfigure(
        blameAnnotations(lines, { delayMs: this.gitCfg.blame.delay_ms }),
      ),
    });
    this.blameBtn?.classList.add("active");
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
    this.editorCfg = { ...this.editorCfg, vim: on };
    this.view?.dispatch({
      effects: vimConf.reconfigure(on ? vim() : []),
    });
  }

  applyEditorConfig(cfg: EditorConfig): void {
    this.editorCfg = cfg;
    this.view?.dispatch({
      effects: [
        featuresConf.reconfigure(editorFeatures(cfg)),
        vimConf.reconfigure(cfg.vim ? vim() : []),
        readingConf.reconfigure(readingFor(this.path, cfg)),
        indentConf.reconfigure(this.indentExt()),
        livePreviewConf.reconfigure(this.liveExt()),
      ],
    });
  }

  private reapplyTheme(): void {
    this.view?.dispatch({
      effects: [
        themeConf.reconfigure(
          editorThemeFromPalette(
            this.palette,
            this.preset,
            this.fontSize,
            this.fontFamily,
          ),
        ),
        indentConf.reconfigure(this.indentExt()),
        livePreviewConf.reconfigure(this.liveExt()),
      ],
    });
  }

  applyLook(
    family: string,
    size: number,
    palette: TerminalColors,
    preset: "dark" | "light",
  ): void {
    this.fontFamily = family;
    this.fontSize = size;
    this.palette = palette;
    this.preset = preset;
    this.reapplyTheme();
  }

  dispose(): void {
    this.view?.destroy();
    this.view = null;
    this.container.remove();
  }
}
