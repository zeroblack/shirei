import { pickProjectDir } from "../config";

export interface FieldOpts {
  desc?: string;
  stack?: boolean;
}

export function field(
  label: string,
  control: HTMLElement,
  opts: FieldOpts = {},
): HTMLElement {
  const row = document.createElement("div");
  row.className = opts.stack ? "field field--stack" : "field";
  const text = document.createElement("div");
  text.className = "field-text";
  const lbl = document.createElement("span");
  lbl.className = "field-label";
  lbl.textContent = label;
  text.appendChild(lbl);
  if (opts.desc) {
    const desc = document.createElement("span");
    desc.className = "field-desc";
    desc.textContent = opts.desc;
    text.appendChild(desc);
  }
  const ctrl = document.createElement("div");
  ctrl.className = "field-control";
  ctrl.appendChild(control);
  row.append(text, ctrl);
  return row;
}

export function select<T extends string>(
  options: [T, string][],
  value: T,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const el = document.createElement("select");
  for (const [val, label] of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (val === value) opt.selected = true;
    el.appendChild(opt);
  }
  el.addEventListener("change", () => onChange(el.value as T));
  return el;
}

export function numberInput(
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void,
  step = 1,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "number";
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = String(value);
  el.addEventListener("change", () => {
    const clamped = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(clamped);
    onChange(clamped);
  });
  return el;
}

export function textInput(
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function checkbox(
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "toggle-wrap";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "toggle-input";
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  track.className = "toggle";
  track.setAttribute("aria-hidden", "true");
  wrap.append(input, track);
  return wrap;
}

export function colorInput(
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.value = value;
  el.addEventListener("input", () => onChange(el.value));
  return el;
}

export function fieldsGrid(rows: HTMLElement[]): HTMLElement {
  const body = document.createElement("div");
  body.className = "section-fields";
  body.append(...rows);
  return body;
}

export function section(
  title: string,
  rows: HTMLElement[],
  desc?: string,
): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "settings-section";
  const h = document.createElement("h2");
  h.textContent = title;
  sec.appendChild(h);
  if (desc) {
    const p = document.createElement("p");
    p.className = "section-desc";
    p.textContent = desc;
    sec.appendChild(p);
  }
  sec.appendChild(fieldsGrid(rows));
  return sec;
}

export function iconButton(
  svg: string,
  className: string,
  title: string,
  onClick: () => void,
  opts: { stopPropagation?: boolean } = {},
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = svg;
  btn.addEventListener("click", (e) => {
    if (opts.stopPropagation) e.stopPropagation();
    onClick();
  });
  return btn;
}

export interface PathFieldOpts {
  desc?: string;
  placeholder?: string;
  browseLabel: string;
  reset?: { label: string; value: string };
}

export function pathField(
  label: string,
  value: string,
  onChange: (path: string) => void,
  opts: PathFieldOpts,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "path-field";

  const current = document.createElement("input");
  current.type = "text";
  current.readOnly = true;
  current.value = value;
  if (opts.placeholder) current.placeholder = opts.placeholder;

  const apply = (path: string): void => {
    current.value = path;
    onChange(path);
  };

  const browse = document.createElement("button");
  browse.className = "path-browse";
  browse.textContent = opts.browseLabel;
  browse.addEventListener("click", async () => {
    const picked = await pickProjectDir();
    if (picked) apply(picked);
  });
  wrap.append(current, browse);

  if (opts.reset) {
    const resetTo = opts.reset.value;
    const reset = document.createElement("button");
    reset.className = "path-browse";
    reset.textContent = opts.reset.label;
    reset.addEventListener("click", () => apply(resetTo));
    wrap.append(reset);
  }

  return field(label, wrap, { stack: true, desc: opts.desc });
}

export function groupLabel(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "field-group";
  h.textContent = text;
  return h;
}

type Save = () => void;

export function boolField<K extends string>(
  label: string,
  obj: Record<K, boolean>,
  key: K,
  save: Save,
  desc?: string,
): HTMLElement {
  return field(
    label,
    checkbox(obj[key], (v) => {
      obj[key] = v;
      save();
    }),
    { desc },
  );
}

export interface NumFieldOpts {
  min: number;
  max: number;
  step?: number;
  /** Stored value = shown value × scale (e.g. MB shown, bytes stored). */
  scale?: number;
  desc?: string;
}

export function numField<K extends string>(
  label: string,
  obj: Record<K, number>,
  key: K,
  opts: NumFieldOpts,
  save: Save,
): HTMLElement {
  const scale = opts.scale ?? 1;
  return field(
    label,
    numberInput(
      scale === 1 ? obj[key] : Math.round(obj[key] / scale),
      opts.min,
      opts.max,
      (v) => {
        obj[key] = v * scale;
        save();
      },
      opts.step,
    ),
    { desc: opts.desc },
  );
}

export function textField<K extends string>(
  label: string,
  obj: Record<K, string>,
  key: K,
  save: Save,
  placeholder?: string,
  desc?: string,
): HTMLElement {
  const input = textInput(obj[key], (v) => {
    obj[key] = v;
    save();
  });
  if (placeholder) input.placeholder = placeholder;
  return field(label, input, { desc });
}

export function selectField<K extends string, V extends string>(
  label: string,
  options: [V, string][],
  obj: Record<K, V>,
  key: K,
  save: Save,
  desc?: string,
): HTMLElement {
  return field(
    label,
    select(options, obj[key], (v) => {
      obj[key] = v;
      save();
    }),
    { desc },
  );
}

export function colorField<K extends string>(
  label: string,
  obj: Record<K, string>,
  key: K,
  save: Save,
): HTMLElement {
  return field(
    label,
    colorInput(obj[key], (v) => {
      obj[key] = v;
      save();
    }),
  );
}

export function swatchRow(
  count: number,
  get: (i: number) => string,
  set: (i: number, v: string) => void,
  save: Save,
  titleOf?: (i: number) => string,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "swatches";
  for (let i = 0; i < count; i++) {
    const input = colorInput(get(i), (v) => {
      set(i, v);
      save();
    });
    const title = titleOf?.(i);
    if (title) input.title = title;
    wrap.appendChild(input);
  }
  return wrap;
}
