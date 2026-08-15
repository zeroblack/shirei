export const promptLine = (prompt: string): string =>
  `${prompt.replace(/\s*\n\s*/g, " ").trim()}\r`;
