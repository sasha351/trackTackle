import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

it('renders children when nothing throws', () => {
  render(<ErrorBoundary><p>hello</p></ErrorBoundary>);
  expect(screen.getByText('hello')).toBeInTheDocument();
});

it('shows a recoverable fallback when a child throws', () => {
  // React logs the caught error; silence it so the test output stays clean.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<ErrorBoundary><Boom /></ErrorBoundary>);
  expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
  expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  spy.mockRestore();
});
