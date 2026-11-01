// A small in-memory limit per client address for the public top-up routes, so they cannot be used to burn the
// server's 1Click quota. It is per server instance: behind several instances each keeps its own count, which is
// still enough to cap one client against one instance.

export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export interface Limiter {
  check(key: string): LimitResult;
  size(): number;
}

interface Options {
  limit: number;
  windowMs: number;
  /** Bound on the table, so a flood of different addresses cannot grow it without end. Oldest entries go first. */
  maxKeys?: number;
  now?: () => number;
}

export function createLimiter({ limit, windowMs, maxKeys = 10_000, now = Date.now }: Options): Limiter {
  const hits = new Map<string, { start: number; count: number }>();
  return {
    check(key) {
      const t = now();
      let entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        entry = { start: t, count: 0 };
        hits.delete(key);
        hits.set(key, entry);
        if (hits.size > maxKeys) {
          for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
          while (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
        }
      }
      entry.count += 1;
      if (entry.count > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000)) };
      return { ok: true, retryAfterSec: 0 };
    },
    size: () => hits.size,
  };
}

/**
 * The caller's address. Each proxy appends the address it saw to x-forwarded-for, so the value `trustedHops` from the
 * right is the one our own proxy wrote; anything to its left is chosen by the client and is not trusted.
 * Without a proxy header everyone shares the "unknown" bucket, which is strict, not open.
 */
export function clientIp(headers: { get(name: string): string | null }, trustedHops = 1): string {
  const parts = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const forwarded = parts[parts.length - trustedHops];
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** How many proxies sit in front of this server and append to x-forwarded-for. */
export const TRUSTED_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1);

export const quoteLimiter = createLimiter({ limit: 10, windowMs: 60_000 });
// The page polls every 10 seconds, so 6 a minute is normal.
export const statusLimiter = createLimiter({ limit: 60, windowMs: 60_000 });
