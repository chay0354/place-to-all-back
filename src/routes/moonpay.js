/**
 * MoonPay: get signed buy URL and webhook to credit user ledger when payment completes.
 */

import crypto from 'crypto';
import { Router } from 'express';
import { getSignedMoonPayUrl, isEvmCurrency } from '../lib/moonpay.js';
import { applyFee, recordFee } from '../lib/fee.js';
import { splitAndSendEth } from '../lib/send-eth.js';
import { supabase } from '../db.js';

const platformReceivesMoonPay = () =>
  process.env.PLATFORM_RECEIVES_MOONPAY === 'true' || process.env.PLATFORM_RECEIVES_MOONPAY === '1';

export const moonpayRouter = Router();

/** Verify MoonPay webhook signature (Moonpay-Signature-V2: t=timestamp,s=signature). */
function verifyMoonPaySignature(payload, signatureHeader, secret) {
  try {
    if (!secret || !signatureHeader) return false;
    const parts = signatureHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.trim().split('=');
      if (k && v) acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts.t;
    const sig = parts.s;
    if (!timestamp || !sig) return false;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const message = body + '.' + timestamp;
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    return false;
  }
}

/**
 * GET /api/moonpay/url?currencyCode=eth&baseCurrencyCode=usd&baseCurrencyAmount=50
 * Returns signed MoonPay widget URL. Crypto is always sent to the wallet associated with your account (we only support ETH, USDT, USDC, etc.).
 */
moonpayRouter.get('/url', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const currencyCode = (req.query.currencyCode || req.query.currency || 'eth').toString().toLowerCase();

    if (!isEvmCurrency(currencyCode)) {
      return res.status(400).json({
        error: 'Buy with MoonPay only supports currencies that go to your account wallet (e.g. ETH, USDT, USDC). Choose one of these so the crypto is sent to your wallet.',
      });
    }

    const { data: row } = await supabase
      .from('coinbase_wallets')
      .select('wallet_id, default_address, delivery_address')
      .eq('user_id', userId)
      .maybeSingle();

    const userAddress = row?.delivery_address || row?.default_address || row?.wallet_id;
    if (!userAddress || !String(userAddress).startsWith('0x')) {
      return res.status(400).json({
        error: 'No wallet address. Create a wallet first (e.g. visit dashboard or POST /api/coinbase/wallet).',
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = `${frontendUrl.replace(/\/+$/, '')}/dashboard?moonpay=success`;

    const baseCurrencyAmount = req.query.baseCurrencyAmount != null ? Number(req.query.baseCurrencyAmount) : null;

    const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
    const walletAddress =
      platformReceivesMoonPay() && platformWallet && String(platformWallet).startsWith('0x') ? platformWallet : userAddress;

    const url = getSignedMoonPayUrl({
      walletAddress,
      currencyCode: (req.query.currencyCode || req.query.currency || 'eth').toString().toLowerCase(),
      baseCurrencyCode: (req.query.baseCurrencyCode || 'usd').toString().toLowerCase(),
      ...(baseCurrencyAmount > 0 && { baseCurrencyAmount }),
      redirectUrl,
      externalCustomerId: userId,
    });

    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/moonpay/webhook
 * MoonPay calls this when a buy transaction is updated. When status is "completed", we credit the user's ledger
 * so the dashboard portfolio shows the balance. Configure this URL in MoonPay Dashboard > Webhooks.
 */
moonpayRouter.post('/webhook', async (req, res) => {
  try {
    const { type, data, externalCustomerId } = req.body || {};
    const userId = externalCustomerId || data?.externalCustomerId;
    if (!userId) {
      return res.status(400).json({ error: 'Missing externalCustomerId' });
    }

    const webhookKey = process.env.MOONPAY_WEBHOOK_KEY;
    const sigHeader = req.headers['moonpay-signature-v2'] || req.headers['moonpay-signature'];
    if (webhookKey && sigHeader) {
      const raw = req.rawBody ?? JSON.stringify(req.body);
      if (!verifyMoonPaySignature(raw, sigHeader, webhookKey)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    if (type !== 'transaction_updated' && type !== 'transaction_created') {
      return res.status(200).json({ received: true });
    }

    if (data?.status !== 'completed') {
      return res.status(200).json({ received: true });
    }

    const rawCode = (data?.currency?.code || '').toUpperCase();
    const currencyCode = rawCode.replace(/_BASE$/, '') || rawCode;
    const amount = Number(data?.quoteCurrencyAmount);
    const moonpayTxId = data?.id;

    if (!currencyCode || !(amount > 0) || !moonpayTxId) {
      return res.status(400).json({ error: 'Missing currency, amount, or transaction id' });
    }

    const { data: dupRows } = await supabase
      .from('transactions')
      .select('id')
      .eq('type', 'buy')
      .contains('metadata', { moonpay_transaction_id: moonpayTxId })
      .limit(1);

    if (dupRows?.length > 0) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    const useMoonPayEcosystemFee = process.env.MOONPAY_USE_ECOSYSTEM_FEE === 'true' || process.env.MOONPAY_USE_ECOSYSTEM_FEE === '1';
    const { netAmount, feeAmount } = useMoonPayEcosystemFee ? { netAmount: amount, feeAmount: 0 } : applyFee(amount);

    const feeCollectionAddress = process.env.FEE_COLLECTION_ADDRESS;
    const isEth = (currencyCode || '').toUpperCase() === 'ETH';
    if (platformReceivesMoonPay() && isEth && feeCollectionAddress && String(feeCollectionAddress).startsWith('0x')) {
      const { data: coinbaseRow } = await supabase
        .from('coinbase_wallets')
        .select('delivery_address, default_address, wallet_id')
        .eq('user_id', userId)
        .maybeSingle();
      const userAddress = coinbaseRow?.delivery_address || coinbaseRow?.default_address || coinbaseRow?.wallet_id;
      if (userAddress && String(userAddress).startsWith('0x')) {
        const sendResult = await splitAndSendEth(userAddress, feeCollectionAddress, amount);
        if (!sendResult.ok) {
          console.error('[MoonPay webhook] On-chain split failed for', moonpayTxId, '- crediting ledger only; check platform wallet balance');
        }
      }
    }

    const { data: userWallet, error: walletErr } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('currency', currencyCode)
      .maybeSingle();

    let walletId;
    let newBalance;

    if (walletErr) throw walletErr;
    if (userWallet) {
      walletId = userWallet.id;
      newBalance = Number(userWallet.balance) + netAmount;
      const { error: upd } = await supabase
        .from('wallets')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('id', walletId);
      if (upd) throw upd;
    } else {
      const { data: created, error: ins } = await supabase
        .from('wallets')
        .insert({ user_id: userId, currency: currencyCode, balance: netAmount })
        .select()
        .single();
      if (ins) throw ins;
      walletId = created.id;
      newBalance = netAmount;
    }

    await supabase.from('transactions').insert({
      from_wallet_id: null,
      to_wallet_id: walletId,
      amount: netAmount,
      type: 'buy',
      metadata: { moonpay_transaction_id: moonpayTxId, source: 'moonpay' },
    });

    if (feeAmount > 0) {
      await recordFee(currencyCode, feeAmount, { metadata: { source: 'moonpay', moonpay_transaction_id: moonpayTxId } });
    }

    console.log('[MoonPay webhook] Credited', netAmount, currencyCode, feeAmount ? `(fee ${feeAmount})` : '', 'for user', userId);
    res.status(200).json({ received: true, credited: true });
  } catch (e) {
    console.error('[MoonPay webhook]', e);
    res.status(500).json({ error: e.message });
  }
});
