import { markdownKeymap } from "@codemirror/lang-markdown";
import { EditorSelection } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";

// Wraps each selection in `mark` (e.g. ** for bold); empty selections leave the
// cursor between the inserted marks.
function wrap(mark: string): (view: EditorView) => boolean {
  return (view) => {
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(
          range.from + mark.length,
          range.to + mark.length,
        ),
      })),
    );
    return true;
  };
}

function insertLink(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const insert = `[${text}]()`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length - 1),
      };
    }),
  );
  return true;
}

// Markdown editing keys for prose files. markdownKeymap continues and renumbers
// lists/quotes on Enter and unwraps markup on Backspace.
export const markdownEditKeymap: KeyBinding[] = [
  { key: "Mod-b", run: wrap("**") },
  { key: "Mod-i", run: wrap("*") },
  { key: "Mod-k", run: insertLink },
  ...markdownKeymap,
];
