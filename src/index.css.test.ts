// `?raw` rather than node:fs — tsconfig.app.json deliberately omits node types
// (this is a browser-only SPA), and vite/client already declares '*?raw'.
import css from './index.css?raw';
import html from '../index.html?raw';

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

    it('opens the match popover leftward so it cannot leave the viewport', () => {
      expect(block).toMatch(/\.match-popover\s*\{[^}]*right:\s*0/);
      expect(block).toMatch(/\.match-popover\s*\{[^}]*left:\s*auto/);
    });
  });

  describe('phone breakpoint', () => {
    const block = mediaBlock('(max-width: 720px)');

    it('hides the column headings', () => {
      expect(block).toMatch(/\.song-cols\s*\{\s*display:\s*none/);
    });

    it('stacks the song row instead of using the five-column track', () => {
      expect(block).toContain('grid-template-columns: auto minmax(0, 1fr);');
      // 1.6fr is the signature of the desktop five-column track.
      expect(block).not.toContain('1.6fr');
    });

    it('detaches the match popover from its anchor', () => {
      expect(block).toMatch(/\.match-popover\s*\{[^}]*position:\s*fixed/);
    });

    it('clears the iOS bottom bar for both fixed-position elements', () => {
      // the match sheet and the undo toast
      expect(block.match(/env\(safe-area-inset-bottom\)/g)).toHaveLength(2);
    });

    it('gives controls a 44px touch target without inflating status badges', () => {
      expect(block).toMatch(/min-height:\s*44px/);
      // .status-badge is a non-interactive <span class="pill">; sweeping .pill
      // into the touch-target rule would turn it into a chunky block.
      expect(block).not.toMatch(/^\s*\.pill\s*,/m);
    });
  });

  it('index.html sets a device-width viewport', () => {
    // Without this the whole file is inert — mobile Safari renders at 980px.
    expect(html).toMatch(/<meta\s+name="viewport"[^>]*width=device-width/);
  });
});
