import { Router } from 'express';
import { supabase } from '../db.js';
import { getSepoliaTransactions } from '../lib/etherscan-sepolia.js';

export const transactionsRouter = Router();

/**
 * GET /api/transactions
 * Returns transaction history for the authenticated user (X-User-Id).
 * When MOONPAY_SANDBOX=true (testing), also includes Sepolia on-chain txs from Etherscan so
 * profile history matches where MoonPay sandbox sends funds. Each transaction includes:
 * id, type, amount, currency, created_at, direction (in/out), description.
 */
transactionsRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: userWallets, error: walletsErr } = await supabase
      .from('wallets')
      .select('id, currency')
      .eq('user_id', userId);

    if (walletsErr) throw walletsErr;
    const walletIds = (userWallets || []).map((w) => w.id);
    const walletById = (userWallets || []).reduce((acc, w) => ({ ...acc, [w.id]: w }), {});

    let rows = [];
    if (walletIds.length > 0) {
      const [{ data: fromRows }, { data: toRows }] = await Promise.all([
        supabase.from('transactions').select('id, from_wallet_id, to_wallet_id, amount, type, metadata, created_at').in('from_wallet_id', walletIds).order('created_at', { ascending: false }).limit(100),
        supabase.from('transactions').select('id, from_wallet_id, to_wallet_id, amount, type, metadata, created_at').in('to_wallet_id', walletIds).order('created_at', { ascending: false }).limit(100),
      ]);
      const seen = new Set();
      for (const r of [...(fromRows || []), ...(toRows || [])]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rows.push(r);
      }
    }

    const list = rows.map((tx) => {
      const fromWallet = tx.from_wallet_id ? walletById[tx.from_wallet_id] : null;
      const toWallet = tx.to_wallet_id ? walletById[tx.to_wallet_id] : null;
      const isOut = fromWallet != null;
      const isIn = toWallet != null;
      const currency = (toWallet || fromWallet)?.currency || (tx.metadata?.currency || '').toUpperCase();
      let description = tx.type;
      if (tx.type === 'buy') description = 'Buy';
      else if (tx.type === 'sell') description = 'Sell';
      else if (tx.type === 'transfer') description = isOut ? 'Transfer sent' : 'Transfer received';
      else if (tx.type === 'affiliate') {
        description = tx.metadata?.kind === 'super_upline' ? 'Super-agent commission' : 'Affiliate commission';
      }
      if (tx.metadata?.source === 'moonpay') description = 'Buy (MoonPay)';

      return {
        id: tx.id,
        type: tx.type,
        amount: Number(tx.amount),
        currency: currency || '—',
        created_at: tx.created_at,
        direction: isIn && !isOut ? 'in' : 'out',
        description,
        metadata: tx.metadata,
      };
    });

    const useSepolia = process.env.MOONPAY_SANDBOX === 'true' || process.env.MOONPAY_SANDBOX === '1';
    if (useSepolia) {
      const { data: coinbaseRow } = await supabase
        .from('coinbase_wallets')
        .select('wallet_id, default_address, delivery_address')
        .eq('user_id', userId)
        .maybeSingle();
      const address = coinbaseRow?.delivery_address || coinbaseRow?.default_address || coinbaseRow?.wallet_id;
      if (address && String(address).startsWith('0x')) {
        const sepoliaTxs = await getSepoliaTransactions(address, 50);
        const multiplier = Number(process.env.MOONPAY_SANDBOX_DISPLAY_MULTIPLIER) || 100;
        const scaledTxs = sepoliaTxs.map((tx) => ({ ...tx, amount: tx.amount * multiplier }));
        const merged = [...list, ...scaledTxs];
        merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return res.json(merged.slice(0, 100));
      }
    }

    res.json(list.slice(0, 100));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
