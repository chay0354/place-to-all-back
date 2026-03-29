/**
 * Coinbase CDP Sandbox API client.
 * Sandbox base: https://sandbox.cdp.coinbase.com
 * Used for buy/sell quotes and (optional) execution in test env.
 * Spot prices use public Coinbase API for real-time USD conversion.
 * Wallet: uses CDP Server Wallet v2 (createEvmAccount) when CDP_WALLET_SECRET is set; otherwise tries v1 JWT.
 */

import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { CdpClient } from '@coinbase/cdp-sdk';

const COINBASE_BASE = process.env.COINBASE_SANDBOX === 'true' || process.env.COINBASE_SANDBOX === '1'
  ? 'https://sandbox.cdp.coinbase.com'
  : 'https://api.cdp.coinbase.com';

/** Wallet API lives at /platform. */
const COINBASE_WALLET_BASE = process.env.COINBASE_WALLET_BASE || `${COINBASE_BASE}/platform`;
const COINBASE_WALLET_HOST = process.env.COINBASE_SANDBOX === 'true' || process.env.COINBASE_SANDBOX === '1'
  ? 'sandbox.cdp.coinbase.com'
  : 'api.cdp.coinbase.com';

/** Public API (no auth) for current spot price in USD. */
const COINBASE_PUBLIC = 'https://api.coinbase.com';

const ROUGH_USD_PER_UNIT = { btc: 50000, eth: 2000, usdt: 1 };

/** Fiat codes to exclude when listing crypto from exchange-rates. */
const FIAT_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'INR', 'BRL', 'MXN', 'KRW', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'PLN', 'THB', 'IDR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP', 'AED', 'COP', 'SAR', 'MYR', 'RON', 'ZAR', 'NGN', 'ARS', 'EGP', 'PKR', 'VND', 'TRY', 'PEN', 'UAH', 'BGN', 'HRK', 'RUB', 'TWD', 'NZD', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'LKR', 'BDT', 'KES', 'GHS', 'MAD', 'XAF', 'XOF', 'NPR', 'UYU', 'BOB', 'GTQ', 'CRC', 'PAB', 'DOP', 'TND', 'LBP', 'JMD', 'MMK', 'GEL', 'AZN', 'AMD', 'KZT', 'UZS', 'TMT', 'ALL', 'MKD', 'RSD', 'BAM', 'BYN', 'MDL', 'KGS', 'TJS', 'XCD', 'BBD', 'BZD', 'TTD', 'AWG', 'ANG', 'DZD', 'ETB', 'TZS', 'UGX', 'ZMW', 'BWP', 'MUR', 'MNT', 'MVR', 'NIO', 'SYP', 'YER', 'AFN', 'IRR', 'IQD', 'LYD', 'SDG', 'SSP', 'SLL', 'LRD', 'GNF', 'MRU', 'DJF', 'KMF', 'STN', 'CVE', 'SZL', 'LSL', 'MGA', 'RWF', 'SCR', 'MOP', 'LAK', 'KHR', 'BND', 'BIF', 'XPF', 'TOP', 'VUV', 'WST', 'SBD', 'FJD', 'PGK', 'MZN', 'SRD', 'HTG', 'CDF', 'GMD', 'XAF', 'XOF',
]);

/** In-memory cache for supported crypto list (refreshed periodically). */
let cachedCryptoList = null;
let cachedCryptoListAt = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 min

/**
 * Get list of supported crypto currency codes from Coinbase (exchange-rates). No auth.
 * @returns {Promise<string[]>} Sorted list of codes (e.g. ['BTC', 'ETH', 'USDT', ...])
 */
