/**
 * Public browser URL of the Next.js app (no trailing slash).
 * Used for MoonPay redirectURL, Rapyd complete/error URLs, etc.
 *
 * Prefer `FRONTEND_URL` on the deployed API (e.g. Vercel). If unset, we infer from the
 * incoming request `Origin` / `Referer` when it is safe (see {@link isAllowedRedirectOrigin})
 * so checkout does not fall back to localhost when the dashboard is on Vercel.
 */

function normalizeOrigin(s) {
  return (s || '').trim().replace(/\/+$/, '');
}

export function parseCorsOriginsFromEnv() {
  const raw = process.env.CORS_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isLocalhostOrigin(origin) {
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * When CORS_ORIGINS is set: only those exact origins may drive redirects.
 * When empty: allow https origins on *.vercel.app (typical Vercel front + API split).
 * Localhost / 127.0.0.1 allowed with http or https for local dev.
 */
export function isAllowedRedirectOrigin(origin, corsAllowlist) {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  try {
    const u = new URL(o);
    if (isLocalhostOrigin(o)) {
      return u.protocol === 'http:' || u.protocol === 'https:';
    }
    if (u.protocol !== 'https:') return false;
    if (corsAllowlist.length > 0) return corsAllowlist.includes(o);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('.vercel.app')) return true;
    return false;
  } catch {
    return false;
  }
}

/** @param {import('express').Request} [req] */
export function requestOriginForRedirect(req) {
  if (!req?.headers) return null;
  const origin = req.headers.origin;
  if (origin && typeof origin === 'string') return normalizeOrigin(origin);
  const ref = req.headers.referer;
  if (!ref || typeof ref !== 'string') return null;
  try {
    return normalizeOrigin(new URL(ref).origin);
  } catch {
    return null;
  }
}

/**
 * @param {import('express').Request} [req] - When provided, may supply Origin for redirects if env is missing or localhost-only.
 */
export function getPublicFrontendOrigin(req) {
  const corsAllow = parseCorsOriginsFromEnv();
  const reqOrigin = requestOriginForRedirect(req);
  const reqOk = reqOrigin && isAllowedRedirectOrigin(reqOrigin, corsAllow);

  const fromEnv = normalizeOrigin(
    process.env.FRONTEND_URL ||
      process.env.FRONTEND_ORIGIN ||
      process.env.NEXT_PUBLIC_APP_URL ||
      '',
  );

  if (fromEnv && !isLocalhostOrigin(fromEnv)) {
    return fromEnv;
  }
  if (reqOk) {
    return reqOrigin;
  }
  if (fromEnv) {
    return fromEnv;
  }
  return 'http://localhost:3000';
}
