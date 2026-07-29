import { useEffect, useState } from 'react';
import { getRateLimitedUntil, subscribeRateLimit } from '../api/spotify';

/** Epoch ms the current penalty ends, or 0 when clear. Re-renders once a
 *  second **only** while a penalty is live — no permanent interval. */
export function useRateLimit(): number {
  const [until, setUntil] = useState(getRateLimitedUntil);
  const [, tick] = useState(0);

  useEffect(() => subscribeRateLimit(setUntil), []);

  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => {
      // getRateLimitedUntil returns 0 once the deadline passes, which both
      // stops the timer (via the dep change) and clears the banner.
      if (getRateLimitedUntil() === 0) setUntil(0);
      else tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);

  return until > Date.now() ? until : 0;
}