export async function getSupportedCryptoCurrencies() {
  if (cachedCryptoList && Date.now() - cachedCryptoListAt < CACHE_MS) {
    return cachedCryptoList;
  }
  try {
    const res = await fetch(`${COINBASE_PUBLIC}/v2/exchange-rates?currency=USD`);
    const json = await res.json().catch(() => ({}));
    const rates = json?.data?.rates;
    if (rates && typeof rates === 'object') {
      const codes = Object.keys(rates).filter((code) => code && !FIAT_CODES.has(code.toUpperCase()));
      cachedCryptoList = [...new Set(codes)].map((c) => c.toUpperCase()).sort();
      cachedCryptoListAt = Date.now();
      return cachedCryptoList;
    }
  } catch (_) {}
  // Fallback: common Coinbase cryptos
  cachedCryptoList = [
    'BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOGE', 'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'BCH', 'ETC', 'XLM', 'ALGO', 'FIL', 'VET', 'ICP', 'APT', 'ARB', 'OP', 'INJ', 'NEAR', 'IMX', 'GRT', 'AAVE', 'MKR', 'CRV', 'SNX', 'COMP', 'SUSHI', 'YFI', 'BAT', 'ZRX', 'ENJ', 'MANA', 'SAND', 'AXS', 'APE', 'SHIB', 'PEPE', 'FLOKI', 'TRX', 'HBAR', 'FTM', 'ONE', 'CELO', 'KAVA', 'RUNE', 'THETA', 'XTZ', 'EGLD', 'FLOW', 'KSM', 'ZEC', 'DASH', 'XMR', 'EOS', 'WAVES', 'SC', 'STORJ', 'ANKR', 'CHZ', 'CRO', 'REN', 'OCEAN', 'AUDIO', 'LRC', 'SKL', 'KNC', 'REP', 'BAL', 'UMA', 'BNT', 'RLC', 'NMR', 'OMG', 'ANT',
  ].sort();
  cachedCryptoListAt = Date.now();
  return cachedCryptoList;
}

/** Check if a currency code is supported (uses cache). */
export async function isSupportedCrypto(code) {
  const list = await getSupportedCryptoCurrencies();
  return list.includes((code || '').toUpperCase());
}

/** Preferred order for buy UI and market overview (same curated set as /currencies/buy). */
export const BUY_PAGE_ORDER = [
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'USDT', 'USDC', 'DOT', 'MATIC', 'LTC', 'AVAX', 'LINK', 'UNI', 'ATOM', 'XLM', 'ALGO', 'FIL', 'VET', 'TRX', 'NEAR', 'APT', 'ARB', 'OP', 'INJ', 'IMX',
  'DAI', 'BNB', 'SHIB', 'PEPE', 'FLOKI', 'CRO', 'FTM', 'AAVE', 'SUSHI', 'COMP', 'MKR', 'GRT', 'SNX', 'CRV', 'BAT', 'ENJ', 'MANA', 'SAND', 'AXS', 'LRC', 'CELO',
];

/**
 * Ordered list of buy-page / market tickers (intersection with Coinbase support when available).
 * Mirrors GET /api/coinbase/currencies/buy logic.
 */
export async function getBuyableCurrencyCodesOrdered() {
  let list = [];
  try {
    list = await getSupportedCryptoCurrencies();
  } catch (_) {}
  const buyPageCodes = new Set(BUY_PAGE_ORDER.map((c) => c.toUpperCase()));
  const listSet = new Set((list || []).map((c) => (c || '').toUpperCase()));
  const allowed = list.length
    ? list.filter((code) => buyPageCodes.has((code || '').toUpperCase()))
    : [...BUY_PAGE_ORDER];
  const ordered = BUY_PAGE_ORDER.filter((c) => listSet.has(c) || !list.length);
  const rest = allowed.filter((c) => !ordered.includes(c));
  let buyable = ordered.length || rest.length ? [...ordered, ...rest.sort()] : BUY_PAGE_ORDER.slice(0, 30);
  const seen = new Set(buyable.map((c) => c.toUpperCase()));
  for (const c of BUY_PAGE_ORDER) {
    if (!seen.has(c)) {
      buyable = [c, ...buyable];
      seen.add(c);
    }
  }
  return buyable;
}

