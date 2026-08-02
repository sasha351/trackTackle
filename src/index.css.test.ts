// `?raw` rather than node:fs — tsconfig.app.json deliberately omits node types
// (this is a browser-only SPA), and vite/client already declares '*?raw'.
import css from './index.css?raw';
import html from '../index.html?raw';
import manifest from '../public/manifest.webmanifest?raw';

// The responsive layout is pure CSS, and jsdom neither lays out boxes nor
// evaluates width media queries — a render-based assertion here would prove
// nothing. So this file guards the *contract* of the stylesheet instead: the
// breakpoints exist, they override the rules that actually overflow, and the
// desktop layout underneath them is left alone.
//
// Text extraction rather than jsdom's CSSOM on purpose: cssstyle silently drops
// declarations it doesn't model (grid-template-columns, env()), which would make
// every assertion below pass vacuously.

/** Body of `@media <condition> { … }`, brace-matched so nested rules survive. */
function mediaBlock(condition: string): string {
  const header = `@media ${condition}`;
  const start = css.indexOf(header);
  if (start === -1) throw new Error(`no ${header} block in index.css`);

  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      return css.slice(css.indexOf('{', start) + 1, i);
    }
  }
  throw new Error(`unterminated ${header} block`);
}

/** Everything before the first width breakpoint — i.e. the desktop layout. */
const desktopCss = css.slice(0, css.indexOf('@media (max-width: 1024px)'));

