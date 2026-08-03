// ponytail: every `spotifyId` below is `null`. This sandbox has no Spotify OAuth
// (see CLAUDE.md's `.env.local` note and the design spec's "Sandbox constraint"
// section), so there is no way to look up a real artist's Spotify id here — and
// fabricating one would silently poison the Wikidata P1902 join in
// `src/api/wikipedia.ts` (id → wrong artist, or id → nothing) and produce a fake
// benchmark result that *looks* like a measurement. The live harness
// (`src/genre/benchmark.live.test.ts`) reports the join-hit count — the number
// of these ids Wikidata actually resolved — precisely so that gap is visible
// rather than papered over. A real run on a machine with both Spotify OAuth and
// network egress should replace these `null`s with ids pulled from an actual
// library before the numbers are trusted.

export interface BenchmarkArtist {
  name: string;
  spotifyId: string | null;
  /** Lowercase, most-specific-first. Ground truth for precision/recall — only
   *  labels the author is genuinely confident about, never a guess. */
  expected: string[];
  bucket: 'mainstream' | 'niche' | 'non-latin';
}

export const BENCHMARK_ARTISTS: BenchmarkArtist[] = [
  // --- mainstream: control group — widely-known acts Spotify already tags well ---
  { name: 'Taylor Swift', spotifyId: null, expected: ['pop'], bucket: 'mainstream' },
  { name: 'The Beatles', spotifyId: null, expected: ['rock', 'pop rock'], bucket: 'mainstream' },
  { name: 'Beyoncé', spotifyId: null, expected: ['r&b', 'pop'], bucket: 'mainstream' },
  { name: 'Kendrick Lamar', spotifyId: null, expected: ['hip hop', 'rap'], bucket: 'mainstream' },
  { name: 'Ed Sheeran', spotifyId: null, expected: ['pop'], bucket: 'mainstream' },
  { name: 'Adele', spotifyId: null, expected: ['pop', 'soul'], bucket: 'mainstream' },
  { name: 'Coldplay', spotifyId: null, expected: ['alternative rock', 'pop rock'], bucket: 'mainstream' },
  { name: 'Metallica', spotifyId: null, expected: ['metal', 'thrash metal'], bucket: 'mainstream' },
  { name: 'Daft Punk', spotifyId: null, expected: ['electronic', 'house'], bucket: 'mainstream' },
  { name: 'Bruno Mars', spotifyId: null, expected: ['pop', 'funk'], bucket: 'mainstream' },
  { name: 'Drake', spotifyId: null, expected: ['hip hop', 'rap'], bucket: 'mainstream' },
  { name: 'Radiohead', spotifyId: null, expected: ['alternative rock', 'art rock'], bucket: 'mainstream' },
  { name: 'Rihanna', spotifyId: null, expected: ['pop', 'r&b'], bucket: 'mainstream' },
  { name: 'Eminem', spotifyId: null, expected: ['hip hop', 'rap'], bucket: 'mainstream' },
  { name: 'Ariana Grande', spotifyId: null, expected: ['pop', 'r&b'], bucket: 'mainstream' },
  { name: 'Nirvana', spotifyId: null, expected: ['grunge', 'alternative rock'], bucket: 'mainstream' },
  { name: 'Billie Eilish', spotifyId: null, expected: ['pop', 'electropop'], bucket: 'mainstream' },

  // --- niche: the point of this benchmark — artists defined by a *subgenre* ---
  { name: 'My Bloody Valentine', spotifyId: null, expected: ['shoegaze', 'noise pop', 'alternative rock'], bucket: 'niche' },
  { name: 'Slowdive', spotifyId: null, expected: ['shoegaze', 'dream pop'], bucket: 'niche' },
  { name: 'Macintosh Plus', spotifyId: null, expected: ['vaporwave'], bucket: 'niche' },
  { name: 'Salem', spotifyId: null, expected: ['witch house'], bucket: 'niche' },
  { name: 'MJ Cole', spotifyId: null, expected: ['uk garage', '2-step'], bucket: 'niche' },
  { name: 'Wiley', spotifyId: null, expected: ['grime', 'uk garage'], bucket: 'niche' },
  { name: 'Skepta', spotifyId: null, expected: ['grime'], bucket: 'niche' },
  { name: 'Headie One', spotifyId: null, expected: ['uk drill', 'drill'], bucket: 'niche' },
  { name: 'Pop Smoke', spotifyId: null, expected: ['brooklyn drill', 'drill'], bucket: 'niche' },
  { name: 'The Dillinger Escape Plan', spotifyId: null, expected: ['mathcore', 'hardcore'], bucket: 'niche' },
  { name: 'Meshuggah', spotifyId: null, expected: ['djent', 'progressive metal'], bucket: 'niche' },
  { name: 'Tatsuro Yamashita', spotifyId: null, expected: ['city pop', 'yacht rock'], bucket: 'niche' },
  { name: 'Mariya Takeuchi', spotifyId: null, expected: ['city pop', 'yacht rock'], bucket: 'niche' },
  { name: 'Mortiis', spotifyId: null, expected: ['dungeon synth', 'ambient'], bucket: 'niche' },
  { name: 'Eyehategod', spotifyId: null, expected: ['sludge metal', 'doom metal'], bucket: 'niche' },
  { name: 'Crowbar', spotifyId: null, expected: ['sludge metal', 'doom metal'], bucket: 'niche' },
  { name: 'Clan of Xymox', spotifyId: null, expected: ['darkwave', 'gothic rock'], bucket: 'niche' },

  // --- non-latin: native name is non-Latin script; Spotify shows a transliterated
  // form (CLAUDE.md, Matching section) — the case name search breaks on ---
  { name: 'BTS', spotifyId: null, expected: ['k-pop', 'pop'], bucket: 'non-latin' }, // 방탄소년단
  { name: 'BLACKPINK', spotifyId: null, expected: ['k-pop', 'pop'], bucket: 'non-latin' }, // 블랙핑크
  { name: 'IU', spotifyId: null, expected: ['k-pop', 'pop'], bucket: 'non-latin' }, // 아이유
  { name: 'Aimer', spotifyId: null, expected: ['j-pop'], bucket: 'non-latin' }, // エメ
  { name: 'Perfume', spotifyId: null, expected: ['technopop', 'j-pop'], bucket: 'non-latin' }, // パフューム
  { name: 'Kyary Pamyu Pamyu', spotifyId: null, expected: ['j-pop', 'electropop'], bucket: 'non-latin' }, // きゃりーぱみゅぱみゅ
  { name: 'Alla Pugacheva', spotifyId: null, expected: ['russian pop', 'pop'], bucket: 'non-latin' }, // Алла Пугачёва
  { name: 'Zemfira', spotifyId: null, expected: ['russian rock', 'alternative rock'], bucket: 'non-latin' }, // Земфира
  { name: 'Kino', spotifyId: null, expected: ['russian rock', 'post-punk'], bucket: 'non-latin' }, // Кино
  { name: 'Fairuz', spotifyId: null, expected: ['arabic pop', 'traditional'], bucket: 'non-latin' }, // فيروز
  { name: 'Amr Diab', spotifyId: null, expected: ['arabic pop', 'pop'], bucket: 'non-latin' }, // عمرو دياب
  { name: 'Umm Kulthum', spotifyId: null, expected: ['arabic classical', 'traditional'], bucket: 'non-latin' }, // أم كلثوم
  { name: 'Teresa Teng', spotifyId: null, expected: ['mandopop', 'pop'], bucket: 'non-latin' }, // 鄧麗君
  { name: 'Jay Chou', spotifyId: null, expected: ['mandopop', 'pop'], bucket: 'non-latin' }, // 周杰倫
  { name: 'Faye Wong', spotifyId: null, expected: ['cantopop', 'mandopop'], bucket: 'non-latin' }, // 王菲
  { name: 'Cui Jian', spotifyId: null, expected: ['chinese rock', 'rock'], bucket: 'non-latin' }, // 崔健
];
