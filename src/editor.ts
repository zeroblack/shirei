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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { contentBounds } from "./browser-core";
import {
  gitBlame,
  gitFileHead,
  previewClose,
  previewHide,
  previewOpen,
  previewSetBounds,
  previewShow,
  readFile,
  writeFile,
} from "./commands";
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
import { BLAME, BROWSER_GLYPH, CHEVRON, DIFF, HISTORY, REVERT } from "./icons";
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
const HTML_EXTS = new Set(["html", "htm"]);

const SAVED_VISIBLE_MS = 1500;

// The native preview webview floats ABOVE the DOM and would otherwise cover
// the editor's chrome buttons (top-right, 26px tall starting at top:10px);
// leaving this strip keeps them clickable, and a DOM click there always
// reaches the main webview regardless of native first-responder — so the
// globe toggle stays the exit affordance no matter what the preview holds.
const PREVIEW_TOP_STRIP = 44;

function extOf(path: string): string | undefined {
  return (path.split("/").pop() ?? path).split(".").pop()?.toLowerCase();
}

function isProse(path: string): boolean {
  const ext = extOf(path);
  return ext !== undefined && PROSE_EXTS.has(ext);
}

function isHtml(path: string): boolean {
  const ext = extOf(path);
  return ext !== undefined && HTML_EXTS.has(ext);
}

// Prose (markdown/txt) wraps to a readable measure; code keeps no-wrap with
// horizontal scroll so indentation stays intact. The cap is a CSS max-width on
// .cm-content, the block container — never on .cm-line or its inline children,
// which throws off CodeMirror's per-visual-row vertical motion (ArrowUp/Down
// land at the logical line start instead of the row above) and the caret.
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

// CodeMirror renders only the viewport, so the DOM selection a native copy
// serializes stops at the last rendered line. The clipboard event is filled
// synchronously from the document state instead: an async clipboard write
// races the native one and the loser silently wins the pasteboard.
function selectionText(state: EditorState): string | null {
  const parts = state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to));
  return parts.length > 0 ? parts.join("\n") : null;
}

