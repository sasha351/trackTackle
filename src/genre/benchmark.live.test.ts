import { describe, expect, it, vi } from 'vitest';
import { lookupGenresBulk as mbLookupGenresBulk } from '../api/musicbrainz';
import { lookupGenresBulk as wikiLookupGenresBulk, resetWikipediaForTests } from '../api/wikipedia';
import { BENCHMARK_ARTISTS } from './fixtures/benchmarkArtists';
import { formatTable, scoreProvider, type ArtistResult } from './benchmark';

// Real-network A/B harness. Gated behind an env var so it NEVER runs in
// `npx vitest run` or CI -- only when a human explicitly opts in on a machine
// with egress to musicbrainz.org and Wikimedia. This sandbox 403s CONNECT to
// both hosts at the proxy (verified by curl and WebFetch -- see the design
// spec's "Sandbox constraint" section), so this file cannot be executed here.
// It is written to be correct and runnable elsewhere, and verified *offline*
// by confirming the suite reports it as skipped rather than erroring.
//
// `process` isn't declared here: tsconfig.app.json's `types` list is
// deliberately just `["vite/client", "vitest/globals"]` (the app is
// browser-only and must not widen to Node globals), so a bare `process.env`
// reference fails `tsc -b`. `process` exists at runtime regardless (Vitest
// runs on Node) -- this reads it through an inline-cast `globalThis` instead
// of adding a `declare global` that would leak the ambient type app-wide.
const LIVE = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TRACK_TACKLE_LIVE_BENCH,
);

// Generous: MusicBrainz alone serializes one request per ~1100ms
// (MIN_SPACING_MS in musicbrainz.ts), and with ~48 artists all forced down
// the serial name-search path (see the ponytail comment below) that's
// upwards of a minute for MB by itself, on top of Wikipedia's pool.
const LIVE_TIMEOUT_MS = 15 * 60 * 1000;

// ponytail: every BENCHMARK_ARTISTS.spotifyId is `null` (see
// fixtures/benchmarkArtists.ts's own ponytail comment -- no OAuth in this
// sandbox, and fabricating a real-looking id would silently poison a join
// with a wrong-artist match rather than a clean miss). There is therefore no
// real Spotify id to key the fast join path on for EITHER provider: not
// Wikidata's P1902 (src/api/wikipedia.ts's sparqlJoin) and not MusicBrainz's
// `/url?resource=` lookup (src/api/musicbrainz.ts's bulk URL mapping). The
// synthetic ids below exist only so `lookupGenresBulk`'s `{id, name}` shape
// has something to key off of; being fabricated, they are guaranteed to
// never match a real join, so BOTH providers fall through to their serial
// per-artist name-search path here. That is the only path this harness can
// fairly compare apples-to-apples without real OAuth. IMPORTANT: the
// id-join path (P1902 for Wikipedia, /url?resource= for MusicBrainz) is what
// production actually uses via resolveAllGenres, and it is faster for BOTH
// providers than what this harness measures -- treat every number below as
// this harness's slow-path floor, not as the number that should decide
// "should this ship as the default".
const syntheticId = (name: string) => `bench-${name.replace(/\s+/g, '-').toLowerCase()}`;

// A real browser can't omit a User-Agent -- it always sends its own, even
// though page JS is forbidden from setting/overriding it (the reason
// musicbrainz.ts and wikipedia.ts send none). Node's fetch sends none by
// default. Verified live: an un-identified Node request 403s on MusicBrainz
// ("has not identified itself") and 429s on Wikipedia -- on every single
// artist, not a rate-limit edge case -- while the identical request with a
// UA header succeeds. Without this the harness measures "how Node gets
// treated," not "how the shipped browser code gets treated." Wikimedia's
// policy asks automated tools for a descriptive UA with contact info:
// https://meta.wikimedia.org/wiki/User-Agent_policy
// The URL has to stay a real repo address — it is how MusicBrainz reaches a
// human about a misbehaving client, so it tracks the repo name rather than the
// product name.
const BENCH_USER_AGENT = 'track-tackle-benchmark/1.0 (https://github.com/sasha351/trackTackle; live A/B harness, not the shipped app)';

// Counts fetch calls made while the returned spy is active, and stamps a UA
// header (see BENCH_USER_AGENT) without otherwise changing behaviour --
// every call still hits the real network via `realFetch`. The count lives on
// a boxed object (`counter.count`), not a returned primitive, so callers see
// it update live rather than capturing a snapshot of 0 taken before any
// request happened.
function requestCounter(): { counter: { count: number }; restore: () => void } {
  const realFetch = globalThis.fetch.bind(globalThis);
  const counter = { count: 0 };
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    counter.count += 1;
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', BENCH_USER_AGENT);
    return realFetch(input, { ...init, headers });
  });
  return { counter, restore: () => spy.mockRestore() };
}

