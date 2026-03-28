import { Router } from 'express';
import { supabase } from '../db.js';
import { applyFee, recordFee } from '../lib/fee.js';

export const transferRouter = Router();

/** Escape % and _ so ilike matches the literal string only. */
function escapeIlikeExact(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Transfer crypto from one wallet to another (same or different user).
 * Ledger-only: updates balances in DB and records a transaction. No blockchain/on-chain send.
 * Destination: pass toUsername (profile username, case-insensitive) or legacy toWalletId (UUID).
 */
transferRouter.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { fromWalletId, amount } = req.body;
    const toUsername =
      typeof req.body.toUsername === 'string' ? req.body.toUsername.trim() : '';
    const toWalletIdRaw = req.body.toWalletId;

    if (!fromWalletId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'fromWalletId and positive amount required' });
    }
    if (!toUsername && !toWalletIdRaw) {
      return res.status(400).json({ error: 'Recipient username required' });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const { data: fromWallet, error: fromErr } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', fromWalletId)
      .eq('user_id', userId)
      .single();

    if (fromErr || !fromWallet) {
      return res.status(404).json({ error: 'Source wallet not found or not yours' });
    }

    let toWallet;

    if (toUsername) {
      const pattern = escapeIlikeExact(toUsername);
      const { data: matches, error: pErr } = await supabase
        .from('profiles')
        .select('id')
        .not('username', 'is', null)
        .ilike('username', pattern)
        .limit(5);

      if (pErr) throw pErr;
      if (!matches?.length) {
        return res.status(404).json({ error: 'No user found with that username' });
      }
      if (matches.length > 1) {
        return res.status(400).json({
          error: 'Multiple users match; ask the recipient for their exact username',
        });
      }

      const recipientId = matches[0].id;
      if (recipientId === userId) {
        return res.status(400).json({ error: 'Cannot transfer to yourself' });
      }

      const { data: existing, error: wErr } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', recipientId)
        .eq('currency', fromWallet.currency)
        .maybeSingle();

      if (wErr) throw wErr;

      if (existing) {
        toWallet = existing;
      } else {
        const ins = await supabase
          .from('wallets')
          .insert({
            user_id: recipientId,
            currency: fromWallet.currency,
            balance: 0,
          })
          .select()
          .single();
        if (ins.error) {
          return res.status(400).json({ error: 'Could not create wallet for recipient' });
        }
        toWallet = ins.data;
      }
    } else {
      const { data: tw, error: toErr } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', toWalletIdRaw)
        .single();

      if (toErr || !tw) {
        return res.status(404).json({ error: 'Destination wallet not found' });
      }
      toWallet = tw;
    }

    if (fromWallet.currency !== toWallet.currency) {
      return res.status(400).json({ error: 'Can only transfer same currency' });
    }

    const fromBalance = Number(fromWallet.balance);
    if (fromBalance < amountNum) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const toWalletId = toWallet.id;

    const { netAmount, feeAmount } = applyFee(amountNum);
    const newFromBalance = fromBalance - amountNum;
    const newToBalance = Number(toWallet.balance) + netAmount;

    const { error: updFrom } = await supabase
      .from('wallets')
      .update({ balance: newFromBalance, updated_at: new Date().toISOString() })
      .eq('id', fromWalletId);

    if (updFrom) throw updFrom;

    const { error: updTo } = await supabase
      .from('wallets')
      .update({ balance: newToBalance, updated_at: new Date().toISOString() })
      .eq('id', toWalletId);

    if (updTo) throw updTo;

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .insert({
        from_wallet_id: fromWalletId,
        to_wallet_id: toWalletId,
        amount: netAmount,
        type: 'transfer',
        metadata: { from_user: fromWallet.user_id, to_user: toWallet.user_id },
      })
      .select()
      .single();

    if (txErr) throw txErr;

    if (feeAmount > 0) {
      await recordFee(fromWallet.currency, feeAmount, {
        fromWalletId,
        metadata: { source: 'transfer', from_user: fromWallet.user_id, to_user: toWallet.user_id },
      });
    }

    res.status(201).json({ success: true, transaction: tx });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
