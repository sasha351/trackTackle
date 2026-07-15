import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import App from './App';
import { saveTokens } from './auth/token';

afterEach(() => localStorage.clear());

it('shows the login button when unauthenticated', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /log in with spotify/i })).toBeInTheDocument();
});

it('shows the tab nav when authenticated', () => {
  saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
  render(<App />);
  expect(screen.getByRole('button', { name: /sorter/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /analyzer/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
});

it('brands the app as Kondo', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Kondo' })).toBeInTheDocument();
});
