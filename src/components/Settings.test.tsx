import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Settings from './Settings';
import * as spotify from '../api/spotify';

vi.mock('../api/spotify', () => ({ getMyPlaylists: vi.fn() }));

const settings = { targetPlaylistIds: null, threshold: 0.3, sortOrder: 'oldest' as const };

it('lists owned playlists all-checked and materializes the list on uncheck', async () => {
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([
    { id: 'p1', name: 'Trip Hop', trackCount: 10 },
    { id: 'p2', name: 'Road Trip', trackCount: 20 },
  ]);
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} />);
  const roadTrip = await screen.findByRole('checkbox', { name: /road trip/i });
  expect(roadTrip).toBeChecked();
  await userEvent.click(roadTrip);
  expect(onChange).toHaveBeenCalledWith({ ...settings, targetPlaylistIds: ['p1'] });
});

it('changes the threshold via the slider', async () => {
  vi.mocked(spotify.getMyPlaylists).mockResolvedValue([]);
  const onChange = vi.fn();
  render(<Settings settings={settings} onChange={onChange} />);
  const slider = await screen.findByRole('slider');
  // range inputs don't work with userEvent.type; fire a change directly:
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(slider, { target: { value: '0.5' } });
  expect(onChange).toHaveBeenCalledWith({ ...settings, threshold: 0.5 });
});