/**
 * Get current spot price for a crypto asset in USD from Coinbase public API.
 * @param {string} assetId - e.g. btc, eth, usdt
 * @returns {Promise<number>} USD per 1 unit of asset, or fallback rough value on error
 */
export async function getSpotPriceUsd(assetId) {
  const key = (assetId || 'btc').toLowerCase();
  const pair = `${key.toUpperCase()}-USD`;
  try {
    const res = await fetch(`${COINBASE_PUBLIC}/v2/prices/${pair}/spot`);
    const data = await res.json().catch(() => ({}));
    const amount = data?.data?.amount;
    if (amount != null) {
      const num = Number(amount);
      if (Number.isFinite(num) && num > 0) return num;
    }
  } catch (_) {}
  return ROUGH_USD_PER_UNIT[key] ?? 50000;
}

/**
 * Make authenticated request to Coinbase CDP REST API.
 * Auth: API key name + private key (JWT or similar). CDP uses different auth - check docs.
 * For sandbox, some endpoints may use API key in header.
 */
async function coinbaseRequest(method, path, body = null) {
  const apiKey = process.env.COINBASE_API_KEY;
  const apiSecret = process.env.COINBASE_API_SECRET;
  const url = `${COINBASE_BASE}${path}`;

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['X-CC-Api-Key'] = apiKey;
  if (apiSecret) headers['X-CC-Api-Secret'] = apiSecret;

  const res = await fetch(url, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `Coinbase ${res.status}`);
  return data;
}

/** Default network for new wallets (sandbox: base-sepolia; production: base-mainnet or similar) */
const DEFAULT_WALLET_NETWORK = process.env.COINBASE_WALLET_NETWORK || 'base-sepolia';

/** CDP listTokenBalances supports base, base-sepolia, ethereum. Map our network_id to CDP network. */
function toListBalancesNetwork(networkId) {
  const n = (networkId || '').toLowerCase();
  if (n === 'base-mainnet' || n === 'base') return 'base';
  if (n === 'base-sepolia') return 'base-sepolia';
  if (n === 'ethereum') return 'ethereum';
  return n || 'base-sepolia';
}

/** Networks to query. Set ONLY_BASE_SEPOLIA=true to see everything on Base Sepolia only (matches Coinbase CDP dropdown). */
const BALANCE_NETWORKS = process.env.ONLY_BASE_SEPOLIA === 'true' || process.env.ONLY_BASE_SEPOLIA === '1'
  ? ['base-sepolia']
  : ['ethereum', 'base', 'base-sepolia'];

/**
 * Fetch on-chain token balances for an EVM address from CDP on a single network. Returns array of { currency, balance }.
 * @param {string} address - 0x address
 * @param {string} [networkId] - e.g. base-sepolia, base, ethereum
 * @returns {Promise<Array<{ currency: string, balance: number }>>}
 */
export async function getWalletBalancesFromCDP(address, networkId) {
  if (!address || !String(address).startsWith('0x')) return [];
  const apiKey = process.env.CDP_API_KEY_ID || process.env.COINBASE_API_KEY;
  const apiSecret = process.env.CDP_API_KEY_SECRET || process.env.COINBASE_API_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET || process.env.COINBASE_WALLET_SECRET || null;
  if (!apiKey || !apiSecret) return [];

  const network = toListBalancesNetwork(networkId);
  const basePath = COINBASE_WALLET_BASE;

  try {
    const cdp = new CdpClient({
      apiKeyId: apiKey,
      apiKeySecret: apiSecret,
      walletSecret: walletSecret || undefined,
      basePath,
    });
    const result = await cdp.evm.listTokenBalances({ address, network, pageSize: 100 });
    const list = [];
    for (const item of result.balances || []) {
      const symbol = (item.token?.symbol || '').toUpperCase();
      if (!symbol) continue;
      const decimals = Number(item.amount?.decimals ?? 18);
      const raw = BigInt(item.amount?.amount ?? 0);
      const balance = Number(raw) / Math.pow(10, decimals);
      if (balance <= 0) continue;
      list.push({ currency: symbol, balance });
    }
    return list;
  } catch (e) {
    const msg = e?.message || e?.toString?.() || String(e);
    const status = e?.response?.status || e?.status;
    console.error('[Coinbase] getWalletBalancesFromCDP', network, address?.slice(0, 10) + '…', status || '', msg);
    return [];
  }
}

