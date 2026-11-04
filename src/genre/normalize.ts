/** Wikidata labels its genre items "hip hop music", "rock music"; MusicBrainz
 *  and Spotify say "hip hop", "rock". The matching engine compares genre
 *  strings exactly, so an unstripped label shares no weight with a playlist
 *  fingerprint built from the other sources. Same rule wikipedia.ts's
 *  normalizeGenreItems applies to infobox text. */
export function normalizeWikidataGenre(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s+music$/, '');
}
