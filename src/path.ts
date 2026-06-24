export function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(i + 1) : clean;
}

export function parentDir(path: string): string {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}
