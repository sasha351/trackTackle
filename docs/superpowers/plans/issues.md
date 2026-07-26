- `src/genre/resolver.ts` — the try/catch around the Spotify batch call catches
  *everything*, not just `SpotifyApiError`. Any real bug in that path (a bad
  mock, a TypeError, a rename) is swallowed and the artists quietly route to
  MusicBrainz, so the run still "succeeds" and tests still pass. This already
  produced one false green: a test asserting "150 resolved via MusicBrainz
  after a 403" passed while never simulating a 403 at all. Narrow the catch to
  `SpotifyApiError` and let anything else throw.

- vitest is scanning the stale `.claude/worktrees/public-launch/` worktree, so
  every run reports doubled test files (`2 passed` for a single file) against a
  frozen copy of the source. It shadowed a mutation-test result during the
  batching work — the stale copy passed while the real one failed. Prune the
  worktree or add an `exclude` for `.claude/` in the vitest config.

- match sensitivity slider is bad UI, needs to be revisited

- not a single song is returning over a 49-50 percent certainty score, without musicbrainz spotify only, not inherently a problem but i want to know why

- analyzer features seems to have broken, saying that each playlist has too few tracks. likely broke after the spotify first genre resoltion ticket fix. this is fine but i just need to to be working again, just the spotify first approach with musicbrainz as a backup. same logic as the sorter feature