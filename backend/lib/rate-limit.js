import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const REQUESTS_PER_HOUR = 30;
const WINDOW = "1 h";
const RATE_LIMIT_ERROR = "Rate limit exceeded";

let ratelimit;

/**
 * Resolve Redis credentials from Upstash / Vercel integration env vars.
 * Order: standard Upstash → Vercel KV → UPSTASH_REDIS_REST_KV_* integration names.
 */
function resolveRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) return { url: kvUrl, token: kvToken };

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("UPSTASH_REDIS_REST_KV")) continue;

    if (key.endsWith("REST_API_URL")) {
      const tokenKey = key.replace("REST_API_URL", "REST_API_TOKEN");
      const integrationUrl = process.env[key];
      const integrationToken = process.env[tokenKey];
      if (integrationUrl && integrationToken) {
        return { url: integrationUrl, token: integrationToken };
      }
    }

    if (key.endsWith("_URL") && !key.endsWith("REST_API_URL")) {
      const tokenKey = key.replace(/_URL$/, "_TOKEN");
      const integrationUrl = process.env[key];
      const integrationToken = process.env[tokenKey];
      if (integrationUrl && integrationToken) {
        return { url: integrationUrl, token: integrationToken };
      }
    }
  }

  return null;
}

function getRatelimit() {
  if (ratelimit) return ratelimit;

  const credentials = resolveRedisCredentials();
  if (!credentials) return null;

  ratelimit = new Ratelimit({
    redis: new Redis(credentials),
    limiter: Ratelimit.slidingWindow(REQUESTS_PER_HOUR, WINDOW),
    prefix: "zonecheck",
    analytics: true,
  });

  return ratelimit;
}

/** Client IP from Vercel / reverse-proxy headers. */
export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (typeof req.headers["x-real-ip"] === "string" && req.headers["x-real-ip"].trim()) {
    return req.headers["x-real-ip"].trim();
  }
  return "unknown";
}

/**
 * Shared 30 req/hour bucket per IP across detect-time and generate-draft.
 * @returns {{ allowed: true } | { allowed: false, status: number, error: string, retryAfterSec?: number }}
 */
export async function checkRateLimit(req) {
  const rl = getRatelimit();

  if (!rl) {
    if (process.env.VERCEL_ENV === "production") {
      return {
        allowed: false,
        status: 503,
        error: "Service temporarily unavailable. Please try again later.",
      };
    }
    console.warn(
      "[Zonecheck] Rate limiting disabled: no Upstash Redis credentials in environment"
    );
    return { allowed: true };
  }

  const ip = getClientIp(req);
  const { success, reset } = await rl.limit(ip);

  if (success) {
    return { allowed: true };
  }

  const retryAfterSec = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 3600;

  return {
    allowed: false,
    status: 429,
    error: RATE_LIMIT_ERROR,
    retryAfterSec,
  };
}

export function applyRateLimitHeaders(res, rateResult) {
  if (rateResult.retryAfterSec) {
    res.setHeader("Retry-After", String(rateResult.retryAfterSec));
  }
}
