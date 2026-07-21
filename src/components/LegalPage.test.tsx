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
