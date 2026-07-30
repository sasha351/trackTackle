import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import CoverArt from './CoverArt';

it('renders the image when there is art', () => {
  render(<CoverArt src="https://i.scdn.co/x" name="Trip Hop" className="cover-md" />);
  const img = screen.getByRole('presentation');
  expect(img).toHaveAttribute('src', 'https://i.scdn.co/x');
  // The name is always adjacent text at every call site; an alt would double it.
  expect(img).toHaveAttribute('alt', '');
  expect(img).toHaveClass('cover-md');
});

it('falls back to a text initial rather than a broken image', () => {
  render(<CoverArt src={null} name="trip hop" className="cover-md" />);
  expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
  expect(screen.getByText('T')).toBeInTheDocument();
});

it('falls back to a note glyph when there is no name either', () => {
  render(<CoverArt src={undefined} name="  " />);
  expect(screen.getByText('♪')).toBeInTheDocument();
});
