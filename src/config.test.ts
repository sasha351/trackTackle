import { expect, it } from 'vitest';
import { SCOPES } from './config';

// Regression guard: PUT /me/player/play 403s without this scope, so the play
// button silently does nothing. Don't drop it when trimming scopes.
it('requests the scope needed to start playback', () => {
  expect(SCOPES).toContain('user-modify-playback-state');
});
