// The headset keeps only a few persistent anchors per site, so saved AR
// alignments are capped: the oldest scenes give up their slot first.

/**
 * The scenes to drop so that at most `max` saved alignments remain — the
 * oldest by `savedAt` first, never `keep` (the scene about to start).
 */
export function scenesToEvict(savedAt: Readonly<Record<string, number>>, keep: string, max: number): string[] {
  const excess = Object.keys(savedAt).length - max;
  if (excess <= 0) {
    return [];
  }

  return Object.entries(savedAt)
    .filter(([scene]) => scene !== keep)
    .sort(([, a], [, b]) => a - b)
    .slice(0, excess)
    .map(([scene]) => scene);
}
