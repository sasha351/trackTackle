// ---------------------------------------------------------------------------
// AUTHORED FROM KNOWLEDGE, NOT RECORDED FROM LIVE WIKIPEDIA.
//
// This sandbox has no network egress to en.wikipedia.org (see the design spec's
// "Sandbox constraint" section — CONNECT to wikipedia.org 403s here). Every
// sample below was hand-written to reproduce the *shapes* real
// `{{Infobox musical artist}}` genre fields take (flatlist/hlist wrappers, ref
// tags, HTML comments, piped links, malformed markup), not copy-pasted from an
// actual article revision.
//
// What this fixture set measures, and what it does NOT:
//   - It DOES measure `parseInfoboxGenres`'s accuracy against realistic
//     wikitext markup — the parser's ability to slice a brace/bracket-depth
//     field, strip refs/comments, unwrap links, and normalize.
//   - It does NOT measure end-to-end coverage of real Wikipedia articles.
//     Real infoboxes vary in ways a hand-authored set cannot fully anticipate
//     (template redirects, locale-specific field names, unusual editor style).
//     Only `benchmark.live.test.ts`, run on a machine with egress, measures that.
// This distinction must be carried into the final report — do not present
// parser-fixture numbers as a proxy for real-world coverage.
// ---------------------------------------------------------------------------

export interface WikitextFixture {
  artist: string;
  wikitext: string;
  /** Lowercase, order matching what parseInfoboxGenres should emit. */
  expected: string[];
}

