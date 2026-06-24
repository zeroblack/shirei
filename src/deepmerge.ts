function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Merges `source` into `target` in place, recursing into nested plain objects so
// their references survive. Settings widgets capture nested config objects (e.g.
// config.font, config.theme.terminal) once at build time; replacing those
// references on every config-changed event would strand the widgets on stale
// objects and silently drop later edits. Arrays and primitives are overwritten.
export function assignDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    const next = source[key];
    const prev = target[key];
    if (isPlainObject(prev) && isPlainObject(next)) {
      assignDeep(prev, next);
    } else {
      target[key] = next;
    }
  }
}
