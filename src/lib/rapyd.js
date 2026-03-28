/**
 * Rapyd API client: create checkout, verify webhooks.
 * Flow: user pays via Rapyd (fiat to us) → webhook → we buy from Coinbase and credit user.
 */

import crypto from 'crypto';

const RAPYD_BASE = process.env.RAPYD_SANDBOX !== 'false' && process.env.RAPYD_SANDBOX !== '0'
  ? 'https://sandboxapi.rapyd.net'
  : 'https://api.rapyd.net';

export function getRapydConfig() {
  const accessKey = process.env.RAPYD_ACCESS_KEY;
  const secretKey = process.env.RAPYD_SECRET_KEY;
  return { accessKey, secretKey, base: RAPYD_BASE };
}

/**
 * Rapyd signature: HMAC-SHA256 → hex string → base64(hex string).
 * Formula: BASE64( UTF8( HEX( HMAC-SHA256(...) ) ) ). See Rapyd request-signatures docs.
 */
function sign(method, urlPath, salt, timestamp, bodyString, secretKey, accessKey) {
  const toSign = String(method).toLowerCase() + urlPath + salt + timestamp + accessKey + secretKey + bodyString;
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(toSign);
  const hexDigest = hmac.digest('hex');
  return Buffer.from(hexDigest, 'utf8').toString('base64');
}

/**
 * Body string for Rapyd: compact JSON, no whitespace. Amount/numbers as strings to avoid 12.50→12.5 signature mismatch.
 */
function toRapydBodyString(body) {
  if (body == null || (typeof body === 'object' && Object.keys(body).length === 0)) return '';
  return JSON.stringify(body);
}

/**
 * Make signed request to Rapyd API.
 * @param {string} method - get, post, put, delete
 * @param {string} path - e.g. /v1/checkout (no query in path for signature)
 * @param {object} [body] - JSON body; numeric values should be strings for signature consistency
 */
export async function rapydRequest(method, path, body = null) {
  const { accessKey, secretKey, base } = getRapydConfig();
  if (!accessKey || !secretKey) throw new Error('RAPYD_ACCESS_KEY and RAPYD_SECRET_KEY required');

  const salt = crypto.randomBytes(8).toString('hex').slice(0, 16);
  const timestamp = Math.floor(Date.now() / 1000);
  const urlPath = path.startsWith('/') ? path : `/${path}`;
  const bodyString = body == null ? '' : toRapydBodyString(body);

  const signature = sign(method, urlPath, salt, timestamp, bodyString, secretKey, accessKey);

  const url = `${base}${urlPath}`;
  const headers = {
    'Content-Type': 'application/json',
    access_key: accessKey,
    salt,
    timestamp: String(timestamp),
    signature,
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body != null && { body: bodyString }),
  });

  const data = await res.json().catch(() => ({}));
  const status = data?.status || {};
  const message = status.message || status.error_code || data?.status?.message || `Rapyd ${res.status}`;

  if (status.error_code && status.status !== 'SUCCESS') {
    const err = new Error(message);
    err.rapyd = {
      error_code: status.error_code,
      message: status.message,
      operation_id: status.operation_id,
      response_code: status.response_code,
      http_status: res.status,
    };
    console.error('[Rapyd] API error', err.rapyd);
    throw err;
  }
  if (!res.ok) {
    const err = new Error(message);
    err.rapyd = { http_status: res.status, ...status };
    console.error('[Rapyd] HTTP error', err.rapyd);
    throw err;
  }
  return data;
}

/**
 * Create checkout page. Returns { id, redirect_url }.
 * Amount sent as string so signature matches (Rapyd: no trailing zeroes / decimal normalization).
 * Includes card payment category so user can pay with credit/debit card (US + USD).
 */
export async function createCheckout(opts) {
  const amount = opts.amount != null ? String(Number(opts.amount)) : undefined;
  const body = {
    amount: amount ?? String(0),
    currency: opts.currency || 'USD',
    complete_payment_url: opts.complete_payment_url,
    error_payment_url: opts.error_payment_url,
    country: opts.country || 'IL',
  };
  if (opts.merchant_reference_id) body.merchant_reference_id = opts.merchant_reference_id;
  if (opts.language) body.language = opts.language;
  if (opts.expiration != null) body.expiration = opts.expiration;

  const result = await rapydRequest('post', '/v1/checkout', body);
  const id = result?.data?.id;
  const redirect_url = result?.data?.redirect_url ?? null;
  return { id, redirect_url, raw: result };
}

/**
 * Verify webhook signature. Rapyd webhook uses url_path + salt + timestamp + access_key + secret_key + body_string (no http_method).
 * urlPath = full URL configured in Rapyd dashboard (e.g. https://your-backend.com/api/rapyd/webhook).
 */
export function verifyWebhookSignature(urlPath, salt, timestamp, bodyString, receivedSignature) {
  const { accessKey, secretKey } = getRapydConfig();
  if (!secretKey || !receivedSignature) return false;
  const path = (urlPath || '').trim() || '/';
  const toSign = path + salt + timestamp + accessKey + secretKey + bodyString;
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(toSign);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(receivedSignature, 'utf8'));
  } catch {
    return false;
  }
}