/** Public RPC for fallback native ETH when CDP returns empty. Base Sepolia when ONLY_BASE_SEPOLIA. */
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const ETHEREUM_RPC = process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com';

/**
 * Fetch native ETH balance via public RPC. Uses Base Sepolia RPC when ONLY_BASE_SEPOLIA, else Ethereum mainnet.
 */
async function getEthBalanceFromRpc(address) {
  const rpc = BALANCE_NETWORKS.includes('base-sepolia') && BALANCE_NETWORKS.length === 1
    ? BASE_SEPOLIA_RPC
    : ETHEREUM_RPC;
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    });
    const data = await res.json().catch(() => ({}));
    const hex = data?.result;
    if (hex && typeof hex === 'string') {
      const wei = BigInt(hex);
      return Number(wei) / 1e18;
    }
  } catch (e) {
    console.error('[Coinbase] getEthBalanceFromRpc:', e?.message || e);
  }
  return 0;
}

/**
 * Fetch on-chain balances. When ONLY_BASE_SEPOLIA=true, only Base Sepolia (so dashboard matches Coinbase CDP).
 * If CDP returns empty, fallback to public RPC for native ETH (Base Sepolia or Ethereum depending on config).
 */
export async function getWalletBalancesFromCDPAllNetworks(address) {
  if (!address || !String(address).startsWith('0x')) return [];
  const merged = new Map();
  for (const network of BALANCE_NETWORKS) {
    const list = await getWalletBalancesFromCDP(address, network);
    for (const { currency, balance } of list) {
      const prev = merged.get(currency) ?? 0;
      merged.set(currency, prev + balance);
    }
  }
  if (merged.size === 0) {
    const ethBalance = await getEthBalanceFromRpc(address);
    if (ethBalance > 0) merged.set('ETH', ethBalance);
  }
  return Array.from(merged.entries()).map(([currency, balance]) => ({ currency, balance }));
}

/**
 * Get a CDP client for faucet. Faucet (Base Sepolia / Ethereum Sepolia test tokens) is on production API.
 * Use COINBASE_FAUCET_BASE in .env to override (e.g. sandbox if your keys support it).
 */
function getFaucetCdpClient() {
  const apiKey = process.env.CDP_API_KEY_ID || process.env.COINBASE_API_KEY;
  const apiSecret = process.env.CDP_API_KEY_SECRET || process.env.COINBASE_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('CDP API keys required for faucet');
  const basePath = process.env.COINBASE_FAUCET_BASE || 'https://api.cdp.coinbase.com/platform';
  return new CdpClient({
    apiKeyId: apiKey,
    apiKeySecret: apiSecret,
    basePath,
  });
}

/**
 * Request test tokens for an address on Base Sepolia (sandbox). Use so the wallet shows balances in sandbox.
 * @param {string} address - 0x... EVM address
 * @param {'eth'|'usdc'} [token='eth']
 * @returns {Promise<{ transactionHash: string }>}
 */
export async function requestSandboxFaucet(address, token = 'eth') {
  const cdp = getFaucetCdpClient();
  return cdp.evm.requestFaucet({
    address,
    network: 'base-sepolia',
    token: token === 'usdc' ? 'usdc' : 'eth',
  });
}

/** Path used for Wallet API v1. Sandbox uses /v1/wallets; production may use /platform/v1/wallets. */
const WALLET_API_PATH_PLATFORM = '/platform/v1/wallets';
const WALLET_API_PATH_ROOT = '/v1/wallets';

/** Account name must be 2–36 chars, alphanumeric and hyphens. */
function toAccountName(userId) {
  if (!userId || typeof userId !== 'string') return `w-${Date.now()}`;
  const safe = userId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 34);
  return safe.length >= 2 ? safe : `u-${safe || Date.now()}`;
}

