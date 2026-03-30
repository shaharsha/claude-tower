/** Precise elapsed: 45s, 2m 30s, 1h 5m 30s — for Running counters */
export function formatElapsed(sinceMs: number): string {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) {
    return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  if (hours < 24) {
    return remainingMin > 0 ? `${hours}h ${remainingMin}m ${remainingSec}s` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Compact elapsed: 45s, 2m, 1h, 3d — for non-running items (ago, took) */
export function formatElapsedCompact(sinceMs: number): string {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
