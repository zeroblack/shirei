import {
  allTemplates,
  type Config,
  type Project,
  pathIsGitRepo,
  pickProjectDir,
} from "../config";
import { t } from "../i18n";
import { type PaneNode, sameStructure } from "../panetree";
import { basename } from "../path";
import type { SettingsSection } from "./shell";
import { colorInput, field, iconButton, select } from "./widgets";

const EMPTY_TREE: PaneNode = { kind: "leaf", id: "" };

const PENCIL =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const FOLDER =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';

const firstTemplateTree = (config: Config): PaneNode =>
  structuredClone(config.templates?.[0]?.tree ?? EMPTY_TREE);

function removeButton(title: string, onRemove: () => void): HTMLButtonElement {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "project-remove";
  remove.textContent = "✕";
  remove.title = title;
  remove.addEventListener("click", onRemove);
  return remove;
}

async function refreshBadge(badge: HTMLElement, path: string): Promise<void> {
  if (!path) {
    badge.textContent = t("settings.projects.noPath");
    badge.className = "git-badge none";
    return;
  }
  const ok = await pathIsGitRepo(path);
  badge.textContent = ok
    ? t("settings.projects.git")
    : t("settings.projects.noGit");
  badge.className = ok ? "git-badge ok" : "git-badge none";
}

function projectItem(
  project: Project,
  onEdit: () => void,
  onDelete: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "project-item";
  item.tabIndex = 0;
  item.dataset.search = `${project.name} ${project.path}`.toLowerCase();
  item.addEventListener("click", onEdit);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onEdit();
    }
  });

  const dot = document.createElement("span");
  dot.className = "project-dot";
  dot.style.background = project.color;

  const meta = document.createElement("div");
  meta.className = "project-meta";
  const name = document.createElement("span");
  name.className = "project-name";
  name.textContent = project.name;
  const path = document.createElement("span");
  path.className = "project-path";
  path.textContent = project.path || t("settings.projects.noPath");
  meta.append(name, path);

  const badge = document.createElement("span");
  void refreshBadge(badge, project.path);

  const actions = document.createElement("div");
  actions.className = "project-actions";
  actions.append(
    iconButton(
      PENCIL,
      "project-icon-btn",
      t("settings.projects.edit"),
      onEdit,
      {
        stopPropagation: true,
      },
    ),
    iconButton(
      TRASH,
      "project-icon-btn",
      t("settings.projects.remove"),
      onDelete,
      { stopPropagation: true },
    ),
  );

  item.append(dot, meta, badge, actions);
  return item;
}

function projectEditor(
  config: Config,
  save: () => void,
  project: Project,
  onBack: () => void,
): HTMLElement {
  const wrap = document.createElement("div");

  const live = (): Project =>
    config.projects.find((p) => p.id === project.id) ?? project;

  const back = document.createElement("button");
  back.type = "button";
  back.className = "project-back";
  back.textContent = t("settings.projects.back");
  back.addEventListener("click", onBack);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = t("settings.projects.namePlaceholder");
  nameInput.value = project.name;
  nameInput.addEventListener("change", () => {
    const p = live();
    p.name = nameInput.value.trim() || p.name;
    save();
  });

  const badge = document.createElement("span");
  badge.className = "git-badge";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.placeholder = t("settings.projects.pathPlaceholder");
  pathInput.value = project.path;
  const setPath = (p: string): void => {
    live().path = p;
    pathInput.value = p;
    save();
    void refreshBadge(badge, p);
  };
  pathInput.addEventListener("change", () => setPath(pathInput.value.trim()));
  void refreshBadge(badge, project.path);
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "path-browse";
  browse.textContent = t("settings.projects.browse");
  browse.addEventListener("click", async () => {
    const picked = await pickProjectDir();
    if (picked) setPath(picked);
  });
  const pathField = document.createElement("div");
  pathField.className = "path-field";
  pathField.append(pathInput, browse, badge);

  const colorEl = colorInput(project.color, (v) => {
    live().color = v;
    save();
  });

  const templates = allTemplates(config);
  const layoutOptions: [string, string][] = templates.map((tpl) => [
    tpl.name,
    tpl.name,
  ]);
  const current = templates.findIndex((tpl) =>
    sameStructure(tpl.tree, project.tree),
  );
  const layoutSel = select<string>(
    layoutOptions,
    current >= 0 ? templates[current].name : (layoutOptions[0]?.[0] ?? ""),
    (v) => {
      const match = templates.find((tpl) => tpl.name === v);
      if (match) {
        live().tree = structuredClone(match.tree);
        save();
      }
    },
  );

  const remove = removeButton(t("settings.projects.removeProject"), () => {
    const idx = config.projects.findIndex((p) => p.id === project.id);
    if (idx !== -1) config.projects.splice(idx, 1);
    save();
    onBack();
  });
  remove.classList.add("project-delete");
  remove.textContent = t("settings.projects.removeProject");
  const removeRow = document.createElement("div");
  removeRow.className = "project-delete-row";
  removeRow.append(remove);

  wrap.append(
    back,
    field(t("settings.projects.field.name"), nameInput),
    field(t("settings.projects.field.folder"), pathField, { stack: true }),
    field(t("settings.projects.field.color"), colorEl),
    field(t("settings.projects.field.layout"), layoutSel),
    removeRow,
  );
  return wrap;
}

