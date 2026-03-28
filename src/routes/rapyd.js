import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../db.js';
import { createCheckout, verifyWebhookSignature, getRapydConfig } from '../lib/rapyd.js';
import { fulfillBuyFromFiat } from './buy-sell.js';
import { isSupportedCrypto } from '../lib/coinbase.js';
import { assertValidPaymentLinkForAgent } from '../lib/payment-link.js';

export const rapydRouter = Router();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

/** Webhook handler: expects req.body to be raw Buffer (use express.raw for this route). Export for mounting before express.json(). */
export async function rapydWebhookHandler(req, res) {
  const rawBody = (req.body && Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
  const bodyString = rawBody.replace(/\s+(?=([^"]*"[^"]*")*[^"]*$)/g, '') || '{}';

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  if (payload.type !== 'PAYMENT_SUCCEEDED') {
    return res.status(200).send('OK');
  }

  const paymentId = payload?.data?.id;
  if (!paymentId) return res.status(200).send('OK');

  const webhookUrl = process.env.RAPYD_WEBHOOK_URL || '';
  const salt = req.headers['salt'] || '';
  const timestamp = req.headers['timestamp'] || '';
  const signature = req.headers['signature'] || '';
  const ok = verifyWebhookSignature(webhookUrl, salt, timestamp, bodyString, signature);
  if (!ok && webhookUrl) {
    return res.status(401).send('Invalid signature');
  }

  const { data: existing } = await supabase.from('processed_rapyd_payments').select('rapyd_payment_id').eq('rapyd_payment_id', paymentId).maybeSingle();
  if (existing) return res.status(200).send('OK');

  const merchantRef = payload?.data?.merchant_reference_id || '';
  if (!merchantRef) {
    console.warn('[Rapyd] webhook missing merchant_reference_id', paymentId);
    return res.status(200).send('OK');
  }

  const { data: checkout, error: checkoutErr } = await supabase.from('rapyd_checkouts').select('*').eq('id', merchantRef).maybeSingle();
  if (checkoutErr || !checkout || checkout.status !== 'pending') {
    return res.status(200).send('OK');
  }

  await supabase.from('processed_rapyd_payments').insert({ rapyd_payment_id: paymentId });
  await supabase.from('rapyd_checkouts').update({ status: 'completed' }).eq('id', checkout.id);

  try {
    const creditUserId = checkout.beneficiary_user_id || checkout.user_id;
    const opts = creditUserId !== checkout.user_id ? { creditUserId } : {};
    await fulfillBuyFromFiat(
      checkout.user_id,
      checkout.currency,
      Number(checkout.fiat_amount),
      { source: 'rapyd', rapyd_payment_id: paymentId },
      opts
    );
  } catch (e) {
    console.error('[Rapyd] fulfillBuyFromFiat failed', e);
    await supabase.from('rapyd_checkouts').update({ status: 'failed' }).eq('id', checkout.id);
  }

  return res.status(200).send('OK');
}

/** POST /api/rapyd/checkout — create Rapyd checkout, store row, return redirect URL */
rapydRouter.post('/checkout', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { accessKey, secretKey } = getRapydConfig();
    if (!accessKey || !secretKey) return res.status(503).json({ error: 'Rapyd not configured (RAPYD_ACCESS_KEY, RAPYD_SECRET_KEY)' });

    const { currency, cryptoAmount, fiatAmount, fiatCurrency = 'USD', beneficiaryUserId, paymentLinkToken } = req.body;
    const code = (currency || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'currency required' });
    const supported = await isSupportedCrypto(code);
    if (!supported) return res.status(400).json({ error: `Unsupported currency: ${code}` });

    let fiatNum = Number(fiatAmount);
    if (!(fiatNum > 0) && cryptoAmount != null && Number(cryptoAmount) > 0) {
      const { createBuyQuote, getSpotPriceUsd } = await import('../lib/coinbase.js');
      try {
        const quote = await createBuyQuote({ fiatAmount: 1, fiatCurrency: 'USD', cryptoAsset: code });
        const cryptoPerUsd = 1 / (Number(quote.total_crypto ?? quote.crypto_amount ?? quote.estimated_crypto) || 1);
        fiatNum = Number(cryptoAmount) / cryptoPerUsd;
      } catch {
        const priceUsd = await getSpotPriceUsd(code);
        fiatNum = Number(cryptoAmount) * priceUsd;
      }
    }
    if (!(fiatNum > 0)) return res.status(400).json({ error: 'Provide fiatAmount (USD) or cryptoAmount' });

    let beneficiary_user_id = null;
    let payment_link_token = null;
    if (beneficiaryUserId || paymentLinkToken) {
      if (!beneficiaryUserId || !paymentLinkToken) {
        return res.status(400).json({ error: 'beneficiaryUserId and paymentLinkToken are both required for payment-link checkout' });
      }
      try {
        const link = await assertValidPaymentLinkForAgent(paymentLinkToken, beneficiaryUserId);
        beneficiary_user_id = link.agent_user_id;
        payment_link_token = paymentLinkToken;
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    const checkoutId = crypto.randomUUID();
    const completeUrl = `${FRONTEND_ORIGIN}/dashboard/buy?rapyd=success&checkout_id=${checkoutId}`;
    const errorUrl = `${FRONTEND_ORIGIN}/dashboard/buy?rapyd=error`;

    const { id: rapydCheckoutId, redirect_url } = await createCheckout({
      amount: Math.round(fiatNum * 100) / 100,
      currency: fiatCurrency,
      complete_payment_url: completeUrl,
      error_payment_url: errorUrl,
      merchant_reference_id: checkoutId,
      country: 'IL',
    });

    if (!rapydCheckoutId) return res.status(502).json({ error: 'Rapyd did not return checkout id' });

    const cryptoAmountNum = 0; // We'll determine at fulfillment from fiat + quote
    const { error: insertErr } = await supabase.from('rapyd_checkouts').insert({
      id: checkoutId,
      rapyd_checkout_id: rapydCheckoutId,
      user_id: userId,
      currency: code,
      crypto_amount: cryptoAmountNum,
      fiat_amount: fiatNum,
      fiat_currency: fiatCurrency,
      status: 'pending',
      beneficiary_user_id,
      payment_link_token,
    });

    if (insertErr) throw insertErr;

    res.status(201).json({ redirect_url: redirect_url || null, checkout_id: checkoutId });
  } catch (e) {
    const payload = { error: e.message };
    if (e.rapyd) payload.rapyd = e.rapyd;
    res.status(500).json(payload);
  }
});