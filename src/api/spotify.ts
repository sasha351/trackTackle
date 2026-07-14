import { expireAccessToken, getValidAccessToken } from '../auth/token';

const BASE = 'https://api.spotify.com/v1';

let clientId = '';

export function configureSpotify(id: string): void {
  clientId = id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  let retried401 = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getValidAccessToken(clientId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('Retry-After') ?? '1') + 0.5) * 1000);
      continue;
    }
    if (res.status === 401 && !retried401) {
      retried401 = true;
      expireAccessToken(); // next getValidAccessToken call runs the refresh grant
      continue;
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status} for ${url}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error(`Spotify API gave up after retries: ${url}`);
}

interface Page<T> {
  items: T[];
  next: string | null;
}

export async function getAllPages<T>(firstPath: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = firstPath;
  while (url) {
    const page: Page<T> = await spotifyFetch<Page<T>>(url);
    items.push(...page.items);
    url = page.next;
  }
  return items;
}