describe('responsive stylesheet contract', () => {
  it('defines both width breakpoints', () => {
    expect(() => mediaBlock('(max-width: 1024px)')).not.toThrow();
    expect(() => mediaBlock('(max-width: 720px)')).not.toThrow();
  });

  it('leaves the desktop track grid intact', () => {
    // If someone "fixes" mobile by editing the base rule, wide screens silently
    // lose the layout the breakpoints are written to preserve.
    expect(desktopCss).toContain(
      'grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) 56px 100px 400px;',
    );
  });

  describe('tablet breakpoint', () => {
    const block = mediaBlock('(max-width: 1024px)');

    it('makes the match column elastic instead of a fixed 400px', () => {
      expect(block).toContain('.song-row');
      expect(block).toContain('grid-template-columns:');
      expect(block).not.toContain('400px');
    });

  });

  it('opens the match popover leftward by default', () => {
    // Right-anchored in the base rule: in the table the trigger sits in the
    // last column, so opening leftward is what keeps it on screen.
    expect(desktopCss).toMatch(/\.match-popover\s*\{[^}]*right:\s*0/);
    expect(desktopCss).toMatch(/\.match-popover\s*\{[^}]*left:\s*auto/);
  });

  it('can re-anchor the match popover to the left edge of its trigger', () => {
    // The default is wrong in the Quick Add strip: its four-across cards put a
    // trigger near x=0, where a right-anchored 458px popover landed at x=-209
    // on a 1440px viewport with every checkbox clipped off screen. MatchPicker
    // measures on open and adds this class; without the rule the measurement
    // has nothing to do.
    expect(desktopCss).toMatch(/\.match-popover\.anchor-left\s*\{[^}]*left:\s*0/);
    expect(desktopCss).toMatch(/\.match-popover\.anchor-left\s*\{[^}]*right:\s*auto/);
  });

  it('keeps the phone bottom sheet inset even when the popover is flipped', () => {
    // `.match-popover.anchor-left` outranks a bare `.match-popover`, so the
    // phone block has to restate it or a flipped sheet loses its right inset.
    expect(mediaBlock('(max-width: 720px)')).toMatch(
      /\.match-popover,\s*\.match-popover\.anchor-left\s*\{/,
    );
  });

  it('gives every control one height, without inflating status badges', () => {
    // Before the token a plain button computed to 31px while the match column's
    // .play-btn/.match-pill/.pill-green were an explicit 32px, so the two
    // disagreed by a pixel in every row that mixed them.
    expect(desktopCss).toMatch(/--control-h:\s*32px/);
    expect(desktopCss).toMatch(
      /button,\s*select,\s*\.match-search\s*\{[^}]*min-height:\s*var\(--control-h\)/,
    );
    // Same carve-out the phone touch-target rule makes: .status-badge is a
    // non-interactive <span class="pill"> and must stay badge-sized.
    expect(desktopCss).not.toMatch(/^\s*\.pill,\s*\n\s*select,/m);
  });

  it('gives the nav its own row, flush right, instead of reserving space for the fixed toggle', () => {
    // The nav used to share the title's line, so it had to keep 140px clear of
    // the viewport-fixed .skin-toggle — which is exactly what stopped it
    // reaching the right edge. A full-width title drops it to a row of its own,
    // below the toggle, where margin-left:auto can push it flush.
    expect(desktopCss).toMatch(/\.app-header h1\s*\{[^}]*flex:\s*1 0 100%/);
    expect(desktopCss).toMatch(/\.app-header nav\s*\{[^}]*margin-left:\s*auto/);
    expect(desktopCss).not.toMatch(/\.app-header\s*\{[^}]*padding-right:\s*140px/);
  });

  describe('phone breakpoint', () => {
    const block = mediaBlock('(max-width: 720px)');

    it('wraps the nav by whole pills', () => {
      // Without this the nav is a single non-wrapping flex line whose buttons
      // shrink instead, which is what breaks their labels at 390px.
      expect(block).toMatch(/\.app-header nav\s*\{[^}]*flex-wrap:\s*wrap/);
    });

    it('hides the column headings', () => {
      expect(block).toMatch(/\.song-cols\s*\{\s*display:\s*none/);
    });

    it('stacks the song row instead of using the five-column track', () => {
      expect(block).toContain('grid-template-columns: auto minmax(0, 1fr);');
      // 1.6fr is the signature of the desktop five-column track.
      expect(block).not.toContain('1.6fr');
    });

    it('detaches the match popover from its anchor', () => {
      // Both selectors, since the flipped variant is restated here — see the
      // specificity note in the phone block.
      expect(block).toMatch(/\.match-popover\.anchor-left\s*\{[^}]*position:\s*fixed/);
    });

    it('clears the iOS bottom bar for every fixed-position element', () => {
      // the match sheet, the undo toast, the back-to-top button and the
      // now-playing jump link
      expect(block.match(/env\(safe-area-inset-bottom\)/g)).toHaveLength(4);
    });

    it('gives controls a 44px touch target without inflating status badges', () => {
      expect(block).toMatch(/min-height:\s*44px/);
      // .status-badge is a non-interactive <span class="pill">; sweeping .pill
      // into the touch-target rule would turn it into a chunky block.
      expect(block).not.toMatch(/^\s*\.pill\s*,/m);
    });

    it('labels the year and date cells, since the column headings are hidden here', () => {
      // .song-cols is display:none at this width (asserted above), so without
      // these the stacked row shows two bare numbers on a shared line.
      expect(block).toMatch(/\.song-year::before\s*\{[^}]*content:/);
      expect(block).toMatch(/\.song-added::before\s*\{[^}]*content:/);
    });
  });

  // Not decoration: this pair is the whole implementation of "one picker open
  // at a time, and a mis-click drops you out of it" — there is no JS behind it.
  // The pointer-events lock sends the stray click to the list instead of
  // another row's Add button, which is what MatchPicker's outside-mousedown
  // handler then sees.
  it('locks and dims every other row while a match popover is open', () => {
    expect(desktopCss).toMatch(
      /\.song-list:has\(\.match-popover\) \.song-row:not\(:has\(\.match-popover\)\)\s*\{[^}]*pointer-events:\s*none/,
    );
    expect(desktopCss).toMatch(/\.song-row:has\(\.match-popover\)\s*\{/);
  });

  it('keeps an open match popover above the sticky column header', () => {
    // The "ready to file" quick-match list is rendered *before* .song-cols in
    // the DOM (Sorter.tsx), so at equal z-index the header wins paint-order
    // ties and covers a popover opened from that list.
    const songColsZ = desktopCss.match(/\.song-cols\s*\{[^}]*z-index:\s*(\d+)/);
    const popoverZ = desktopCss.match(/\.match-popover\s*\{[^}]*z-index:\s*(\d+)/);
    expect(songColsZ).not.toBeNull();
    expect(popoverZ).not.toBeNull();
    expect(Number(popoverZ![1])).toBeGreaterThan(Number(songColsZ![1]));
  });

  it('spans the DEV score-breakdown line across the candidate grid', () => {
    // .match-candidate is a 4-column grid; without an explicit grid-column
    // the 5th (DEV-only) child falls into an implicit row confined to
    // column 1 and overflows its width unstyled.
    expect(desktopCss).toMatch(/\.cand-explain\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });

  it('pins the skin toggle to the viewport so it survives scrolling', () => {
    // The whole point of the control: "persist in its location with scroll".
    // jsdom does no layout, so this is the only place it can be asserted.
    expect(desktopCss).toMatch(/\.skin-toggle\s*\{[^}]*position:\s*fixed/);
    const toggleZ = desktopCss.match(/\.skin-toggle\s*\{[^}]*z-index:\s*(\d+)/);
    const popoverZ = desktopCss.match(/\.match-popover\s*\{[^}]*z-index:\s*(\d+)/);
    expect(toggleZ).not.toBeNull();
    expect(Number(toggleZ![1])).toBeGreaterThan(Number(popoverZ![1]));
  });

  describe('gallery skin', () => {
    it('tiles candidates with auto-fill, never auto-fit', () => {
      // auto-fit collapses the empty tracks, so a song with one candidate got a
      // single tile stretched across the whole panel — 946px wide at 1440, with
      // its checkbox stranded in the middle. Measured, not theoretical.
      expect(desktopCss).toMatch(/\.cand-tiles\s*\{[^}]*repeat\(auto-fill,/);
      expect(desktopCss).not.toMatch(/\.cand-tiles\s*\{[^}]*auto-fit/);
    });

    it('stretches the panel head across the match column', () => {
      // .match-panel is align-items:flex-start, which shrink-wraps its children.
      // Without the explicit width the head collapses to ~170px, space-between
      // has nothing to distribute, and Add sits next to the cover instead of at
      // the card's right edge — leaving most of the widest column empty.
      expect(desktopCss).toMatch(/\.panel-head\s*\{[^}]*width:\s*100%/);
      expect(desktopCss).toMatch(/\.panel-head\s*\{[^}]*justify-content:\s*space-between/);
    });

    it('caps the album cover on phones', () => {
      // Without the cap a 100%-wide square is 340px at 390px wide, which made
      // each card 695px tall — one song per screen in a list you scroll.
      expect(mediaBlock('(max-width: 720px)')).toMatch(/\.cover-lg\s*\{[^}]*max-width:/);
    });
  });

  it('index.html sets a device-width viewport', () => {
    // Without this the whole file is inert — mobile Safari renders at 980px.
    expect(html).toMatch(/<meta\s+name="viewport"[^>]*width=device-width/);
  });
});

describe('install metadata', () => {
  it('index.html links the manifest, the apple touch icon and a theme colour', () => {
    // Without these, add-to-home-screen gives a generic icon and browser chrome.
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/<link\s+rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/);
    expect(html).toMatch(/<meta\s+name="theme-color"\s+content="#121212"/);
  });

  it('the manifest is valid JSON with both required icon sizes', () => {
    const parsed = JSON.parse(manifest) as {
      name: string; display: string; theme_color: string;
      icons: { src: string; sizes: string }[];
    };
    expect(parsed.name).toBe('Kondo');
    expect(parsed.display).toBe('standalone');
    // Matches the --bg token, so the splash screen does not flash white.
    expect(parsed.theme_color).toBe('#121212');
    expect(parsed.icons.map((i) => i.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
  });
});
