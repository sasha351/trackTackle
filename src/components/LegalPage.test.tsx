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
// hit both Wikimedia services. A privacy claim that is false is worse than none,
// so this asserts every host the app can actually reach.
it('names every third party the app contacts, Wikimedia included', () => {
  render(<LegalPage />);
  for (const host of ['musicbrainz.org', 'query.wikidata.org', 'en.wikipedia.org', 'labs.api.listenbrainz.org', 'ws.audioscrobbler.com']) {
    expect(screen.getByText(host)).toBeInTheDocument();
  }
});

it('explains why the consent screen asks for email and private information', () => {
  render(<LegalPage />);
  expect(screen.getByText(/view your email address/i)).toBeInTheDocument();
  expect(screen.getByText(/Web Playback SDK/i)).toBeInTheDocument();
});
