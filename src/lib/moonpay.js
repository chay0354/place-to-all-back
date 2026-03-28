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

/**
 * Build and sign MoonPay widget URL.
 * Pass walletAddress only for EVM currencies (ETH, USDT, etc.); for BTC we omit it so MoonPay prompts for a Bitcoin address.
 * @param {object} opts
 * @param {string} [opts.walletAddress] - User's EVM wallet address (0x...). Only used when currencyCode is EVM-compatible.
 * @param {string} [opts.currencyCode] - e.g. btc, eth (lowercase)
 * @param {string} [opts.baseCurrencyCode] - e.g. usd
 * @param {number} [opts.baseCurrencyAmount] - Fiat amount to pre-fill
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
  const baseStripped = rawCode.replace(/_base$/, '');
  const isEvm = EVM_CURRENCIES.has(rawCode) || EVM_CURRENCIES.has(baseStripped) || (rawCode.length >= 2 && !['btc', 'sol', 'ltc', 'doge', 'xlm', 'xrp', 'ada', 'atom', 'algo', 'dot', 'bch'].includes(rawCode));
  const looksLikeEvmAddress = opts.walletAddress && String(opts.walletAddress).startsWith('0x') && opts.walletAddress.length >= 40;
  const useWalletAddress = looksLikeEvmAddress && isEvm;
  const useBaseCodes = process.env.MOONPAY_USE_BASE_NETWORK === 'true';
  const preferredNetwork = opts.preferredNetwork ?? (useWalletAddress && useBaseCodes ? 'base' : 'ethereum');
  const currencyCode = useWalletAddress && preferredNetwork === 'base' ? toMoonPayCurrencyCode(rawCode, 'base') : rawCode;

  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  if (useWalletAddress) params.set('walletAddress', opts.walletAddress);
  params.set('currencyCode', currencyCode);
  if (opts.baseCurrencyCode) params.set('baseCurrencyCode', opts.baseCurrencyCode.toLowerCase());
  if (opts.baseCurrencyAmount != null && Number(opts.baseCurrencyAmount) > 0) {
    params.set('baseCurrencyAmount', String(Math.round(Number(opts.baseCurrencyAmount) * 100) / 100));
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
