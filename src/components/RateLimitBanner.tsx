import { useRateLimit } from '../hooks/useRateLimit';

export default function RateLimitBanner() {
  const until = useRateLimit();
  if (!until) return null;
  const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  // Spotify's penalty routinely runs an hour or more, so roll into h:mm:ss
  // instead of letting minutes climb past 59.
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const mmss =
    hours > 0
      ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
      : `${mins}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <p role="status" className="rate-limit-banner">
      Spotify is rate-limiting this app — resuming in {mmss}. Your library stays usable, and
      it picks back up on its own.{' '}
      <span className="rate-limit-note">
        Spotify hides the exact penalty from browsers, so this is an estimate and may extend.
      </span>
    </p>
  );
}
