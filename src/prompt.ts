import { t } from "./i18n";
import { createOverlay } from "./overlay";

export function promptText(
  title: string,
  initial = "",
): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (value: string | null): void => {
      close();
      resolve(value);
    };
    const { overlay, box, close } = createOverlay({
      className: "prompt",
      label: title,
      onDismiss: () => done(null),
      closeDurationMs: 130,
    });

    const label = document.createElement("div");
    label.className = "prompt-title";
    label.id = `prompt-title-${Date.now().toString(36)}`;
    label.textContent = title;
    box.setAttribute("aria-labelledby", label.id);

    const input = document.createElement("input");
    input.className = "prompt-input";
    input.value = initial;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value.trim() || null);
      }
    });

    box.append(label, input, promptFooter());
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function promptFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "prompt-footer";
  const add = (key: string, text: string): void => {
    const item = document.createElement("span");
    item.className = "prompt-hint";
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    item.append(kbd, document.createTextNode(text));
    footer.appendChild(item);
  };
  add("↵", t("ui.prompt.hintConfirm"));
  add("esc", t("ui.prompt.hintCancel"));
  return footer;
}
