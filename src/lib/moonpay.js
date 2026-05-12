/**
 * MoonPay: generate signed widget URL for buy flow.
 * Docs: https://dev.moonpay.com/docs/ramps-sdk-url-signing
 */

import crypto from 'crypto';

const MOONPAY_BASE = process.env.MOONPAY_SANDBOX === 'true' || process.env.MOONPAY_SANDBOX === '1'
  ? 'https://buy-sandbox.moonpay.com'
  : 'https://buy.moonpay.com';

/** Currencies that use an EVM (0x) address. Our CDP wallet is EVM-only; for BTC/SOL/etc we omit address so user enters their own. */
const EVM_CURRENCIES = new Set([
  'eth', 'matic', 'bnb', 'bnb_bsc', 'usdt', 'usdc', 'usdt_polygon', 'usdc_polygon',
  'link', 'uni', 'avax', 'arb', 'op', 'dai', 'weth', 'shib', 'pepe', 'floki',
  'cro', 'ftm', 'aave', 'sushi', 'comp', 'mkr', 'snd', 'imx', 'apt', 'inj', 'near', 'fil', 'vet',
  'grt', 'snx', 'crv', '1inch', 'bat', 'enj', 'mana', 'sand', 'axs', 'lrc', 'skl', 'celo', 'one',
  'eth_base', 'usdc_base',
]);

/** MoonPay currency codes for Base network so purchases land where the app and Coinbase CDP show (Base Mainnet). */
const BASE_NETWORK_CODES = {
  eth: 'eth_base',
  usdc: 'usdc_base',
  usdt: 'usdt_base',
  weth: 'weth_base',
};

export function isEvmCurrency(currencyCode) {
  const c = currencyCode && String(currencyCode).toLowerCase();
  return c && (EVM_CURRENCIES.has(c) || EVM_CURRENCIES.has(c.replace(/_base$/, '')));
}

/** Popular EVM coins you can buy via MoonPay to your wallet. Used for buy-page dropdown (MoonPay + Coinbase). */
const MOONPAY_WALLET_CODES = new Set(
  [
    'ETH', 'WETH', 'USDT', 'USDC', 'DAI',
    'MATIC', 'BNB', 'LINK', 'UNI', 'AVAX', 'ARB', 'OP',
    'SHIB', 'PEPE', 'FLOKI', 'CRO', 'FTM', 'AAVE', 'SUSHI', 'COMP', 'MKR',
    'IMX', 'APT', 'INJ', 'NEAR', 'FIL', 'VET',
    'GRT', 'SNX', 'CRV', 'BAT', 'ENJ', 'MANA', 'SAND', 'AXS', 'LRC', 'CELO',
  ].map((c) => c.toUpperCase())
);

export function isMoonPayWalletCurrency(code) {
  return code && MOONPAY_WALLET_CODES.has(String(code).toUpperCase());
}

/** Prefer Base network code when sending to our wallet so balance shows in app and Coinbase CDP (Base Mainnet). */
export function toMoonPayCurrencyCode(currencyCode, preferredNetwork = 'base') {
  const c = (currencyCode || '').toLowerCase();
  if (preferredNetwork !== 'base') return c;
  return BASE_NETWORK_CODES[c] || c;
}

/** Mainnet / common testnet Bitcoin address shapes for MoonPay wallet lock-in. */
function looksLikeBitcoinAddress(addr) {
  const s = addr && String(addr).trim();
  if (!s || s.length < 25 || s.length > 90) return false;
  if (/^(bc1|tb1|bcrt1)/i.test(s)) return true;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s)) return true;
  return false;
}

/** Bitcoin testnet P2WPKH (BIP173 test vector); use with MoonPay sandbox / Test Mode. */
export const DEMO_MOONPAY_BTC_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

/**
 * Mainnet-format lock address for signed URLs when not on MoonPay sandbox (dev only via shouldUseDemoMoonPayDestination).
 * Do not use for real customer funds; set MOONPAY_FIXED_BTC_ADDRESS for production.
 */
export const DEMO_MOONPAY_BTC_MAINNET = '1BitcoinEaterAddressDontSendf59kuE';

/** Placeholder EVM address for URL signing when no treasury is configured yet (not for real funds). */
export const DEMO_MOONPAY_EVM_WALLET = '0xdEaD000000000000000000000000000000dEaD';

/**
 * When true, EVM MoonPay URLs use {@link DEMO_MOONPAY_EVM_WALLET} if MOONPAY_FIXED_WALLET_ADDRESS is unset.
 * - Explicit: MOONPAY_USE_DEMO_WALLET=true
 * - MoonPay sandbox: MOONPAY_SANDBOX=true
 * - Local API: NODE_ENV=development
 * Set MOONPAY_USE_DEMO_WALLET=false on production-like hosts if NODE_ENV is wrong.
 */
export function shouldUseDemoMoonPayDestination() {
  if (process.env.MOONPAY_USE_DEMO_WALLET === 'false' || process.env.MOONPAY_USE_DEMO_WALLET === '0') return false;
  if (process.env.MOONPAY_USE_DEMO_WALLET === 'true' || process.env.MOONPAY_USE_DEMO_WALLET === '1') return true;
  if (process.env.MOONPAY_SANDBOX === 'true' || process.env.MOONPAY_SANDBOX === '1') return true;
  return process.env.NODE_ENV === 'development';
}

/**
 * Single EVM (0x) destination for every MoonPay buy when set — locks the widget so users cannot pick another wallet.
 * Optional: MOONPAY_FIXED_BTC_ADDRESS for btc buys (native / SegWit style addresses).
 * When no fixed address is set, see {@link shouldUseDemoMoonPayDestination} for a dev/sandbox placeholder.
 */
