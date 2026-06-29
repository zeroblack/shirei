import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type GitCommit,
  gitFileAt,
  gitFileHistory,
  readFile,
} from "./commands";
import type { Config, TerminalColors } from "./config";
import { relativeTime } from "./dates";
import { languageFor } from "./editor";
import { editorThemeFromPalette } from "./editor-theme";
import { t } from "./i18n";
import { CLOSE, COPY, fileIcon } from "./icons";
import { createOverlay } from "./overlay";
import { basename } from "./path";
import { showToast } from "./toast";

type EditorConfig = Config["editor"];

export interface HistoryLook {
  fontFamily: string;
  fontSize: number;
  palette: TerminalColors;
  preset: "dark" | "light";
  editor: EditorConfig;
  defaultView: "diff" | "full";
}

function hiddenControl(): HTMLElement {
  const s = document.createElement("span");
  s.style.display = "none";
  return s;
}

function dot(): HTMLElement {
  const d = document.createElement("span");
  d.className = "githist-bar-dot";
  d.textContent = "·";
  return d;
}

export class GitHistory {
  private overlay: ReturnType<typeof createOverlay> | null = null;
  private list!: HTMLElement;
  private detail!: HTMLElement;
  private detailBar!: HTMLElement;
  private detailMain!: HTMLElement;
  private detailView: EditorView | null = null;
  private commits: GitCommit[] = [];
  private selected = 0;
  private mode: "diff" | "full" = "diff";
  private path = "";
  private working = "";
  private workingOk = true;
  private theme: Extension = [];
  private lang: Extension = [];
  private size: { w: number; h: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly cache = new Map<string, string | null>();

  async open(path: string, look: HistoryLook): Promise<void> {
    this.path = path;
    this.mode = look.defaultView;
    this.theme = editorThemeFromPalette(
      look.palette,
      look.preset,
      look.fontSize,
      look.fontFamily,
    );
    this.lang = (await languageFor(path)) ?? [];
    const [history, content] = await Promise.all([
      gitFileHistory(path),
      readFile(path)
        .then((f) => f.content)
        .catch(() => null),
    ]);
    this.commits = history;
    this.workingOk = content !== null;
    this.working = content ?? "";
    this.selected = 0;
    this.render();
    if (this.commits.length) void this.showCommit(0);
  }

  private render(): void {
    this.close();
    const ov = createOverlay({
      className: "githist",
      label: t("ui.git.history.title"),
      onDismiss: () => this.close(),
      closeDurationMs: 130,
    });
    this.overlay = ov;

    const header = document.createElement("div");
    header.className = "githist-header";
    const icon = document.createElement("span");
    icon.className = "githist-file-icon";
    icon.innerHTML = fileIcon(basename(this.path), false, false);
    const name = document.createElement("span");
    name.className = "githist-file-name";
    name.textContent = basename(this.path);
    const count = document.createElement("span");
    count.className = "githist-count";
    count.textContent = t("ui.git.history.commits", {
      n: this.commits.length,
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "githist-close";
    closeBtn.title = t("ui.git.history.hintClose");
    closeBtn.setAttribute("aria-label", t("ui.git.history.hintClose"));
    closeBtn.innerHTML = CLOSE;
    closeBtn.addEventListener("click", () => this.close());
    header.append(icon, name, count, closeBtn);

    const body = document.createElement("div");
    body.className = "githist-body";
    this.list = document.createElement("div");
    this.list.className = "githist-list";
    this.list.setAttribute("role", "listbox");
    this.list.tabIndex = 0;
    this.detail = document.createElement("div");
    this.detail.className = "githist-detail";
    this.detailBar = document.createElement("div");
    this.detailBar.className = "githist-detail-bar";
    this.detailMain = document.createElement("div");
    this.detailMain.className = "githist-detail-main";
    this.detail.append(this.detailBar, this.detailMain);
    body.append(this.list, this.detail);

    this.list.addEventListener("keydown", (e) => this.onListKey(e));
    ov.box.addEventListener("keydown", (e) => this.onBoxKey(e), true);
    ov.box.append(header, body, this.footer());
    document.body.appendChild(ov.overlay);
    if (this.size) {
      ov.box.style.width = `${this.size.w}px`;
      ov.box.style.height = `${this.size.h}px`;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.size = { w: ov.box.offsetWidth, h: ov.box.offsetHeight };
    });
    this.resizeObserver.observe(ov.box);
    this.renderList();
    this.list.focus();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (!this.commits.length) {
      const empty = document.createElement("div");
      empty.className = "githist-empty";
      empty.textContent = t("ui.git.history.empty");
      this.list.appendChild(empty);
      this.detailBar.replaceChildren();
      this.detailMain.replaceChildren();
      return;
    }
    this.commits.forEach((c, i) => {
      const row = document.createElement("div");
      row.className =
        i === this.selected ? "githist-row selected" : "githist-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.selected));

      const top = document.createElement("div");
      top.className = "githist-row-top";
      const sha = document.createElement("span");
      sha.className = "githist-sha";
      sha.textContent = c.shortSha;
      const date = document.createElement("span");
      date.className = "githist-date";
      date.textContent = relativeTime(c.date);
      top.append(sha, date);

      const summary = document.createElement("div");
      summary.className = "githist-summary";
      summary.textContent = c.summary;

      const author = document.createElement("div");
      author.className = "githist-author";
      author.textContent = c.author;

      row.append(top, summary, author);
      row.addEventListener("click", () => {
        this.selected = i;
        this.renderList();
        void this.showCommit(i);
      });
      this.list.appendChild(row);
    });
    this.list
      .querySelector(".githist-row.selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private async showCommit(index: number): Promise<void> {
    const commit = this.commits[index];
    if (!commit) return;
    this.renderBar(commit);
    const cached = this.cache.get(commit.sha);
    if (cached !== undefined) {
      this.applyContent(cached);
      return;
    }
    this.setDetailMessage(t("ui.git.history.loading"));
    const content = await this.contentAt(commit.sha);
    if (!this.overlay || this.selected !== index) return;
    this.applyContent(content);
  }

  private applyContent(content: string | null): void {
    if (content == null) this.setDetailMessage(t("ui.git.history.binary"));
    else this.mountDetail(content);
  }

  private renderBar(commit: GitCommit): void {
    this.detailBar.replaceChildren();

    const meta = document.createElement("div");
    meta.className = "githist-bar-meta";
    const author = document.createElement("span");
    author.className = "githist-bar-author";
    author.textContent = commit.author;
    const date = document.createElement("span");
    date.className = "githist-bar-date";
    date.textContent = relativeTime(commit.date);
    const sha = document.createElement("button");
    sha.type = "button";
    sha.className = "githist-bar-sha";
    sha.title = t("ui.git.history.hintCopySha");
    sha.innerHTML = `<span>${commit.shortSha}</span>${COPY}`;
    sha.addEventListener("click", () => this.copySha(commit.sha));
    meta.append(author, dot(), date, sha);

    const seg = document.createElement("div");
    seg.className = "githist-seg";
    seg.append(
      this.segButton("diff", t("ui.git.history.viewDiff")),
      this.segButton("full", t("ui.git.history.viewFull")),
    );

    const right = document.createElement("div");
    right.className = "githist-bar-right";
    const key = document.createElement("kbd");
    key.className = "githist-key";
    key.textContent = "d";
    right.append(key, seg);

    this.detailBar.append(meta, right);
  }

  private segButton(mode: "diff" | "full", label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      this.mode === mode ? "githist-seg-btn active" : "githist-seg-btn";
    b.textContent = label;
    b.addEventListener("click", () => this.setMode(mode));
    return b;
  }

  private setMode(mode: "diff" | "full"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    void this.showCommit(this.selected);
  }

  private copySha(sha: string): void {
    void navigator.clipboard.writeText(sha);
    showToast(t("ui.git.history.shaCopied"));
  }

  private async contentAt(sha: string): Promise<string | null> {
    const cached = this.cache.get(sha);
    if (cached !== undefined) return cached;
    const content = await gitFileAt(this.path, sha);
    this.cache.set(sha, content);
    return content;
  }

  private detailState(content: string): EditorState {
    const base: Extension[] = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      this.theme,
      this.lang,
    ];
    // Without a readable working copy a diff would render as an all-deleted
    // file, so fall back to showing the committed version as-is.
    if (this.mode !== "diff" || !this.workingOk) {
      return EditorState.create({ doc: content, extensions: base });
    }
    return EditorState.create({
      doc: this.working,
      extensions: [
        ...base,
        unifiedMergeView({
          original: content,
          mergeControls: hiddenControl,
          collapseUnchanged: { margin: 3, minSize: 6 },
        }),
      ],
    });
  }

  private mountDetail(content: string): void {
    const state = this.detailState(content);
    if (this.detailView) {
      this.detailView.setState(state);
      return;
    }
    this.detailMain.replaceChildren();
    this.detailView = new EditorView({ state, parent: this.detailMain });
  }

  private setDetailMessage(message: string): void {
    this.detailView?.destroy();
    this.detailView = null;
    this.detailMain.replaceChildren();
    const el = document.createElement("div");
    el.className = "githist-detail-message";
    el.textContent = message;
    this.detailMain.appendChild(el);
  }

  private onListKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(
      this.commits.length - 1,
      Math.max(0, this.selected + dir),
    );
    if (next === this.selected) return;
    this.selected = next;
    this.renderList();
    void this.showCommit(next);
  }

  // Capture phase so Esc/d/y win over the read-only diff editor, which would
  // otherwise swallow Escape and trap the user inside the panel.
  private onBoxKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key.toLowerCase() === "d") {
      e.preventDefault();
      e.stopPropagation();
      this.setMode(this.mode === "diff" ? "full" : "diff");
    } else if (e.key.toLowerCase() === "y") {
      e.preventDefault();
      e.stopPropagation();
      const commit = this.commits[this.selected];
      if (commit) this.copySha(commit.sha);
    }
  }

  private footer(): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "githist-footer";
    const add = (keys: string[], label: string): void => {
      const item = document.createElement("span");
      item.className = "githist-hint";
      for (const k of keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = k;
        item.appendChild(kbd);
      }
      item.append(document.createTextNode(label));
      footer.appendChild(item);
    };
    add(["↑", "↓"], t("ui.git.history.hintNavigate"));
    add(["d"], t("ui.git.history.hintView"));
    add(["y"], t("ui.git.history.hintCopySha"));
    add(["esc"], t("ui.git.history.hintClose"));
    return footer;
  }

  private close(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detailView?.destroy();
    this.detailView = null;
    void this.overlay?.close();
    this.overlay = null;
    this.cache.clear();
  }
}
