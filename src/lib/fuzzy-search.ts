/**
 * Character-subsequence match scoring for a single field.
 *
 * +1 per matched character
 * +2 for each character that immediately follows another matched character
 *    in the target string (consecutive runs). Runs restart after a
 *    non-matching character. The first character of each run gets this bonus.
 * +3 if the first matched character is at a word boundary
 *    (after `-`, `_`, uppercase transition, or start of string)
 * +5 if the first matched character is at index 0 of the field
 *
 * Returns 0 when no subsequence match is found.
 */
function scoreField(query: string, target: string): number {
  if (query.length === 0) return 0;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatched = false;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const isFirstChar = qi === 0;
      const charBefore = ti > 0 ? target[ti - 1] : "";
      const isWordBoundary =
        ti === 0 ||
        charBefore === "-" ||
        charBefore === "_" ||
        (charBefore >= "a" && charBefore <= "z" && target[ti] >= "A" && target[ti] <= "Z");

      score += 1;
      if (prevMatched) score += 2;
      if (isFirstChar && isWordBoundary) score += 3;
      if (ti === 0) score += 5;

      prevMatched = true;
      qi++;
    } else {
      prevMatched = false;
    }
  }

  // Not all query characters matched — no subsequence found
  if (qi < q.length) return 0;

  return score;
}

interface ScoredCandidate<T> {
  candidate: T;
  nameScore: number;
  descriptionScore: number;
  index: number;
}

/**
 * Filter and rank candidates by character-subsequence match.
 *
 * Candidates with a name match (nameScore > 0) appear first, sorted by
 * nameScore descending. Candidates matching only in the description appear
 * after, sorted by descriptionScore descending. Ties preserve source order.
 *
 * Empty query returns all candidates in source order (no filtering).
 */
export function fuzzyMatch<T>(
  query: string,
  candidates: readonly T[],
  keyFn: (c: T) => string,
  descriptionFn?: (c: T) => string | undefined,
): T[] {
  if (query.length === 0) return [...candidates];

  const scored: ScoredCandidate<T>[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const nameScore = scoreField(query, keyFn(candidate));

    let descriptionScore = 0;
    if (descriptionFn) {
      const desc = descriptionFn(candidate);
      if (desc && desc.length > 0) {
        descriptionScore = scoreField(query, desc);
      }
    }

    if (nameScore > 0 || descriptionScore > 0) {
      scored.push({ candidate, nameScore, descriptionScore, index: i });
    }
  }

  // Segregated ranking: name matches first, then description-only matches
  scored.sort((a, b) => {
    // Both have name scores — sort by name score desc, then index for stability
    if (a.nameScore > 0 && b.nameScore > 0) {
      const diff = b.nameScore - a.nameScore;
      if (diff !== 0) return diff;
      return a.index - b.index;
    }
    // Only A has a name score — A comes first
    if (a.nameScore > 0) return -1;
    // Only B has a name score — B comes first
    if (b.nameScore > 0) return 1;
    // Neither has a name score — sort by description score desc, then index
    const diff = b.descriptionScore - a.descriptionScore;
    if (diff !== 0) return diff;
    return a.index - b.index;
  });

  return scored.map((s) => s.candidate);
}