const documentCopy = EditorView.domEventHandlers({
  copy(event, view) {
    const target = event.target;
    if (!(target instanceof Node) || !view.contentDOM.contains(target))
      return false;
    const text = selectionText(view.state);
    if (!text || !event.clipboardData) return false;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    return true;
  },
});

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
  private readonly readOnlyContent: string | null;
  private diffOn = false;
  private blameOn = false;
  private diffBtn: HTMLButtonElement | null = null;
  private blameBtn: HTMLButtonElement | null = null;
  private previewBtn: HTMLButtonElement | null = null;
  private readonly previewLabel =
    `preview-${getCurrentWindow().label}-${crypto.randomUUID().slice(0, 8)}`;
  private previewObserver: ResizeObserver | null = null;
  private previewOn = false;
  private dirty = false;
  private autosaveTimer: number | null = null;
  private savedEl: HTMLElement | null = null;
  private savedTimer: number | null = null;
  onDirtyChange?: (dirty: boolean) => void;
  onHistory?: () => void;
  onSaveRequest?: () => Promise<boolean>;
  private previewToggling = false;

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
      readOnlyContent?: string;
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
    this.readOnlyContent = look.readOnlyContent ?? null;
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
    if (!this.view || this.readOnlyContent !== null) return;
    if (this.diffOn) {
      this.diffOn = false;
      this.diffBtn?.classList.remove("active");
      this.view.dispatch({ effects: diffConf.reconfigure([]) });
      return;
    }
    const head = await gitFileHead(this.path);
    if (head == null) {
      showToast(t("ui.editor.diff.none"));
      return;
    }
    this.diffOn = true;
    this.diffBtn?.classList.add("active");
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
    const readOnly = this.readOnlyContent !== null;
    let doc: string;
    if (readOnly) {
      doc = this.readOnlyContent as string;
    } else {
      const file = await readFile(this.path);
      this.baseMtime = file.mtime;
      doc = file.content;
    }
    const state = EditorState.create({
      doc,
      extensions: [
        readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [],
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
        documentCopy,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            this.dirty = true;
            this.onDirtyChange?.(true);
            this.scheduleAutosave();
          }
        }),
      ],
    });
    this.view = new EditorView({ state, parent: this.container });
    this.container.appendChild(this.chromeButtons());
    this.container.appendChild(this.savedIndicator());
    const lang = await languageFor(this.path);
    if (lang) this.view.dispatch({ effects: languageConf.reconfigure(lang) });
    if (!readOnly && this.gitCfg.blame.enabled) void this.setBlame(true, false);
  }

  private chromeButtons(): HTMLElement {
    const group = document.createElement("div");
    group.className = "editor-chrome";
    const history = this.chromeButton(HISTORY, t("cmd.git.history"), () =>
      this.onHistory?.(),
    );
    group.append(history);
    // Diffing and blaming a HEAD snapshot against itself carries no signal,
    // so a read-only ghost view keeps only history from the working toolbar.
    if (this.readOnlyContent === null) {
      this.diffBtn = this.chromeButton(
        DIFF,
        t("ui.editor.diff.toggle"),
        () => void this.toggleDiff(),
      );
      this.blameBtn = this.chromeButton(BLAME, t("cmd.git.blame-toggle"), () =>
        this.toggleBlame(),
      );
      group.append(this.diffBtn, this.blameBtn);
    }
    if (this.readOnlyContent === null && isHtml(this.path)) {
      this.previewBtn = this.chromeButton(
        BROWSER_GLYPH,
        t("ui.editor.preview.toggle"),
        () => void this.togglePreview(),
      );
      group.append(this.previewBtn);
    }
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
    if (this.readOnlyContent !== null) return;
    void this.setBlame(!this.blameOn, true);
  }

  isPreviewable(): boolean {
    return this.readOnlyContent === null && isHtml(this.path);
  }

  async togglePreview(): Promise<void> {
    if (!isHtml(this.path) || this.previewToggling) return;
    if (this.previewOn) {
      this.previewToggling = true;
      try {
        this.previewObserver?.disconnect();
        this.previewObserver = null;
        await previewClose(this.previewLabel);
        this.previewOn = false;
        this.previewBtn?.classList.remove("active");
        if (this.view) this.view.dom.style.display = "";
        this.view?.focus();
      } finally {
        this.previewToggling = false;
      }
      return;
    }
    this.previewToggling = true;
    try {
      // Reflect unsaved edits in the render, but never show a stale preview
      // silently: a failed/conflicted save aborts the toggle so the user keeps
      // seeing (and can fix) their code, with the app's own save UI surfacing why.
      if (this.dirty) {
        const saved = this.onSaveRequest
          ? await this.onSaveRequest()
          : (await this.save()).ok;
        if (!saved) return;
      }
      this.previewOn = true;
      this.previewBtn?.classList.add("active");
      if (this.view) this.view.dom.style.display = "none";
      const b = this.previewBounds();
      try {
        await previewOpen(
          this.previewLabel,
          this.path,
          b.x,
          b.y,
          b.width,
          b.height,
        );
      } catch (e) {
        this.previewOn = false;
        this.previewBtn?.classList.remove("active");
        if (this.view) this.view.dom.style.display = "";
        showToast(errorMessage(e));
        return;
      }
      this.previewObserver = new ResizeObserver(() => this.syncPreviewBounds());
      this.previewObserver.observe(this.container);
    } finally {
      this.previewToggling = false;
    }
  }

  private previewBounds() {
    return contentBounds(
      this.container.getBoundingClientRect(),
      PREVIEW_TOP_STRIP,
    );
  }

  private syncPreviewBounds(): void {
    if (!this.previewOn) return;
    const b = this.previewBounds();
    void previewSetBounds(this.previewLabel, b.x, b.y, b.width, b.height);
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
    // A ghost/HEAD view is never dirty, but Cmd+S reaches every editor
    // unconditionally — without this guard it would happily recreate a
    // deleted file on disk from its own read-only buffer.
    if (this.readOnlyContent !== null) return { ok: true };
    return this.write(this.baseMtime);
  }

  async saveForce(): Promise<SaveResult> {
    if (this.readOnlyContent !== null) return { ok: true };
    return this.write(null);
  }

  private async write(known: number | null): Promise<SaveResult> {
    if (!this.view) return { ok: false };
    const data = this.view.state.doc.toString();
    try {
      this.baseMtime = await writeFile(this.path, data, known);
      this.dirty = false;
      this.clearAutosave();
      this.onDirtyChange?.(false);
      this.flashSaved();
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        conflict: errorCode(e) === "write-conflict",
        error: errorMessage(e),
      };
    }
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    if (!this.editorCfg.autosave || this.editorCfg.autosave_delay_ms <= 0)
      return;
    this.autosaveTimer = window.setTimeout(
      () => void this.autosave(),
      this.editorCfg.autosave_delay_ms,
    );
  }

  private clearAutosave(): void {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  // Autosave never prompts: a stale-mtime conflict leaves the file dirty and
  // reschedules on the next edit, so the user resolves it through a manual save.
  private async autosave(): Promise<void> {
    this.autosaveTimer = null;
    if (!this.dirty) return;
    await this.write(this.baseMtime);
  }

  private savedIndicator(): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-saved";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = t("ui.editor.saved");
    this.savedEl = el;
    return el;
  }

  private flashSaved(): void {
    if (!this.savedEl) return;
    this.savedEl.classList.add("visible");
    if (this.savedTimer !== null) window.clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      this.savedEl?.classList.remove("visible");
      this.savedTimer = null;
    }, SAVED_VISIBLE_MS);
  }

  show(visible: boolean): void {
    this.container.classList.toggle("active", visible);
  }

  // The single authority for the preview webview's visibility: called from the
  // app-level sync, never from show() — a content-pane file editor is shown
  // through PaneGrid.activate() and never calls EditorSession.show() at all, so
  // folding this into show() would leave that flow's preview stuck on-screen.
  setPreviewVisible(visible: boolean): void {
    if (!this.previewOn) return;
    if (visible) void previewShow(this.previewLabel);
    else void previewHide(this.previewLabel);
  }

  focus(): void {
    this.view?.focus();
  }

  // Selection and copy operate on the CodeMirror document state, never the DOM.
  // CodeMirror only renders the visible viewport, so a native "select all" and a
  // DOM-selection copy would capture only the on-screen lines — this always sees
  // the whole document.
  selectAll(): void {
    const view = this.view;
    if (!view) return;
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  }

  setVim(on: boolean): void {
    this.editorCfg = { ...this.editorCfg, vim: on };
    this.view?.dispatch({
      effects: vimConf.reconfigure(on ? vim() : []),
    });
  }

  applyEditorConfig(cfg: EditorConfig): void {
    this.editorCfg = cfg;
    if (this.dirty) this.scheduleAutosave();
    else this.clearAutosave();
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
    this.clearAutosave();
    if (this.savedTimer !== null) window.clearTimeout(this.savedTimer);
    this.previewObserver?.disconnect();
    this.previewObserver = null;
    if (this.previewOn) void previewClose(this.previewLabel);
    this.view?.destroy();
    this.view = null;
    this.container.remove();
  }
}
