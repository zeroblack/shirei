export function nextSectionIndex(
  count: number,
  current: number,
  key: string,
): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
    case "j":
      return (current + 1) % count;
    case "ArrowUp":
    case "k":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}
