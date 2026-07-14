export interface RemovalEntry {
  trackId: string;
  name: string;
  artists: string;
  addedAt: string;   // original Liked date — lost on Spotify's side once unliked
  removedAt: string;
  playlistIds: string[];
}

const KEY = 'kondo:removals:v1';

export function getRemovalLog(): RemovalEntry[] {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as RemovalEntry[]) : [];
}

export function logRemoval(entry: RemovalEntry): void {
  localStorage.setItem(KEY, JSON.stringify([...getRemovalLog(), entry]));
}

export function removeFromLog(trackId: string, removedAt: string): void {
  localStorage.setItem(
    KEY,
    JSON.stringify(
      getRemovalLog().filter((e) => !(e.trackId === trackId && e.removedAt === removedAt)),
    ),
  );
}
