import { Router } from 'express';
import { supabase } from '../db.js';
import { getSpotPriceUsd } from '../lib/coinbase.js';

export const cardsRouter = Router();

function uid() {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function maskPan(last4) {
  return `**** **** **** ${String(last4 || '').padStart(4, '0')}`;
}

async function getCardRow(userId) {
  const { data, error } = await supabase
    .from('user_cards')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function addEvent(userId, cardId, eventType, amountUsdt, metadata = {}) {
  const { error } = await supabase.from('card_events').insert({
    user_id: userId,
    user_card_id: cardId,
    event_type: eventType,
    amount_usdt: amountUsdt,
    metadata,
  });
  if (error) throw new Error(error.message);
}

function serializeCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    user_id: card.user_id,
    status: card.status,
    card_brand: card.card_brand,
    card_network: card.card_network,
    card_type: card.card_type,
    card_last4: card.card_last4,
    card_masked: maskPan(card.card_last4),
    available_balance_usdt: toNum(card.available_balance_usdt),
    lifetime_funded_usdt: toNum(card.lifetime_funded_usdt),
    reap_customer_id: card.reap_customer_id,
    reap_card_id: card.reap_card_id,
    apple_pay_enabled: Boolean(card.apple_pay_enabled),
    google_pay_enabled: Boolean(card.google_pay_enabled),
    apple_pay_provisioned: Boolean(card.apple_pay_provisioned),
    google_pay_provisioned: Boolean(card.google_pay_provisioned),
    created_at: card.created_at,
    updated_at: card.updated_at,
  };
}

cardsRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const card = await getCardRow(userId);
    let recentEvents = [];
    if (card?.id) {
      const { data, error } = await supabase
        .from('card_events')
        .select('id, event_type, amount_usdt, metadata, created_at')
        .eq('user_card_id', card.id)
        .order('created_at', { ascending: false })
        .limit(12);
      if (error) throw new Error(error.message);
      recentEvents = data || [];
    }
    res.json({
      card: serializeCard(card),
      recentEvents,
      program: {
        auto_convert_to_usdt: true,
        card_issuer: 'Reap',
        tokenization: ['Apple Pay', 'Google Pay'],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cardsRouter.post('/issue', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const existing = await getCardRow(userId);
    if (existing) return res.json({ card: serializeCard(existing), alreadyIssued: true });

    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    const payload = {
      user_id: userId,
      status: 'active',
      card_brand: 'Place to All',
      card_network: 'VISA',
      card_type: 'virtual',
      card_last4: last4,
      available_balance_usdt: 0,
      lifetime_funded_usdt: 0,
      reap_customer_id: `reap_customer_${uid()}`,
      reap_card_id: `reap_card_${uid()}`,
      apple_pay_enabled: true,
      google_pay_enabled: true,
      apple_pay_provisioned: false,
      google_pay_provisioned: false,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('user_cards').insert(payload).select('*').single();
    if (error) throw new Error(error.message);
    await addEvent(userId, data.id, 'issue', 0, { source: 'app', provider: 'reap' });
    res.status(201).json({ card: serializeCard(data), issued: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cardsRouter.post('/apple-pay/add', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const card = await getCardRow(userId);
    if (!card) return res.status(400).json({ error: 'Issue a card first' });
    if (!card.apple_pay_enabled) return res.status(400).json({ error: 'Apple Pay is not enabled for this card' });

    const { data: updatedCard, error } = await supabase
      .from('user_cards')
      .update({
        apple_pay_provisioned: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', card.id)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    await addEvent(userId, card.id, 'webhook', 0, {
      source: 'app',
      event: 'apple_pay_provisioned',
    });

    res.json({
      ok: true,
      card: serializeCard(updatedCard),
      applePay: {
        status: 'provisioned',
        message: 'Card is now added to Apple Pay in system state.',
        wallet_deeplink_url: 'shoebox://',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cardsRouter.post('/fund', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const amount = toNum(req.body?.amount);
    const currency = String(req.body?.currency || 'USDT').toUpperCase().trim();
    if (!(amount > 0)) return res.status(400).json({ error: 'amount must be greater than 0' });

    let card = await getCardRow(userId);
    if (!card) return res.status(400).json({ error: 'Issue a card first' });

    const { data: wallet, error: walletErr } = await supabase
      .from('wallets')
      .select('id, balance, currency')
      .eq('user_id', userId)
      .eq('currency', currency)
      .maybeSingle();
    if (walletErr) throw new Error(walletErr.message);
    if (!wallet) return res.status(400).json({ error: `No ${currency} wallet found` });
    if (toNum(wallet.balance) < amount) return res.status(400).json({ error: `Insufficient ${currency} balance` });

    let usdtAmount = amount;
    if (currency !== 'USDT') {
      const priceUsd = await getSpotPriceUsd(currency);
      usdtAmount = amount * toNum(priceUsd);
      if (!(usdtAmount > 0)) return res.status(400).json({ error: `Could not price ${currency}` });
    }

    const walletNewBalance = toNum(wallet.balance) - amount;
    const { error: walletUpdateErr } = await supabase
      .from('wallets')
      .update({ balance: walletNewBalance, updated_at: new Date().toISOString() })
      .eq('id', wallet.id)
      .eq('user_id', userId);
    if (walletUpdateErr) throw new Error(walletUpdateErr.message);

    const cardBalanceNew = toNum(card.available_balance_usdt) + usdtAmount;
    const lifetimeFundedNew = toNum(card.lifetime_funded_usdt) + usdtAmount;
    const { data: updatedCard, error: cardErr } = await supabase
      .from('user_cards')
      .update({
        available_balance_usdt: cardBalanceNew,
        lifetime_funded_usdt: lifetimeFundedNew,
        updated_at: new Date().toISOString(),
      })
      .eq('id', card.id)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (cardErr) throw new Error(cardErr.message);

    await addEvent(userId, card.id, 'fund', usdtAmount, {
      source_currency: currency,
      source_amount: amount,
      converted_to_usdt: usdtAmount,
      source_wallet_id: wallet.id,
    });

    card = updatedCard;
    res.json({
      ok: true,
      card: serializeCard(card),
      funding: {
        source_currency: currency,
        source_amount: amount,
        credited_usdt: usdtAmount,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cardsRouter.post('/webhook/reap', async (req, res) => {
  try {
    const secret = process.env.REAP_WEBHOOK_SECRET || '';
    if (secret) {
      const signature = String(req.headers['x-reap-signature'] || '');
      if (signature !== secret) return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const reapCardId = String(req.body?.reap_card_id || '').trim();
    const amountUsdt = toNum(req.body?.amount_usdt);
    const eventType = String(req.body?.event_type || 'spend').toLowerCase();
    const status = String(req.body?.status || 'confirmed').toLowerCase();
    if (!reapCardId) return res.status(400).json({ error: 'reap_card_id required' });
    if (!(amountUsdt > 0)) return res.status(400).json({ error: 'amount_usdt must be greater than 0' });

    const { data: card, error: cardFindErr } = await supabase
      .from('user_cards')
      .select('*')
      .eq('reap_card_id', reapCardId)
      .maybeSingle();
    if (cardFindErr) throw new Error(cardFindErr.message);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    if (eventType === 'spend' && status === 'confirmed') {
      const nextBalance = toNum(card.available_balance_usdt) - amountUsdt;
      if (nextBalance < 0) return res.status(409).json({ error: 'Insufficient card balance' });
      const { error: updateErr } = await supabase
        .from('user_cards')
        .update({ available_balance_usdt: nextBalance, updated_at: new Date().toISOString() })
        .eq('id', card.id);
      if (updateErr) throw new Error(updateErr.message);
      await addEvent(card.user_id, card.id, 'spend', amountUsdt, {
        webhook: true,
        merchant: req.body?.merchant || null,
        txn_id: req.body?.txn_id || null,
        status,
      });
    } else if (eventType === 'refund' && status === 'confirmed') {
      const nextBalance = toNum(card.available_balance_usdt) + amountUsdt;
      const { error: updateErr } = await supabase
        .from('user_cards')
        .update({ available_balance_usdt: nextBalance, updated_at: new Date().toISOString() })
        .eq('id', card.id);
      if (updateErr) throw new Error(updateErr.message);
      await addEvent(card.user_id, card.id, 'refund', amountUsdt, {
        webhook: true,
        merchant: req.body?.merchant || null,
        txn_id: req.body?.txn_id || null,
        status,
      });
    } else {
      await addEvent(card.user_id, card.id, 'webhook', amountUsdt, {
        event_type: eventType,
        status,
        payload: req.body || {},
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

