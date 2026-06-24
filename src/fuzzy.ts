/**
 * Best `k` items by `cmp` (negative = `a` ranks first) without sorting the
 * full input: binary-insert into a bounded array, O(n·log k) comparisons.
 * Worth it for quickopen, where the index can hold hundreds of thousands of
 * entries while only a page of results is shown.
 */
export function topK<T>(
  items: Iterable<T>,
  k: number,
  cmp: (a: T, b: T) => number,
): T[] {
  if (k <= 0) return [];
  const top: T[] = [];
  for (const item of items) {
    if (top.length === k && cmp(item, top[top.length - 1]) >= 0) continue;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(item, top[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    top.splice(lo, 0, item);
    if (top.length > k) top.pop();
  }
  return top;
}

export function fuzzyMatch(query: string, target: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === prevMatch + 1 ? 4 : 1;
      if (ti === 0 || "/._-".includes(t[ti - 1])) score += 2;
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/**
 * Indices in `target` that the greedy subsequence match of `query` lands on,
 * for highlighting. Mirrors `fuzzyMatch`'s matching so the highlighted chars
 * are exactly the ones that scored. Returns null when there is no match.
 */
export function fuzzyPositions(query: string, target: string): number[] | null {
  if (query.length === 0) return [];
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const out: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      out.push(ti);
      qi++;
    }
  }
  return qi === q.length ? out : null;
}
