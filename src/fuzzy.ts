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
