export interface BufferLineLike {
  translateToString(trimRight?: boolean): string;
}

export interface ActiveBufferLike {
  baseY: number;
  cursorY: number;
  getLine(y: number): BufferLineLike | undefined;
}

export function lineUnderCursor(buf: ActiveBufferLike): string {
  const line = buf.getLine(buf.baseY + buf.cursorY);
  return line ? line.translateToString(true) : "";
}
