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
  if (!last4) return null;
  return `**** **** **** ${String(last4).padStart(4, '0')}`;
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

function reapBaseUrl() {
  return (process.env.REAP_BASE_URL || 'https://sandbox.api.caas.reap.global').replace(/\/+$/, '');
}

function reapApiVersion() {
  return process.env.REAP_API_VERSION || 'v2.0';
}

function reapApiKey() {
  return process.env.REAP_API_KEY || '';
}

function isReapConfigured() {
  return Boolean(reapApiKey());
}

function normalizeCardStatus(status, fallback = 'active') {
  const v = String(status || '').toLowerCase();
  if (v === 'active') return 'active';
  if (v) return 'inactive';
  return fallback;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function reapRequest(path, { method = 'GET', body } = {}) {
  if (!isReapConfigured()) {
    throw new Error('REAP_API_KEY is missing. Add it in back/.env to enable real card issuing.');
  }
  const url = `${reapBaseUrl()}${path}`;
  const headers = {
    accept: 'application/json',
    'Accept-Version': reapApiVersion(),
    'x-reap-api-key': reapApiKey(),
  };
  if (body != null) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || data?.code || `Reap API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function buildReapCreatePayload(userId) {
  const country = process.env.REAP_SANDBOX_COUNTRY || 'HKG';
  const city = process.env.REAP_SANDBOX_CITY || 'Hong Kong';
  const line1 = process.env.REAP_SANDBOX_ADDR_LINE1 || 'Flat A on 1/F';
  const line2 = process.env.REAP_SANDBOX_ADDR_LINE2 || '123 Penny Lane';
  const postalCode = process.env.REAP_SANDBOX_POSTAL_CODE || undefined;
  const businessName = process.env.REAP_SANDBOX_BUSINESS_NAME || 'Place To All Limited';
  const businessRegistrationNumber = process.env.REAP_SANDBOX_BUSINESS_REG_NO || 'ABC123456';
  const preferredCardName = (process.env.REAP_SANDBOX_CARD_NAME || businessName).toUpperCase().slice(0, 27);
  const dialCode = process.env.REAP_OTP_DIAL_CODE || '852';
  const phoneNumber = process.env.REAP_OTP_PHONE || '95123456';
  const spendLimit = toNum(process.env.REAP_SANDBOX_SPEND_LIMIT || 1000);
  const address = {
    line1,
    line2,
    country,
    city,
  };
  if (postalCode) address.postalCode = postalCode;

  return {
    cardType: 'Virtual',
    spendLimit: spendLimit > 0 ? spendLimit : 1000,
    customerType: 'Business',
    kyc: {
      fullName: businessName,
      entityType: 'Company',
      registeredAddress: address,
      businessName,
      businessRegistrationNumber,
      businessOperationAddress: address,
    },
    preferredCardName,
    meta: {
      id: String(userId),
      otpPhoneNumber: {
        dialCode: String(dialCode),
        phoneNumber: String(phoneNumber),
      },
    },
  };
}

function serializeCard(card, live = {}) {
  if (!card) return null;
  const last4 = live.reap_last4 || card.card_last4 || null;
  return {
    id: card.id,
    user_id: card.user_id,
    status: live.reap_status || card.status,
    card_brand: card.card_brand,
    card_network: card.card_network,
    card_type: card.card_type,
    card_last4: last4,
    card_masked: maskPan(last4),
    available_balance_usdt: toNum(card.available_balance_usdt),
    lifetime_funded_usdt: toNum(card.lifetime_funded_usdt),
    reap_customer_id: card.reap_customer_id,
    reap_card_id: live.reap_card_id || card.reap_card_id,
    reap_card_name: live.reap_card_name || null,
    reap_available_credit: live.reap_available_credit ?? null,
    reap_card_design_id: live.reap_card_design_id || null,
    reap_card_design_name: live.reap_card_design_name || null,
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
    let live = {};
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
    if (card?.reap_card_id && isReapConfigured()) {
      try {
        let resolvedReapCardId = card.reap_card_id;
        let summary = await reapRequest(`/cards/${encodeURIComponent(resolvedReapCardId)}`, { method: 'GET' }).catch(async () => {
          // Old local mock ids cannot be fetched from Reap. Resolve the real card id by matching user/meta or last4.
          const list = await reapRequest('/cards', { method: 'GET' });
          const items = Array.isArray(list?.items) ? list.items : [];
          const byMetaId = items.find((item) => String(item?.meta?.id || '') === String(userId));
          const byLast4 = items.find((item) => String(item?.last4 || '') === String(card.card_last4 || ''));
          const matched = byMetaId || byLast4 || null;
          if (matched?.id) {
            resolvedReapCardId = matched.id;
            return reapRequest(`/cards/${encodeURIComponent(resolvedReapCardId)}`, { method: 'GET' });
          }
          // If this is a legacy local id, issue a real Reap card now so UI can show real design.
          if (!looksLikeUuid(card.reap_card_id)) {
            const createPayload = buildReapCreatePayload(userId);
            const created = await reapRequest('/cards', { method: 'POST', body: createPayload });
            if (!created?.id) return null;
            resolvedReapCardId = created.id;
            return reapRequest(`/cards/${encodeURIComponent(resolvedReapCardId)}`, { method: 'GET' });
          }
          return null;
        });
        if (!summary) throw new Error('Unable to resolve card in Reap');
        let design = null;
        if (summary?.cardDesign) {
          design = await reapRequest(`/card-design/${encodeURIComponent(summary.cardDesign)}`, { method: 'GET' }).catch(() => null);
        }
        live = {
          reap_card_id: resolvedReapCardId,
          reap_status: normalizeCardStatus(summary?.status, card.status),
          reap_last4: summary?.last4 || card.card_last4 || null,
          reap_card_name: summary?.cardName || null,
          reap_available_credit: summary?.availableCredit != null ? toNum(summary.availableCredit) : null,
          reap_card_design_id: summary?.cardDesign || null,
          reap_card_design_name: design?.name || null,
        };
        if (
          resolvedReapCardId !== card.reap_card_id ||
          live.reap_last4 !== card.card_last4 ||
          live.reap_status !== card.status
        ) {
          await supabase
            .from('user_cards')
            .update({
              reap_card_id: resolvedReapCardId,
              card_last4: live.reap_last4,
              status: live.reap_status,
              updated_at: new Date().toISOString(),
            })
            .eq('id', card.id);
        }
      } catch (e) {
        live = { reap_card_name: null };
      }
    }
    res.json({
      card: serializeCard(card, live),
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

    let reapCardId = null;
    let reapLast4 = null;
    let reapStatus = 'active';

    if (isReapConfigured()) {
      const createPayload = buildReapCreatePayload(userId);
      const created = await reapRequest('/cards', { method: 'POST', body: createPayload });
      reapCardId = created?.id || null;
      if (!reapCardId) throw new Error('Reap create card succeeded but did not return card id');
      const summary = await reapRequest(`/cards/${encodeURIComponent(reapCardId)}`, { method: 'GET' });
      reapLast4 = summary?.last4 || null;
      reapStatus = String(summary?.status || 'ACTIVE').toLowerCase() === 'active' ? 'active' : 'inactive';
    } else {
      reapCardId = `local_${uid()}`;
      reapLast4 = String(Math.floor(1000 + Math.random() * 9000));
      reapStatus = 'active';
    }

    const payload = {
      user_id: userId,
      status: reapStatus,
      card_brand: 'Place to All',
      card_network: 'VISA',
      card_type: 'virtual',
      card_last4: reapLast4,
      available_balance_usdt: 0,
      lifetime_funded_usdt: 0,
      reap_customer_id: null,
      reap_card_id: reapCardId,
      apple_pay_enabled: true,
      google_pay_enabled: true,
      apple_pay_provisioned: false,
      google_pay_provisioned: false,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('user_cards').insert(payload).select('*').single();
    if (error) throw new Error(error.message);
    await addEvent(userId, data.id, 'issue', 0, {
      source: 'app',
      provider: isReapConfigured() ? 'reap_sandbox' : 'local',
      reap_card_id: reapCardId,
    });
    res.status(201).json({ card: serializeCard(data), issued: true });
  } catch (e) {
    res.status(e.status && Number.isFinite(e.status) ? e.status : 500).json({
      error: e.message,
      detail: e?.payload || null,
    });
  }
});

cardsRouter.post('/apple-pay/add', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    const card = await getCardRow(userId);
    if (!card) return res.status(400).json({ error: 'Issue a card first' });
    if (!card.apple_pay_enabled) return res.status(400).json({ error: 'Apple Pay is not enabled for this card' });

    const hasIosProvisionPayload =
      req.body &&
      typeof req.body === 'object' &&
      req.body.leafCertificate &&
      req.body.nonce &&
      req.body.nonceSignature &&
      Array.isArray(req.body.additionalCertificates);

    if (!hasIosProvisionPayload) {
      return res.status(400).json({
        error:
          'Apple Pay push provisioning requires iOS PassKit payload (leafCertificate, additionalCertificates, nonce, nonceSignature) from a native app.',
      });
    }

    return res.status(501).json({
      error:
        'Apple Pay push provisioning endpoint is not configured for this Reap program yet. Contact Reap to enable Mobile App Push Provisioning for your account.',
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