function templatesBlock(config: Config, save: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "projects-templates";
  const h = document.createElement("h3");
  h.textContent = t("settings.projects.templates");
  wrap.appendChild(h);

  if (config.user_templates.length === 0) {
    const hint = document.createElement("p");
    hint.className = "templates-hint";
    hint.textContent = t("settings.projects.templatesHint");
    wrap.appendChild(hint);
    return wrap;
  }

  const list = document.createElement("div");
  list.className = "projects-list";
  wrap.appendChild(list);

  const rebuild = (): void => {
    list.replaceChildren();
    for (const tpl of config.user_templates) {
      const row = document.createElement("div");
      row.className = "template-row";
      const nameEl = document.createElement("span");
      nameEl.className = "template-name";
      nameEl.textContent = tpl.name;
      const remove = removeButton(t("settings.projects.removeTemplate"), () => {
        const idx = config.user_templates.findIndex(
          (other) => other.name === tpl.name,
        );
        if (idx !== -1) config.user_templates.splice(idx, 1);
        save();
        rebuild();
      });
      row.append(nameEl, remove);
      list.appendChild(row);
    }
  };
  rebuild();
  return wrap;
}

function buildProjects(config: Config, save: () => void): HTMLElement {
  const sec = document.createElement("section");
  let editingId: string | null = null;
  let query = "";

  const newButton = (label: string): HTMLElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "project-add";
    btn.textContent = label;
    btn.addEventListener("click", () => void createProject());
    return btn;
  };

  const createProject = async (): Promise<void> => {
    const picked = await pickProjectDir();
    const project: Project = {
      id: crypto.randomUUID(),
      name: picked
        ? basename(picked)
        : t("settings.projects.defaultName", {
            n: config.projects.length + 1,
          }),
      path: picked ?? "",
      color: config.theme.tabs[0],
      tree: firstTemplateTree(config),
    };
    config.projects.push(project);
    save();
    editingId = project.id;
    render();
  };

  const listView = (): HTMLElement => {
    const wrap = document.createElement("div");

    const head = document.createElement("div");
    head.className = "projects-head";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "projects-search";
    search.placeholder = t("settings.projects.searchPlaceholder");
    search.value = query;
    wrap.append(head);

    const list = document.createElement("div");
    list.className = "projects-grid";

    const count = document.createElement("div");
    count.className = "projects-count";
    const setCount = (n: number): void => {
      count.textContent =
        n === config.projects.length
          ? t(
              n === 1
                ? "settings.projects.countOne"
                : "settings.projects.countMany",
              { n },
            )
          : t("settings.projects.countFiltered", {
              shown: n,
              total: config.projects.length,
            });
    };
    setCount(config.projects.length);

    search.addEventListener("input", () => {
      query = search.value;
      const q = query.trim().toLowerCase();
      let shown = 0;
      for (const el of list.querySelectorAll<HTMLElement>(".project-item")) {
        const hit = !q || (el.dataset.search ?? "").includes(q);
        el.style.display = hit ? "" : "none";
        if (hit) shown += 1;
      }
      setCount(shown);
    });
    head.append(search, newButton(t("settings.projects.new")));

    if (config.projects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "projects-empty";
      const icon = document.createElement("div");
      icon.className = "projects-empty-icon";
      icon.innerHTML = FOLDER;
      const title = document.createElement("p");
      title.className = "projects-empty-title";
      title.textContent = t("settings.projects.emptyTitle");
      const desc = document.createElement("p");
      desc.className = "projects-empty-desc";
      desc.textContent = t("settings.projects.emptyDesc");
      empty.append(
        icon,
        title,
        desc,
        newButton(t("settings.projects.newProject")),
      );
      wrap.append(empty);
      return wrap;
    }

    for (const project of config.projects) {
      list.append(
        projectItem(
          project,
          () => {
            editingId = project.id;
            render();
          },
          () => {
            const idx = config.projects.findIndex((p) => p.id === project.id);
            if (idx !== -1) config.projects.splice(idx, 1);
            save();
            render();
          },
        ),
      );
    }
    wrap.append(count, list, templatesBlock(config, save));
    return wrap;
  };

  const render = (): void => {
    sec.replaceChildren();
    const editing = editingId
      ? config.projects.find((p) => p.id === editingId)
      : undefined;
    if (editing) {
      sec.append(
        projectEditor(config, save, editing, () => {
          editingId = null;
          render();
        }),
      );
    } else {
      const h = document.createElement("h2");
      h.textContent = t("settings.projects.title");
      sec.append(h, listView());
    }
  };

  render();
  return sec;
}

export const projectsSection: SettingsSection = {
  id: "projects",
  label: () => t("settings.projects.title"),
  searchText: (config) =>
    `${t("settings.projects.search")} ${config.projects.map((p) => p.name).join(" ")}`,
  build: (config, save) => buildProjects(config, save),
};
