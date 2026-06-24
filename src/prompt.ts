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

    box.append(label, input);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
