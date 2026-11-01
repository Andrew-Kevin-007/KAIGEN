/**
 * "Only the newest request counts." `begin()` starts a request and returns a check to call after each await: it is
 * true only while no later request has begun and nothing has invalidated it. A slow answer that arrives after a
 * newer lookup started therefore finds its check false and drops itself.
 */
export interface Latest {
  begin(): () => boolean;
  /** Makes every request started so far stale, without starting a new one (the thing they belonged to has changed). */
  invalidate(): void;
}

export function latestOnly(): Latest {
  let current = 0;
  return {
    begin() {
      const mine = ++current;
      return () => mine === current;
    },
    invalidate() {
      current++;
    },
  };
}