function toArtistResults(
  actual: Map<string, string[]>,
  artists: { id: string; name: string; expected: string[] }[],
): ArtistResult[] {
  return artists.map((a) => ({
    name: a.name,
    actual: actual.get(a.id),
    expected: a.expected,
  }));
}

describe.skipIf(!LIVE)('live provider A/B benchmark (set TRACK_TACKLE_LIVE_BENCH=1 to run)', () => {
  it(
    'drives MusicBrainz and Wikipedia over BENCHMARK_ARTISTS and reports effectiveness (A), latency (B), and the Wikidata join-hit count (C)',
    async () => {
      const artists = BENCHMARK_ARTISTS.map((a) => ({
        id: syntheticId(a.name),
        name: a.name,
        expected: a.expected,
      }));

      // -- MusicBrainz ---------------------------------------------------
      // nameSearch defaults to true in musicbrainz.ts's lookupGenresBulk, but
      // pass it explicitly so the "both providers forced down name search"
      // claim above is visible at the call site, not just implied by a default.
      const mb = requestCounter();
      const mbStart = Date.now();
      const mbResult = await mbLookupGenresBulk(artists, undefined, undefined, { nameSearch: true });
      const mbElapsedMs = Date.now() - mbStart;
      mb.restore();

      // -- Wikipedia -------------------------------------------------------
      // Pass 1: join-only (nameSearch off, infobox off) purely to count how
      // many artists resolved via the P1902 join alone. onPhase fires
      // 'searching' exactly for artists the join did NOT find a title for
      // (see lookupGenresBulk's join-miss loop in wikipedia.ts), so
      // (total - artists that triggered 'searching') is the join-hit count.
      // With every id synthetic, this is provably 0 here -- not a limitation
      // of the instrumentation, a fact about having no real ids to join on.
      resetWikipediaForTests();
      const searchTriggeredFor = new Set<string>();
      const wikiJoinOnly = requestCounter();
      await wikiLookupGenresBulk(artists, undefined, undefined, {
        nameSearch: false,
        infobox: false,
        onPhase: (phase, artistName) => {
          if (phase === 'searching' && artistName) searchTriggeredFor.add(artistName);
        },
      });
      wikiJoinOnly.restore();
      const joinHitCount = artists.length - searchTriggeredFor.size;

      // Pass 2: full run (name search + infobox) for the real A/B numbers.
      // Reset first: pass 1 wrote a title cache (tracktackle:wd-titles:v1) that
      // would let pass 2 skip the join entirely and understate its request
      // count.
      resetWikipediaForTests();
      const wiki = requestCounter();
      const wikiStart = Date.now();
      const wikiResult = await wikiLookupGenresBulk(artists, undefined, undefined, {
        nameSearch: true,
        infobox: true,
      });
      const wikiElapsedMs = Date.now() - wikiStart;
      wiki.restore();

      // -- (A) Effectiveness -------------------------------------------------
      const mbRow = scoreProvider('musicbrainz', toArtistResults(mbResult, artists));
      const wikiRow = scoreProvider('wikipedia', toArtistResults(wikiResult, artists));
      console.info('\n(A) Effectiveness\n');
      console.info(formatTable([mbRow, wikiRow]));

      // -- (B) Latency ---------------------------------------------------
      // Request count matters more than wall-clock: MusicBrainz's is
      // multiplied by a fixed 1100ms serial spacing (MIN_SPACING_MS), while
      // Wikipedia's infobox phase runs a concurrency-4 pool -- the same
      // request count costs very different wall-clock time per provider, so
      // wall-clock alone would understate how much of MB's cost is policy
      // rather than work.
      console.info('\n(B) Latency\n');
      console.info(
        `musicbrainz: ${mbElapsedMs}ms total, ${(mbElapsedMs / artists.length).toFixed(1)}ms/artist, `
        + `${mb.counter.count} requests`,
      );
      console.info(
        `wikipedia:   ${wikiElapsedMs}ms total, ${(wikiElapsedMs / artists.length).toFixed(1)}ms/artist, `
        + `${wiki.counter.count} requests (join-only pass added ${wikiJoinOnly.counter.count} more)`,
      );

      // -- (C) Join-hit count ----------------------------------------------
      console.info('\n(C) Wikidata P1902 join-hit count\n');
      console.info(
        `${joinHitCount} / ${artists.length} fixture artists resolved via the id join alone `
        + '(expected 0 here -- every fixture spotifyId is null, see the ponytail comment above; '
        + 'a real run with genuine Spotify ids from an authenticated library is what this number '
        + 'is meant to measure).',
      );

      expect(mbRow.artists).toBe(artists.length);
      expect(wikiRow.artists).toBe(artists.length);
      expect(joinHitCount).toBeGreaterThanOrEqual(0);
      expect(joinHitCount).toBeLessThanOrEqual(artists.length);
    },
    LIVE_TIMEOUT_MS,
  );
});
