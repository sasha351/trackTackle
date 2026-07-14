export interface ClusterSuggestion {
  genre: string;
  trackIds: string[];
}

export function suggestClusters(
  songs: { trackId: string; genres: string[] }[],
  minSize = 5,
): ClusterSuggestion[] {
  const remaining = new Map(songs.map((s) => [s.trackId, s] as const));
  const out: ClusterSuggestion[] = [];
  for (;;) {
    const byGenre = new Map<string, string[]>();
    for (const s of remaining.values()) {
      for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) {
        byGenre.set(g, [...(byGenre.get(g) ?? []), s.trackId]);
      }
    }
    const biggest = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!biggest || biggest[1].length < minSize) return out;
    out.push({ genre: biggest[0], trackIds: biggest[1] });
    for (const id of biggest[1]) remaining.delete(id);
  }
}
