import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import NowPlaying from './NowPlaying';
import { currentPosition, type PlaybackState } from '../player/spotifyPlayer';

const track = {
  id: 't1', uri: 'spotify:track:t1', name: 'Song t1',
  artists: [{ id: 'a1', name: 'Artist' }],
  albumName: 'Album', releaseYear: 2000, isrc: null, addedAt: '2024-01-01',
};
const state = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  uri: track.uri, positionMs: 60_000, durationMs: 180_000, paused: true, at: performance.now(), ...over,
});

it('extrapolates position while playing, freezes it while paused, and clamps at the end', () => {
  expect(currentPosition(state({ paused: false, at: 0 }), 5_000)).toBe(65_000);
  expect(currentPosition(state({ paused: true, at: 0 }), 5_000)).toBe(60_000);
  expect(currentPosition(state({ paused: false, at: 0 }), 999_000)).toBe(180_000);
});

it('shows elapsed / total and disables seeking until the SDK reports a duration', () => {
  const { rerender } = render(
    <NowPlaying track={track} playback={null} paused={false} onToggle={() => {}} onSeek={() => {}} />,
  );
  expect(screen.getByRole('slider', { name: 'seek' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'forward 10 seconds' })).toBeDisabled();

  rerender(<NowPlaying track={track} playback={state()} paused onToggle={() => {}} onSeek={() => {}} />);
  expect(screen.getByRole('slider', { name: 'seek' })).toBeEnabled();
  expect(screen.getByText('1:00')).toBeInTheDocument();
  expect(screen.getByText('3:00')).toBeInTheDocument();
});

it("ignores another track's state", () => {
  render(<NowPlaying track={track} playback={state({ uri: 'spotify:track:other' })} paused
    onToggle={() => {}} onSeek={() => {}} />);
  expect(screen.getByRole('slider', { name: 'seek' })).toBeDisabled();
});

it('commits a scrub once on release, not on every drag step', () => {
  const onSeek = vi.fn();
  render(<NowPlaying track={track} playback={state()} paused onToggle={() => {}} onSeek={onSeek} />);
  const slider = screen.getByRole('slider', { name: 'seek' });
  fireEvent.change(slider, { target: { value: '90000' } });
  fireEvent.change(slider, { target: { value: '120000' } });
  expect(onSeek).not.toHaveBeenCalled();
  expect(screen.getByText('2:00')).toBeInTheDocument(); // readout follows the thumb
  fireEvent.pointerUp(slider);
  expect(onSeek).toHaveBeenCalledTimes(1);
  expect(onSeek).toHaveBeenCalledWith(120_000);
});

it('skips ±10s, clamped to the track', async () => {
  const onSeek = vi.fn();
  render(<NowPlaying track={track} playback={state({ positionMs: 5_000 })} paused
    onToggle={() => {}} onSeek={onSeek} />);
  await userEvent.click(screen.getByRole('button', { name: 'back 10 seconds' }));
  expect(onSeek).toHaveBeenLastCalledWith(0);
  await userEvent.click(screen.getByRole('button', { name: 'forward 10 seconds' }));
  expect(onSeek).toHaveBeenLastCalledWith(15_000);
});

it('advances the readout while playing', () => {
  vi.useFakeTimers();
  try {
    render(<NowPlaying track={track} playback={state({ paused: false })} paused={false}
      onToggle={() => {}} onSeek={() => {}} />);
    expect(screen.getByText('1:00')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText('1:02')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the scroll-to-row link', () => {
  render(<NowPlaying track={track} playback={null} paused={false} onToggle={() => {}} onSeek={() => {}} />);
  expect(screen.getByRole('link', { name: /now playing/i })).toHaveAttribute('href', '#track-t1');
});