export const WIKITEXT_FIXTURES: WikitextFixture[] = [
  // {{flatlist}} wrapper, bulleted, piped display on one entry.
  {
    artist: 'Radiohead',
    wikitext: `'''Radiohead''' are an English rock band formed in Abingdon, Oxfordshire, in 1985.

{{Infobox musical artist
| name = Radiohead
| origin = Abingdon, Oxfordshire, England
| genre = {{flatlist|
* [[Alternative rock]]
* [[Art rock]]
* [[Electronic music|Electronic]]
}}
| years_active = 1985–present
}}`,
    expected: ['alternative rock', 'art rock', 'electronic'],
  },

  // {{hlist}} wrapper — pipes inside it are NOT field separators, the naive
  // /\|\s*genre\s*=([^|]*)/ regex fails here.
  {
    artist: 'Travis Scott',
    wikitext: `'''Travis Scott''' is an American rapper and record producer from Houston, Texas.

{{Infobox musical artist
| name = Travis Scott
| genre = {{hlist|[[Hip hop music|Hip hop]]|[[Trap music (hip hop)|Trap]]}}
| birth_place = Houston, Texas, U.S.
}}`,
    expected: ['hip hop', 'trap'],
  },

  // Plain comma-separated bare wikilinks, no wrapper template.
  {
    artist: 'Nirvana',
    wikitext: `'''Nirvana''' was an American rock band formed in Aberdeen, Washington, in 1987.

{{Infobox musical artist
| name = Nirvana
| genre = [[Grunge]], [[alternative rock]]
| origin = Aberdeen, Washington, U.S.
}}`,
    expected: ['grunge', 'alternative rock'],
  },

  // Single piped link followed by a self-closing <ref/> — no closing tag at all.
  {
    artist: 'IU',
    wikitext: `'''IU''' is a South Korean singer-songwriter who debuted in 2008.

{{Infobox musical artist
| name = IU
| genre = [[K-pop]]<ref name="billboard"/>
| birth_name = Lee Ji-eun
}}`,
    expected: ['k-pop'],
  },

  // HTML comment mid-field, plus a piped link and a bare one.
  {
    artist: 'Aria Popstar',
    wikitext: `'''Aria Popstar''' is a fictional pop singer used here only to exercise the parser.

{{Infobox musical artist
| name = Aria Popstar
| genre = [[Pop music|Pop]]<!-- do not add unsourced genres -->, [[dance-pop]]
| years_active = 2015–present
}}`,
    expected: ['pop', 'dance-pop'],
  },

  // A full <ref>...</ref> whose *contents* contain their own braces and pipes
  // ({{cite web|...}}) — the depth tracker must consume the whole ref as one
  // unit rather than getting confused by the pipes inside it.
  {
    artist: 'Slowdive',
    wikitext: `'''Slowdive''' are an English rock band formed in Reading, Berkshire, in 1989.

{{Infobox musical artist
| name = Slowdive
| genre = [[Shoegaze]]<ref>{{cite web|title=Slowdive biography|url=https://example.com/slowdive|access-date=2020-01-01}}</ref>, [[dream pop]]
| origin = Reading, Berkshire, England
}}`,
    expected: ['shoegaze', 'dream pop'],
  },

  // Trailing " music" suffix that must be stripped during normalization.
  {
    artist: 'Ambient Drifter',
    wikitext: `'''Ambient Drifter''' is a fictional electronic act used here only to exercise the parser.

{{Infobox musical artist
| name = Ambient Drifter
| genre = [[Ambient music]], [[Electronic music]]
| instrument = Synthesizer
}}`,
    expected: ['ambient', 'electronic'],
  },

  // Infobox present, but genre is simply not one of the fields.
  {
    artist: 'Fictional Session Band',
    wikitext: `'''Fictional Session Band''' is a fictional group used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Session Band
| origin = Nashville, Tennessee, U.S.
| years_active = 1998–2004
| label = Independent
}}`,
    expected: [],
  },

  // No infobox at all — a short stub-style lead.
  {
    artist: 'Fictional Prose Only',
    wikitext: `'''Fictional Prose Only''' is a fictional solo artist used here only to exercise the parser.
Little biographical detail is publicly available, and no infobox has been added to the article.`,
    expected: [],
  },

  // Unbalanced/malformed braces — the flatlist wrapper never closes. Real
  // articles do end up in this state mid-edit-war or after a bad revert.
  // ponytail: we assert `[]` here, not "best-effort recovery of the two links
  // inside" — with the outer template unterminated, the safe, spec-compliant
  // behaviour (Finding 4: "never throw") is to fail to find a *closed* genre
  // field rather than guess where it ends. A parser that got fancier about
  // recovering partial matches would need its own dedicated fixture, not this
  // one; this one's job is only to prove malformed input doesn't throw.
  {
    artist: 'Fictional Malformed Entry',
    wikitext: `'''Fictional Malformed Entry''' is a fictional band used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Malformed Entry
| genre = {{flatlist|
* [[Post-punk]]
* [[Gothic rock]]
| years_active = 2001–present
}}`,
    expected: [],
  },

  // Mixed bare + piped comma list, three entries.
  {
    artist: 'Fictional UK Drill Artist',
    wikitext: `'''Fictional UK Drill Artist''' is a fictional rapper used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional UK Drill Artist
| genre = [[Grime music|Grime]], [[UK garage]], [[2-step garage|2-step]]
| origin = London, England
}}`,
    expected: ['grime', 'uk garage', '2-step'],
  },

  // {{hlist}} plus a trailing ref, and a target/display split with " music"
  // suffix stripped inside the piped display text itself.
  {
    artist: 'Fictional City Pop Artist',
    wikitext: `'''Fictional City Pop Artist''' is a fictional singer used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional City Pop Artist
| genre = {{hlist|[[City pop]]|[[Yacht rock music|Yacht rock]]}}<ref>{{cite news|title=Fictional City Pop Artist profile}}</ref>
| years_active = 1979–1986
}}`,
    expected: ['city pop', 'yacht rock'],
  },

  // {{flatlist}} with a single unbulleted entry — the shortest legal form.
  {
    artist: 'Fictional Witch House Artist',
    wikitext: `'''Fictional Witch House Artist''' is a fictional collective used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Witch House Artist
| genre = {{flatlist|[[Witch house]]}}
| origin = United States
}}`,
    expected: ['witch house'],
  },

  // {{hlist}} with three bare (unpiped) targets.
  {
    artist: 'Fictional Sludge Metal Band',
    wikitext: `'''Fictional Sludge Metal Band''' is a fictional group used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Sludge Metal Band
| genre = {{hlist|[[Sludge metal]]|[[Doom metal]]|[[Southern rock]]}}
| origin = New Orleans, Louisiana, U.S.
}}`,
    expected: ['sludge metal', 'doom metal', 'southern rock'],
  },

  // Field must stop at the next `| field =` line at depth 0, not swallow it —
  // this is the case the naive "everything up to the next pipe" regex handles
  // by accident and a depth-aware one must handle on purpose.
  {
    artist: 'Fictional Field Boundary Artist',
    wikitext: `'''Fictional Field Boundary Artist''' is a fictional singer used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Field Boundary Artist
| genre = [[Pop music|Pop]], [[R&B]]
| years_active = 2010–present
| label = Fictional Records
}}`,
    expected: ['pop', 'r&b'],
  },

  // Degenerate field: only a comment and a self-closing ref, no genre text at all.
  {
    artist: 'Fictional Empty Genre Field',
    wikitext: `'''Fictional Empty Genre Field''' is a fictional artist used here only to exercise the parser.

{{Infobox musical artist
| name = Fictional Empty Genre Field
| genre = <!-- unsourced, do not add --><ref name="disputed"/>
| origin = Unknown
}}`,
    expected: [],
  },
];
