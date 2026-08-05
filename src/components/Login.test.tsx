import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Login from './Login';

it('explains what Track Tackle does and discloses Premium-optional playback before the login button', () => {
  render(<Login />);
  expect(screen.getByText(/sort.*liked songs.*playlists.*genre/i)).toBeInTheDocument();
  expect(screen.getByText(/runs entirely in your browser/i)).toBeInTheDocument();
  expect(screen.getByText(/premium/i)).toBeInTheDocument();
  expect(screen.getByText(/not affiliated with spotify/i)).toBeInTheDocument();
});
