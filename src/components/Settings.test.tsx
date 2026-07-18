import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Settings from './Settings';

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };
const playlists = [
  { id: 'p1', name: 'Trip Hop', trackCount: 10 },
  { id: 'p2', name: 'Road Trip', trackCount: 20 },
];

it('lists owned playlists all-checked and materializes the list on uncheck', async () => {
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} playlists={playlists} error={null} />);
  const roadTrip = screen.getByRole('checkbox', { name: /road trip/i });
  expect(roadTrip).toBeChecked();
  await userEvent.click(roadTrip);
  expect(onChange).toHaveBeenCalledWith({ ...settings, targetPlaylistIds: ['p1'] });
});

it('changes the threshold via the slider', async () => {
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} playlists={[]} error={null} />);
  const slider = screen.getByRole('slider');
  // range inputs don't work with userEvent.type; fire a change directly:
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(slider, { target: { value: '0.5' } });
  expect(onChange).toHaveBeenCalledWith({ ...settings, threshold: 0.5 });
});

it('shows loading and error states from the library', () => {
  const { rerender } = render(
    <Settings settings={settings} onChange={vi.fn()} playlists={null} error={null} />,
  );
  expect(screen.getByText(/loading playlists/i)).toBeInTheDocument();
  rerender(<Settings settings={settings} onChange={vi.fn()} playlists={null} error="boom" />);
  expect(screen.getByRole('alert')).toHaveTextContent('boom');
});
