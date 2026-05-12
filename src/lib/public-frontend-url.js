/**
 * Public browser URL of the Next.js app (no trailing slash).
 * Used for MoonPay redirectURL, Rapyd complete/error URLs, etc.
 * Set FRONTEND_URL on the deployed API (e.g. Vercel) to your real front origin.
 */
export function getPublicFrontendOrigin() {
  const raw =
    process.env.FRONTEND_URL?.trim() ||
    process.env.FRONTEND_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    '';
  const base = raw.replace(/\/+$/, '');
  return base || 'http://localhost:3000';
}
