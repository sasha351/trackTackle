/** A square cover tile. Missing art is routine — playlists with no custom
 *  image, local files — so the fallback is a first-initial tile rather than a
 *  broken <img>, and it is a text node so it inherits the theme with no extra
 *  asset. alt="" throughout: every call site renders the name as adjacent
 *  text, so a real alt would be announced twice. */
export default function CoverArt(
  { src, name, className }: { src: string | null | undefined; name: string; className?: string },
) {
  const cls = `cover${className ? ` ${className}` : ''}`;
  if (src) {
    // loading="lazy" matters here: a gallery of 500 songs is 500 covers, and
    // only a screenful is ever visible.
    return <img className={cls} src={src} alt="" loading="lazy" decoding="async" role="presentation" />;
  }
  const initial = name.trim().charAt(0).toUpperCase() || '♪';
  return <span className={`${cls} cover-empty`} aria-hidden="true">{initial}</span>;
}
