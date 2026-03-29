import { Router } from 'express';
import { supabase } from '../db.js';
import { createBuyQuote, getSpotPriceUsd, isSupportedCrypto } from '../lib/coinbase.js';
import { applyFee, recordFee, computeBuySplit, recordBuySystemFee } from '../lib/fee.js';
import {
  getBuyCommissionFlags,
  recordAgentCommission,
  recordSuperAgentCommission,
  recordSuperSuperAgentCommission,
} from '../lib/affiliate.js';
import { assertValidPaymentLinkForAgent } from '../lib/payment-link.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

export const buySellRouter = Router();

/** Get system treasury wallet for a currency (create if missing) */
async function getOrCreateTreasuryWallet(currency) {
  const { data: existing } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', SYSTEM_USER_ID)
    .eq('currency', currency)
    .single();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('wallets')
    .insert({
      user_id: SYSTEM_USER_ID,
      currency,
      balance: 0
    })
    .select()
    .single();

  if (error) throw error;
  return created;
}

/**
 * Fulfill a buy from fiat: get Coinbase quote, credit user from treasury. Used by POST /buy and Rapyd webhook.
 * @param {string} userId
 * @param {string} currencyCode - e.g. ETH, BTC
 * @param {number} fiatAmount - USD amount
 * @param {object} [metadata] - extra metadata for transaction (e.g. source: 'rapyd')
 * @returns {{ transaction, newBalance }}
 */
