import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView, Panel } from "@codemirror/view";
import { t } from "./i18n";
import { CHEVRON } from "./icons";

export interface MatchStats {
  count: number;
  current: number;
  valid: boolean;
}

const COUNT_CAP = 5000;

// Total matches of the active query plus the 1-based index of the one under the
// selection. Capped so counting never stalls the UI on huge documents.
export function matchStats(state: EditorState): MatchStats {
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) {
    return { count: 0, current: 0, valid: query.valid };
  }
  const sel = state.selection.main;
  const cursor = query.getCursor(state) as Iterator<{
    from: number;
    to: number;
  }>;
  let count = 0;
  let current = 0;
  for (let r = cursor.next(); !r.done && count < COUNT_CAP; r = cursor.next()) {
    count++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = count;
  }
  return { count, current, valid: true };
}

function iconButton(title: string, rotate: number): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-search-icon";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = CHEVRON;
  const svg = b.firstElementChild as HTMLElement | null;
  if (svg && rotate) svg.style.transform = `rotate(${rotate}deg)`;
  return b;
}

function pill(
  label: string,
  title: string,
  active: boolean,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = active ? "cm-search-pill active" : "cm-search-pill";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.textContent = label;
  return b;
}

function textButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-search-text";
  b.textContent = label;
  return b;
}

function input(placeholder: string, value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "cm-search-input";
  el.placeholder = placeholder;
  el.value = value;
  return el;
}

export interface SearchDefaults {
  search_case: boolean;
  search_regex: boolean;
  search_whole_word: boolean;
}

export function searchPanel(
  view: EditorView,
  defaults?: SearchDefaults,
): Panel {
  const q0 = getSearchQuery(view.state);
  let searchStart = view.state.selection.main.head;

  const dom = document.createElement("div");
  dom.className = "cm-search cm-search-premium";

  const findInput = input(t("ui.editor.find.placeholder"), q0.search);
  findInput.setAttribute("main-field", "true");
  const count = document.createElement("span");
  count.className = "cm-search-count";
  const prev = iconButton(t("ui.editor.find.previous"), -90);
  const next = iconButton(t("ui.editor.find.next"), 90);
  const caseBtn = pill(
    "Aa",
    t("ui.editor.find.matchCase"),
    defaults?.search_case ?? q0.caseSensitive,
  );
  const reBtn = pill(
    ".*",
    t("ui.editor.find.regexp"),
    defaults?.search_regex ?? q0.regexp,
  );
  const wordBtn = pill(
    "W",
    t("ui.editor.find.wholeWord"),
    defaults?.search_whole_word ?? q0.wholeWord,
  );
  const replaceToggle = iconButton(t("ui.editor.find.toggleReplace"), 0);
  replaceToggle.classList.add("cm-search-disclosure");
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cm-search-icon cm-search-close";
  closeBtn.title = t("ui.editor.find.close");
  closeBtn.setAttribute("aria-label", t("ui.editor.find.close"));
  closeBtn.textContent = "×";

  const findRow = document.createElement("div");
  findRow.className = "cm-search-row";
  findRow.append(
    replaceToggle,
    findInput,
    count,
    prev,
    next,
    caseBtn,
    reBtn,
    wordBtn,
    closeBtn,
  );

  const replaceInput = input(
    t("ui.editor.find.replacePlaceholder"),
    q0.replace,
  );
  const replaceBtn = textButton(t("ui.editor.find.replace"));
  const replaceAllBtn = textButton(t("ui.editor.find.replaceAll"));
  const replaceRow = document.createElement("div");
  replaceRow.className = "cm-search-row cm-search-replace";
  replaceRow.style.display = "none";
  replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);

  dom.append(findRow, replaceRow);

  const query = (): SearchQuery =>
    new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive: caseBtn.classList.contains("active"),
      regexp: reBtn.classList.contains("active"),
      wholeWord: wordBtn.classList.contains("active"),
    });

  const renderCount = (): void => {
    if (!findInput.value) {
      count.textContent = "";
      count.classList.remove("cm-search-zero");
      return;
    }
    const s = matchStats(view.state);
    if (!s.valid || s.count === 0) {
      count.textContent = t("ui.editor.find.noResults");
      count.classList.add("cm-search-zero");
    } else {
      count.textContent = t("ui.editor.find.count", {
        current: s.current,
        total: s.count,
      });
      count.classList.remove("cm-search-zero");
    }
  };

  const jumpToFirst = (q: SearchQuery): void => {
    if (!q.search || !q.valid) return;
    let cursor = q.getCursor(view.state, searchStart) as Iterator<{
      from: number;
      to: number;
    }>;
    let r = cursor.next();
    if (r.done) {
      cursor = q.getCursor(view.state, 0) as Iterator<{
        from: number;
        to: number;
      }>;
      r = cursor.next();
    }
    if (!r.done) {
      view.dispatch({
        selection: { anchor: r.value.from, head: r.value.to },
        scrollIntoView: true,
      });
    }
  };

  const commit = (): void => {
    const q = query();
    view.dispatch({ effects: setSearchQuery.of(q) });
    jumpToFirst(q);
    renderCount();
  };

  findInput.addEventListener("input", commit);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
      renderCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  prev.onclick = () => {
    findPrevious(view);
    renderCount();
  };
  next.onclick = () => {
    findNext(view);
    renderCount();
  };
  for (const b of [caseBtn, reBtn, wordBtn]) {
    b.onclick = () => {
      b.classList.toggle("active");
      commit();
      findInput.focus();
    };
  }
  replaceToggle.onclick = () => {
    const show = replaceRow.style.display === "none";
    replaceRow.style.display = show ? "flex" : "none";
    replaceToggle.classList.toggle("active", show);
    if (show) replaceInput.focus();
  };
  closeBtn.onclick = () => {
    closeSearchPanel(view);
    view.focus();
  };
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceNext(view);
      renderCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  replaceBtn.onclick = () => {
    replaceNext(view);
    renderCount();
  };
  replaceAllBtn.onclick = () => {
    replaceAll(view);
    renderCount();
  };

  return {
    dom,
    top: true,
    mount() {
      searchStart = view.state.selection.main.head;
      const q = getSearchQuery(view.state);
      if (q.search && !findInput.value) findInput.value = q.search;
      findInput.focus();
      findInput.select();
      renderCount();
    },
    update(u) {
      if (u.docChanged || u.selectionSet) renderCount();
    },
  };
}
