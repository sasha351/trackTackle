import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import LegalPage from './LegalPage';

it('renders Privacy and Terms headings and covers data-handling disclosures', () => {
  render(<LegalPage />);
  expect(screen.getByRole('heading', { name: /privacy/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /terms/i })).toBeInTheDocument();
  expect(screen.getByText(/localStorage/i)).toBeInTheDocument();
  expect(screen.getByText(/not affiliated with Spotify/i)).toBeInTheDocument();
});

// The page used to name only Spotify and MusicBrainz while deep genre runs also
// hit Wikimedia. A privacy claim that is false is worse than none, so this
// asserts every host the app can actually reach — and none it no longer does.
it('names every third party the app contacts, Wikidata included', () => {
  render(<LegalPage />);
  for (const host of ['musicbrainz.org', 'query.wikidata.org', 'labs.api.listenbrainz.org', 'ws.audioscrobbler.com']) {
    expect(screen.getByText(host)).toBeInTheDocument();
  }
  expect(screen.queryByText('en.wikipedia.org')).toBeNull();
});

it('explains why the consent screen asks for email and private information', () => {
  render(<LegalPage />);
  expect(screen.getByText(/view your email address/i)).toBeInTheDocument();
  expect(screen.getByText(/Web Playback SDK/i)).toBeInTheDocument();
});