export function getMoonPayFixedWalletForCurrency(currencyCode) {
  const raw = (currencyCode || '').toString().toLowerCase();
  const evm = process.env.MOONPAY_FIXED_WALLET_ADDRESS?.trim();
  if (evm && evm.startsWith('0x') && evm.length >= 42 && isEvmCurrency(raw)) return evm;
  const btcFixed = process.env.MOONPAY_FIXED_BTC_ADDRESS?.trim();
  if (btcFixed && looksLikeBitcoinAddress(btcFixed) && raw === 'btc') return btcFixed;

  if (raw === 'btc') {
    const moonPaySandboxHost = MOONPAY_BASE.includes('sandbox');
    if (moonPaySandboxHost) return DEMO_MOONPAY_BTC_TESTNET;
    if (shouldUseDemoMoonPayDestination()) return DEMO_MOONPAY_BTC_MAINNET;
    if (process.env.MOONPAY_LOCK_BTC_WALLET === 'true' || process.env.MOONPAY_LOCK_BTC_WALLET === '1') {
      return DEMO_MOONPAY_BTC_MAINNET;
    }
  }

  if (shouldUseDemoMoonPayDestination() && isEvmCurrency(raw)) return DEMO_MOONPAY_EVM_WALLET;
  return null;
}

/**
 * Build and sign MoonPay widget URL.
 * Pass walletAddress for EVM (0x) and for BTC when provided so MoonPay can lock delivery (no manual wallet step).
 * @param {object} opts
 * @param {string} [opts.walletAddress] - Destination: EVM 0x, or BTC native/bech32/legacy when locking BTC in the widget.
 * @param {string} [opts.currencyCode] - e.g. btc, eth (lowercase)
 * @param {string} [opts.baseCurrencyCode] - e.g. usd
 * @param {number} [opts.baseCurrencyAmount] - Fiat amount to pre-fill (USD when baseCurrencyCode is usd)
 * @param {number} [opts.quoteCurrencyAmount] - Crypto amount to buy (matches app "Amount" in asset units)
 * @param {boolean} [opts.lockAmount] - When true (default), sets MoonPay `lockAmount=true` so the customer cannot change `baseCurrencyAmount` (requires base to be set). See MoonPay buy params.
 * @param {string} [opts.redirectUrl] - Where to send user after completion
 * @param {string} [opts.externalCustomerId] - Your user id
 * @param {string} [opts.preferredNetwork] - 'base' to use Base network codes so crypto lands where app/CDP show (default when wallet is used)
 * @returns {string} Full signed URL
 */
export function getSignedMoonPayUrl(opts) {
  const apiKey = process.env.MOONPAY_PUBLISHABLE_KEY || process.env.MOONPAY_API_KEY;
  const secretKey = process.env.MOONPAY_SECRET_KEY;
  if (!apiKey) throw new Error('MOONPAY_PUBLISHABLE_KEY (or MOONPAY_API_KEY) is required');

  const rawCode = opts.currencyCode ? opts.currencyCode.toLowerCase() : '';
  /** Only attach an EVM 0x address when the buy asset is one we treat as EVM; otherwise MoonPay collects the right address in-widget (e.g. BTC, SOL). */
  const isEvm = isEvmCurrency(rawCode);
  const w = opts.walletAddress && String(opts.walletAddress).trim();
  const looksLikeEvmAddress = w && w.startsWith('0x') && w.length >= 40;
  const looksLikeBtcAddr = w && looksLikeBitcoinAddress(w);
  const useWalletAddress = (looksLikeEvmAddress && isEvm) || (looksLikeBtcAddr && rawCode === 'btc');
  const useBaseCodes = process.env.MOONPAY_USE_BASE_NETWORK === 'true';
  const preferredNetwork = opts.preferredNetwork ?? (useWalletAddress && useBaseCodes ? 'base' : 'ethereum');
  const currencyCode = useWalletAddress && preferredNetwork === 'base' ? toMoonPayCurrencyCode(rawCode, 'base') : rawCode;

  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  if (useWalletAddress) params.set('walletAddress', w);
  params.set('currencyCode', currencyCode);
  if (opts.baseCurrencyCode) params.set('baseCurrencyCode', opts.baseCurrencyCode.toLowerCase());
  if (opts.baseCurrencyAmount != null && Number(opts.baseCurrencyAmount) > 0) {
    params.set('baseCurrencyAmount', String(Math.round(Number(opts.baseCurrencyAmount) * 100) / 100));
  }
  if (opts.quoteCurrencyAmount != null && Number(opts.quoteCurrencyAmount) > 0) {
    const qn = Number(opts.quoteCurrencyAmount);
    params.set('quoteCurrencyAmount', String(Math.round(qn * 1e8) / 1e8));
  }
  const lockOff = process.env.MOONPAY_LOCK_AMOUNT === 'false' || process.env.MOONPAY_LOCK_AMOUNT === '0';
  const lockRequested = opts.lockAmount !== false && !lockOff;
  if (
    lockRequested &&
    opts.baseCurrencyAmount != null &&
    Number(opts.baseCurrencyAmount) > 0
  ) {
    params.set('lockAmount', 'true');
  }
  if (opts.redirectUrl) params.set('redirectURL', opts.redirectUrl);
  if (opts.externalCustomerId) params.set('externalCustomerId', opts.externalCustomerId);
  params.set('theme', 'dark');

  const queryString = params.toString();
  const baseUrl = `${MOONPAY_BASE}?${queryString}`;

  if (!secretKey) {
    return baseUrl;
  }

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update('?' + queryString)
    .digest('base64');

  return `${baseUrl}&signature=${encodeURIComponent(signature)}`;
}