/**
 * Create a CDP wallet (sandbox or production). Prefers Server Wallet v2 (EVM account) when CDP_WALLET_SECRET is set; else tries v1.
 * Throws if wallet cannot be created — never open a user without a wallet.
 * @param {object} [opts]
 * @param {string} [opts.userId] - app user id (used as account name for v2)
 * @param {string} [opts.networkId] - e.g. base-sepolia (sandbox), base-mainnet (prod)
 * @returns {Promise<{ id: string, default_address?: string, network_id: string }>}
 */
export async function createWallet(opts = {}) {
  // Support both CDP_* (docs quickstart) and COINBASE_* env names
  const apiKey = process.env.CDP_API_KEY_ID || process.env.COINBASE_API_KEY;
  const apiSecret = process.env.CDP_API_KEY_SECRET || process.env.COINBASE_API_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET || process.env.COINBASE_WALLET_SECRET || null;
  if (!apiKey || !apiSecret) {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET (or COINBASE_API_KEY and COINBASE_API_SECRET) are required.');
  }

  const networkId = opts.networkId || DEFAULT_WALLET_NETWORK;

  let useV1 = !walletSecret;
  if (walletSecret) {
    const basePath = COINBASE_WALLET_BASE;
    const isSandbox = basePath.includes('sandbox.');
    try {
      const cdp = new CdpClient({
        apiKeyId: apiKey,
        apiKeySecret: apiSecret,
        walletSecret,
        basePath,
      });
      const account = await cdp.evm.createAccount({ name: toAccountName(opts.userId) });
      const address = account?.address ?? account?.id;
      if (!address) throw new Error('CDP createAccount returned no address.');
      return { id: address, default_address: address, network_id: networkId };
    } catch (e) {
      const is404 = e?.statusCode === 404 || (e?.message && String(e.message).includes('not found'));
      if (is404 && isSandbox) {
        console.log('[Coinbase] v2 not available on sandbox, using v1 wallet on sandbox.');
        useV1 = true;
      } else if (is404) {
        throw new Error(
          `Server Wallet API not found (404) at ${basePath}. ` +
          'Set COINBASE_WALLET_BASE to https://api.cdp.coinbase.com/platform for production, or ensure Server Wallet is enabled: https://portal.cdp.coinbase.com/products/server-wallet'
        );
      } else {
        throw new Error(`Coinbase create wallet failed: ${e.message}`);
      }
    }
  }

  // v1 wallets with JWT (when no Wallet Secret, or when v2 returns 404 on sandbox).
  const body = {
    wallet: {
      network_id: networkId,
      use_server_signer: false,
    },
  };

  // Sandbox v1: try both URL shapes (root and /platform). Production: /platform/v1/wallets.
  const isSandboxEnv = process.env.COINBASE_SANDBOX === 'true' || process.env.COINBASE_SANDBOX === '1';
  const hostsToTry = isSandboxEnv
    ? [
        { host: 'sandbox.cdp.coinbase.com', base: 'https://sandbox.cdp.coinbase.com', requestPath: WALLET_API_PATH_ROOT },
        { host: 'sandbox.cdp.coinbase.com', base: 'https://sandbox.cdp.coinbase.com/platform', requestPath: WALLET_API_PATH_PLATFORM },
      ]
    : [
        { host: 'api.cdp.coinbase.com', base: 'https://api.cdp.coinbase.com/platform', requestPath: WALLET_API_PATH_PLATFORM },
        { host: 'sandbox.cdp.coinbase.com', base: 'https://sandbox.cdp.coinbase.com', requestPath: WALLET_API_PATH_ROOT },
      ];

  const fetchTimeoutMs = 25000; // don't hang forever on Coinbase
  let lastError;
  for (const { host, base, requestPath } of hostsToTry) {
    console.log(`[Coinbase] Creating wallet (v1 ${host})...`);
    const jwt = await generateJwt({
      apiKeyId: apiKey,
      apiKeySecret: apiSecret,
      requestMethod: 'POST',
      requestHost: host,
      requestPath,
      expiresIn: 120,
    });

    const url = `${base}${requestPath}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      lastError = fetchErr.name === 'AbortError'
        ? `Request timed out after ${fetchTimeoutMs / 1000}s`
        : (fetchErr.message || 'Network error');
      continue;
    }
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const wallet = data?.data ?? data?.wallet ?? data;
      const id = wallet?.id ?? data?.id;
      const defaultAddress = wallet?.default_address ?? data?.default_address;
      if (!id) throw new Error('Coinbase create wallet returned no wallet id.');
      return { id, default_address: defaultAddress, network_id: networkId };
    }
    lastError = data.error?.message || data.message || data.status?.message || `Coinbase ${res.status}`;
    const isRateLimit = res.status === 429 || (String(lastError).toLowerCase().includes('rate limit'));
    if (isRateLimit) {
      console.log(`[Coinbase] v1 rate limited. Use CDP_WALLET_SECRET for Server Wallet v2 (no limit).`);
      break; // fail fast — don't wait 65s × N retries
    }
    if (res.status !== 404) break;
  }

  const hint = isSandboxEnv
    ? ' Wallet creation is not available on sandbox. Set COINBASE_WALLET_BASE=https://api.cdp.coinbase.com/platform in .env to use production for wallets (same API keys may work).'
    : ' Set CDP_WALLET_SECRET for Server Wallet v2: https://portal.cdp.coinbase.com/products/server-wallet/accounts';
  throw new Error(`Coinbase create wallet failed: ${lastError}. ${hint}`);
}

/**
 * Create a buy quote (onramp) - estimate crypto amount for fiat.
 * Sandbox: simulated rates.
 * @param {object} opts
 * @param {number} opts.fiatAmount - Amount in fiat (e.g. 100)
 * @param {string} opts.fiatCurrency - e.g. USD
 * @param {string} opts.cryptoAsset - e.g. BTC, ETH
 */
export async function createBuyQuote({ fiatAmount, fiatCurrency = 'USD', cryptoAsset }) {
  try {
    const result = await coinbaseRequest('POST', '/v1/buy/quote', {
      fiat_amount: String(fiatAmount),
      fiat_currency: fiatCurrency,
      asset_id: cryptoAsset?.toLowerCase() || 'btc',
    });
    return result;
  } catch (e) {
    // CDP may 404 if path/base changed or keys are for different product; use public spot price
    const priceUsd = await getSpotPriceUsd(cryptoAsset);
    const estimatedCrypto = fiatCurrency === 'USD' ? fiatAmount / priceUsd : fiatAmount / priceUsd;
    return {
      simulated: true,
      fiat_amount: fiatAmount,
      asset_id: cryptoAsset,
      estimated_crypto: estimatedCrypto,
      total_crypto: estimatedCrypto,
      crypto_amount: estimatedCrypto,
    };
  }
}

/**
 * Create a sell quote (offramp) - estimate fiat for crypto amount.
 */
export async function createSellQuote({ cryptoAmount, cryptoAsset, fiatCurrency = 'USD' }) {
  const key = (cryptoAsset || 'btc').toLowerCase();
  try {
    const result = await coinbaseRequest('POST', '/v1/sell/quote', {
      crypto_amount: String(cryptoAmount),
      asset_id: key,
      fiat_currency: fiatCurrency,
    });
    return result;
  } catch (e) {
    // CDP may 404; use public spot price
    const priceUsd = await getSpotPriceUsd(cryptoAsset);
    const estimatedFiat = cryptoAmount * priceUsd;
    return {
      simulated: true,
      crypto_amount: cryptoAmount,
      asset_id: cryptoAsset,
      estimated_fiat: estimatedFiat,
      total_fiat: estimatedFiat,
      fiat_amount: estimatedFiat,
    };
  }
}