export async function fulfillBuyFromFiat(payerUserId, currencyCode, fiatAmount, metadata = {}, options = {}) {
  const creditUserId = options.creditUserId || payerUserId;
  const code = (currencyCode || '').toUpperCase();
  if (!code) throw new Error('currency required');
  const supported = await isSupportedCrypto(code);
  if (!supported) throw new Error(`Unsupported currency: ${code}`);

  const quote = await createBuyQuote({
    fiatAmount: Number(fiatAmount),
    fiatCurrency: 'USD',
    cryptoAsset: code,
  });
  const amountNum = Number(quote.total_crypto ?? quote.crypto_amount ?? quote.estimated_crypto ?? 0);
  if (!amountNum || amountNum <= 0) throw new Error('Coinbase quote did not return a valid crypto amount');

  const flags = await getBuyCommissionFlags(payerUserId);
  const { userNet, systemFee, agentFee, superAgentFee, superSuperAgentFee } = computeBuySplit(amountNum, flags);

  const treasury = await getOrCreateTreasuryWallet(code);

  const { data: userWallet, error: userErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', creditUserId)
    .eq('currency', code)
    .maybeSingle();

  let walletId;
  let newBalance;

  if (userErr) throw userErr;
  if (userWallet) {
    walletId = userWallet.id;
    newBalance = Number(userWallet.balance) + userNet;
    const { error: upd } = await supabase
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', walletId);
    if (upd) throw upd;
  } else {
    const { data: created, error: ins } = await supabase
      .from('wallets')
      .insert({ user_id: creditUserId, currency: code, balance: userNet })
      .select()
      .single();
    if (ins) throw ins;
    walletId = created.id;
    newBalance = userNet;
  }

  const treasuryNewBalance = Number(treasury.balance) - amountNum;
  if (treasuryNewBalance < 0) {
    await supabase
      .from('wallets')
      .update({ balance: newBalance - userNet, updated_at: new Date().toISOString() })
      .eq('id', walletId);
    throw new Error('Insufficient treasury (test env)');
  }

  await supabase
    .from('wallets')
    .update({ balance: treasuryNewBalance, updated_at: new Date().toISOString() })
    .eq('id', treasury.id);

  const txMeta = {
    currency: code,
    user_id: creditUserId,
    payer_user_id: creditUserId !== payerUserId ? payerUserId : undefined,
    ...metadata,
  };

  const { data: tx, error: txErr } = await supabase
    .from('transactions')
    .insert({
      from_wallet_id: treasury.id,
      to_wallet_id: walletId,
      amount: userNet,
      type: 'buy',
      metadata: txMeta
    })
    .select()
    .single();

  if (txErr) throw txErr;

  await recordBuySystemFee(code, systemFee, { fromWalletId: treasury.id, metadata: { user_id: payerUserId, ...metadata } });
  if (agentFee > 0) {
    await recordAgentCommission(payerUserId, code, amountNum, walletId);
  }
  if (superAgentFee > 0) {
    await recordSuperAgentCommission(payerUserId, code, amountNum, walletId);
  }
  if (superSuperAgentFee > 0) {
    await recordSuperSuperAgentCommission(payerUserId, code, amountNum, walletId);
  }

  return { transaction: tx, newBalance };
}

/** Buy crypto: get crypto amount from Coinbase (buy quote), then credit user wallet from treasury */
buySellRouter.post('/buy', async (req, res) => {
  try {
    const payerUserId = req.headers['x-user-id'];
    if (!payerUserId) return res.status(401).json({ error: 'Missing X-User-Id' });

    let creditUserId = payerUserId;
    let paymentLinkMeta = {};
    if (req.body.beneficiaryUserId || req.body.paymentLinkToken) {
      if (!req.body.beneficiaryUserId || !req.body.paymentLinkToken) {
        return res.status(400).json({ error: 'beneficiaryUserId and paymentLinkToken are both required for a payment link' });
      }
      try {
        const link = await assertValidPaymentLinkForAgent(req.body.paymentLinkToken, req.body.beneficiaryUserId);
        creditUserId = link.agent_user_id;
        paymentLinkMeta = { payment_link_id: link.id };
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    const { currency, amount, fiatAmount, instant_test: instantTest } = req.body;
    const code = (currency || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'currency required' });
    const supported = await isSupportedCrypto(code);
    if (!supported) return res.status(400).json({ error: `Unsupported currency: ${code}. Use a Coinbase-supported crypto (e.g. BTC, ETH, USDT).` });

    const fiatNum = fiatAmount != null ? Number(fiatAmount) : null;
    const cryptoAmountRaw = amount != null ? Number(amount) : null;
    if (instantTest && (cryptoAmountRaw > 0 || (fiatNum != null && fiatNum > 0))) {
      let amountNum = 0;
      if (cryptoAmountRaw > 0) {
        amountNum = cryptoAmountRaw;
      } else {
        const quote = await createBuyQuote({ fiatAmount: fiatNum, fiatCurrency: 'USD', cryptoAsset: code }).catch(() => ({}));
        amountNum = Number(quote.total_crypto ?? quote.crypto_amount ?? quote.estimated_crypto ?? 0);
        if (!amountNum || amountNum <= 0) {
          const priceUsd = await getSpotPriceUsd(code).catch(() => 0);
          amountNum = priceUsd > 0 ? fiatNum / priceUsd : 0;
        }
        if (!amountNum || amountNum <= 0) {
          return res.status(400).json({ error: 'Could not get crypto amount for instant test' });
        }
      }

      const flags = await getBuyCommissionFlags(payerUserId);
      const { userNet, systemFee, agentFee, superAgentFee, superSuperAgentFee } = computeBuySplit(amountNum, flags);

      const { data: userWallet, error: userErr } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', creditUserId)
        .eq('currency', code)
        .maybeSingle();
      if (userErr) throw userErr;

      const balanceBefore = userWallet != null ? Number(userWallet.balance) : 0;

      let walletId, newBalance;
      if (userWallet) {
        walletId = userWallet.id;
        newBalance = Number(userWallet.balance) + userNet;
        await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('id', walletId);
      } else {
        const { data: created, error: ins } = await supabase
          .from('wallets')
          .insert({ user_id: creditUserId, currency: code, balance: userNet })
          .select()
          .single();
        if (ins) throw ins;
        walletId = created.id;
        newBalance = userNet;
      }
      const { data: tx, error: txErr } = await supabase
        .from('transactions')
        .insert({
          from_wallet_id: null,
          to_wallet_id: walletId,
          amount: userNet,
          type: 'buy',
          metadata: {
            currency: code,
            user_id: creditUserId,
            payer_user_id: creditUserId !== payerUserId ? payerUserId : undefined,
            instant_test: true,
            ...paymentLinkMeta,
          }
        })
        .select()
        .single();
      if (txErr) throw txErr;

      await recordBuySystemFee(code, systemFee, { metadata: { user_id: payerUserId, instant_test: true } });
      if (agentFee > 0) {
        await recordAgentCommission(payerUserId, code, amountNum, walletId);
      }
      if (superAgentFee > 0) {
        await recordSuperAgentCommission(payerUserId, code, amountNum, walletId);
      }
      if (superSuperAgentFee > 0) {
        await recordSuperSuperAgentCommission(payerUserId, code, amountNum, walletId);
      }

      console.log('[instant-test] balance before', { creditUserId, payerUserId, currency: code, balance: balanceBefore });
      console.log('[instant-test] transaction', { id: tx?.id, wallet_id: walletId, amount: userNet, type: 'buy', currency: code });
      console.log('[instant-test] balance after', { creditUserId, currency: code, balance: newBalance });

      return res.status(201).json({
        success: true,
        transaction: tx,
        new_balance: newBalance,
      });
    }

    if (fiatAmount != null && Number(fiatAmount) > 0) {
      const result = await fulfillBuyFromFiat(payerUserId, code, Number(fiatAmount), paymentLinkMeta, { creditUserId });
      return res.status(201).json({ success: true, transaction: result.transaction, new_balance: result.newBalance });
    }

    const amountVal = Number(amount);
    if (isNaN(amountVal) || amountVal <= 0) {
      return res.status(400).json({ error: 'Provide amount (crypto) or fiatAmount (USD)' });
    }
    const amountNum = amountVal;

    const flags = await getBuyCommissionFlags(payerUserId);
    const { userNet, systemFee, agentFee, superAgentFee, superSuperAgentFee } = computeBuySplit(amountNum, flags);

    const treasury = await getOrCreateTreasuryWallet(code);

    const { data: userWallet, error: userErr } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', creditUserId)
      .eq('currency', code)
      .maybeSingle();

    let walletId;
    let newBalance;

    if (userErr) throw userErr;
    if (userWallet) {
      walletId = userWallet.id;
      newBalance = Number(userWallet.balance) + userNet;
      const { error: upd } = await supabase
        .from('wallets')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('id', walletId);
      if (upd) throw upd;
    } else {
      const { data: created, error: ins } = await supabase
        .from('wallets')
        .insert({ user_id: creditUserId, currency: code, balance: userNet })
        .select()
        .single();
      if (ins) throw ins;
      walletId = created.id;
      newBalance = userNet;
    }

    const treasuryNewBalance = Number(treasury.balance) - amountNum;
    if (treasuryNewBalance < 0) {
      await supabase
        .from('wallets')
        .update({ balance: newBalance - userNet, updated_at: new Date().toISOString() })
        .eq('id', walletId);
      return res.status(400).json({ error: 'Insufficient treasury (test env)' });
    }

    await supabase
      .from('wallets')
      .update({ balance: treasuryNewBalance, updated_at: new Date().toISOString() })
      .eq('id', treasury.id);

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .insert({
        from_wallet_id: treasury.id,
        to_wallet_id: walletId,
        amount: userNet,
        type: 'buy',
        metadata: {
          currency: code,
          user_id: creditUserId,
          payer_user_id: creditUserId !== payerUserId ? payerUserId : undefined,
          ...paymentLinkMeta,
        }
      })
      .select()
      .single();

    if (txErr) throw txErr;

    await recordBuySystemFee(code, systemFee, { fromWalletId: treasury.id, metadata: { source: 'buy', user_id: payerUserId } });
    if (agentFee > 0) {
      await recordAgentCommission(payerUserId, code, amountNum, walletId);
    }
    if (superAgentFee > 0) {
      await recordSuperAgentCommission(payerUserId, code, amountNum, walletId);
    }
    if (superSuperAgentFee > 0) {
      await recordSuperSuperAgentCommission(payerUserId, code, amountNum, walletId);
    }

    res.status(201).json({ success: true, transaction: tx, new_balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Sell crypto (test env: debit user wallet, credit treasury) */
buySellRouter.post('/sell', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { walletId, amount } = req.body;
    if (!walletId || !amount) {
      return res.status(400).json({ error: 'walletId and amount required' });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const { data: userWallet, error: userErr } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .eq('user_id', userId)
      .single();

    if (userErr || !userWallet) {
      return res.status(404).json({ error: 'Wallet not found or not yours' });
    }

    if (userWallet.user_id === SYSTEM_USER_ID) {
      return res.status(400).json({ error: 'Cannot sell from treasury' });
    }

    const balance = Number(userWallet.balance);
    if (balance < amountNum) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const treasury = await getOrCreateTreasuryWallet(userWallet.currency);
    const { netAmount, feeAmount } = applyFee(amountNum);

    const newUserBalance = balance - amountNum;
    const newTreasuryBalance = Number(treasury.balance) + netAmount;

    const { error: updUser } = await supabase
      .from('wallets')
      .update({ balance: newUserBalance, updated_at: new Date().toISOString() })
      .eq('id', walletId);

    if (updUser) throw updUser;

    const { error: updTreasury } = await supabase
      .from('wallets')
      .update({ balance: newTreasuryBalance, updated_at: new Date().toISOString() })
      .eq('id', treasury.id);

    if (updTreasury) throw updTreasury;

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .insert({
        from_wallet_id: walletId,
        to_wallet_id: treasury.id,
        amount: netAmount,
        type: 'sell',
        metadata: { currency: userWallet.currency, user_id: userId }
      })
      .select()
      .single();

    if (txErr) throw txErr;

    if (feeAmount > 0) {
      await recordFee(userWallet.currency, feeAmount, { fromWalletId: walletId, metadata: { source: 'sell', user_id: userId } });
    }

    res.status(201).json({ success: true, transaction: tx, new_balance: newUserBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
