import { Router } from 'express';
import { createBuyQuote, createSellQuote, getSpotPriceUsd, createWallet, getSupportedCryptoCurrencies, getWalletBalancesFromCDPAllNetworks } from '../lib/coinbase.js';
import { getSepoliaBalance } from '../lib/etherscan-sepolia.js';
import { supabase } from '../index.js';

export const coinbaseRouter = Router();

/** Ensure user has ledger wallet rows (BTC, ETH, USDT). Only create with balance 0 if missing — never overwrite existing balances. */
async function ensureLedgerWallets(userId) {
  const currencies = ['BTC', 'ETH', 'USDT'];
  const { data: existing } = await supabase
    .from('wallets')
    .select('currency')
    .eq('user_id', userId)
    .in('currency', currencies);
  const existingSet = new Set((existing || []).map((r) => r.currency));
  const toCreate = currencies.filter((c) => !existingSet.has(c));
  if (toCreate.length === 0) return;
  const rows = toCreate.map((currency) => ({
    user_id: userId,
    currency,
    balance: 0,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('wallets').insert(rows);
  if (error) throw new Error(`Could not create ledger wallets: ${error.message}`);
}

/**
 * GET or POST /api/coinbase/wallet
 * Ensures the user has a Coinbase CDP wallet and ledger wallets. Never skip. Requires X-User-Id.
 */
async function ensureCoinbaseWallet(userId) {
  const { data: existing } = await supabase
    .from('coinbase_wallets')
    .select('wallet_id, network_id, default_address, delivery_address')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    await ensureLedgerWallets(userId);
    const effectiveAddress = existing.delivery_address || existing.default_address || existing.wallet_id;
    return {
      wallet_id: existing.wallet_id,
      network_id: existing.network_id,
      default_address: existing.default_address,
      delivery_address: existing.delivery_address ?? null,
      effective_address: effectiveAddress,
    };
  }

  const wallet = await createWallet({ userId });

  const { error } = await supabase.from('coinbase_wallets').upsert(
    {
      user_id: userId,
      wallet_id: wallet.id,
      network_id: wallet.network_id,
      default_address: wallet.default_address ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(`Could not save wallet: ${error.message}`);

  await ensureLedgerWallets(userId);
  const effectiveAddress = wallet.default_address || wallet.id;
  return {
    wallet_id: wallet.id,
    network_id: wallet.network_id,
    default_address: wallet.default_address,
    delivery_address: null,
    effective_address: effectiveAddress,
  };
}

/** Ledger rows only; does not call Coinbase CDP. */
async function getCoinbaseWalletIfExists(userId) {
  await ensureLedgerWallets(userId);
  const { data: existing } = await supabase
    .from('coinbase_wallets')
    .select('wallet_id, network_id, default_address, delivery_address')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    const effectiveAddress = existing.delivery_address || existing.default_address || existing.wallet_id;
    return {
      wallet_id: existing.wallet_id,
      network_id: existing.network_id,
      default_address: existing.default_address,
      delivery_address: existing.delivery_address ?? null,
      effective_address: effectiveAddress,
    };
  }

  return {
    wallet_id: null,
    network_id: null,
    default_address: null,
    delivery_address: null,
    effective_address: null,
  };
}

/** GET — return saved CDP wallet if any; never creates a new Coinbase wallet. */
coinbaseRouter.get('/wallet', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const wallet = await getCoinbaseWalletIfExists(userId);
    res.json(wallet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST — explicitly create / ensure Coinbase CDP wallet (optional; e.g. MoonPay). */
coinbaseRouter.post('/wallet', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const wallet = await ensureCoinbaseWallet(userId);
    res.json(wallet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/coinbase/wallet
 * Set your own wallet address (e.g. Coinbase Wallet) so MoonPay sends purchases there and you see funds in Coinbase.
 * Body: { delivery_address: "0x..." }
 */
coinbaseRouter.patch('/wallet', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const raw = req.body?.delivery_address;
    const addr = typeof raw === 'string' ? raw.trim() : '';
    if (!addr) {
      const { error } = await supabase
        .from('coinbase_wallets')
        .update({ delivery_address: null, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
      const wallet = await ensureCoinbaseWallet(userId);
      return res.json(wallet);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return res.status(400).json({ error: 'Invalid address. Use a valid EVM address (0x + 40 hex characters).' });
    }
    await ensureCoinbaseWallet(userId);
    const { error } = await supabase
      .from('coinbase_wallets')
      .update({ delivery_address: addr, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    const wallet = await ensureCoinbaseWallet(userId);
    res.json(wallet);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/coinbase/price?currency=BTC
 * Returns current USD spot price for the asset (from Coinbase public API).
 */
coinbaseRouter.get('/price', async (req, res) => {
  try {
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const price = await getSpotPriceUsd(currency);
    res.json({ currency, priceUsd: price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/coinbase/quote/buy?fiatAmount=100&currency=BTC
 * Returns estimated crypto amount for fiat (sandbox simulated if no API keys).
 */
coinbaseRouter.get('/quote/buy', async (req, res) => {
  try {
    const fiatAmount = Number(req.query.fiatAmount) || 100;
    const fiatCurrency = (req.query.fiatCurrency || 'USD').toUpperCase();
    const currency = (req.query.currency || 'BTC').toUpperCase();

    const quote = await createBuyQuote({ fiatAmount, fiatCurrency, cryptoAsset: currency });
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/coinbase/quote/sell?cryptoAmount=0.001&currency=BTC
 * Returns estimated fiat for crypto amount.
 */
coinbaseRouter.get('/quote/sell', async (req, res) => {
  try {
    const cryptoAmount = Number(req.query.cryptoAmount) || 0.001;
    const currency = (req.query.currency || 'BTC').toUpperCase();
    const fiatCurrency = (req.query.fiatCurrency || 'USD').toUpperCase();

    const quote = await createSellQuote({ cryptoAmount, cryptoAsset: currency, fiatCurrency });
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/coinbase/currencies
 * Returns list of supported crypto currency codes from Coinbase (for buy/sell dropdowns).
 */
coinbaseRouter.get('/currencies', async (req, res) => {
  try {
    const list = await getSupportedCryptoCurrencies();
    res.json({ currencies: list.map((code) => ({ code })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Buy page: coins we show. Preferred order; rest from Coinbase support. */
const BUY_PAGE_ORDER = [
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'USDT', 'USDC', 'DOT', 'MATIC', 'LTC', 'AVAX', 'LINK', 'UNI', 'ATOM', 'XLM', 'ALGO', 'FIL', 'VET', 'TRX', 'NEAR', 'APT', 'ARB', 'OP', 'INJ', 'IMX',
  'DAI', 'BNB', 'SHIB', 'PEPE', 'FLOKI', 'CRO', 'FTM', 'AAVE', 'SUSHI', 'COMP', 'MKR', 'GRT', 'SNX', 'CRV', 'BAT', 'ENJ', 'MANA', 'SAND', 'AXS', 'LRC', 'CELO',
];
const BUY_PAGE_CODES = new Set(BUY_PAGE_ORDER.map((c) => c.toUpperCase()));

/**
 * GET /api/coinbase/currencies/buy
 * Returns currencies for the buy page (Rapyd + instant test): BTC, ETH, SOL, USDT, etc.
 */
coinbaseRouter.get('/currencies/buy', async (req, res) => {
  try {
    let list = [];
    try {
      list = await getSupportedCryptoCurrencies();
    } catch (_) {}
    const listSet = new Set((list || []).map((c) => (c || '').toUpperCase()));
    const allowed = list.length
      ? list.filter((code) => BUY_PAGE_CODES.has((code || '').toUpperCase()))
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
    res.json({ currencies: buyable.map((code) => ({ code })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/coinbase/balances
 * Returns on-chain token balances for the user's wallet. When MOONPAY_SANDBOX=true (testing),
 * uses Sepolia via Etherscan so balance matches MoonPay sandbox (funds land on Ethereum Sepolia).
 * Otherwise uses CDP across ethereum, base, and base-sepolia. Requires X-User-Id.
 */
coinbaseRouter.get('/balances', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const wallet = await getCoinbaseWalletIfExists(userId);
    const address = wallet.effective_address || wallet.default_address;
    if (!address || !String(address).startsWith('0x')) return res.json({ balances: [] });

    const useSepolia = process.env.MOONPAY_SANDBOX === 'true' || process.env.MOONPAY_SANDBOX === '1';
    if (useSepolia) {
      const ethBalance = await getSepoliaBalance(address);
      const multiplier = Number(process.env.MOONPAY_SANDBOX_DISPLAY_MULTIPLIER) || 100;
      const displayBalance = ethBalance * multiplier;
      const balances = [{ currency: 'ETH', balance: displayBalance }];
      return res.json({ balances });
    }

    const balances = await getWalletBalancesFromCDPAllNetworks(address);
    res.json({ balances });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
