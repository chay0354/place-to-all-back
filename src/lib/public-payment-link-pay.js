import { supabase } from '../db.js';
import { computeBuySplit, recordBuySystemFee } from './fee.js';
import { isSupportedCrypto } from './coinbase.js';
import { getActivePaymentLinkByToken, deactivatePaymentLinkById } from './payment-link.js';

/** Anonymous payers have no profile — only platform admin fee + recipient net. */
const GUEST_FLAGS = { hasAffiliate: false, hasSuperUpline: false, hasSuperSuperUpline: false };

/**
 * Simulated ledger pay for a payment link; no auth. Deactivates the link after success.
 * @param {string} rawToken
 * @param {{ amount?: number }} body - required only when the link has no fixed amount
 */
export async function simulatePublicPaymentLinkPay(rawToken, body = {}) {
  const token = String(rawToken || '').trim();
  if (!token) throw new Error('Invalid payment link');

  const link = await getActivePaymentLinkByToken(token);
  if (!link) throw new Error('Invalid or expired payment link');

  const code = String(link.currency || '').toUpperCase();
  if (!code) throw new Error('Invalid link currency');

  const supported = await isSupportedCrypto(code);
  if (!supported) throw new Error(`Unsupported currency: ${code}`);

  const stored = link.amount != null ? Number(link.amount) : 0;
  const hasFixedAmount = stored > 0 && !Number.isNaN(stored);
  let amountNum = hasFixedAmount ? stored : Number(body.amount);
  if (!amountNum || amountNum <= 0 || Number.isNaN(amountNum)) {
    throw new Error('This link requires a valid amount');
  }
  if (hasFixedAmount && Math.abs(amountNum - stored) > 1e-12) {
    throw new Error('Amount does not match this payment link');
  }

  const creditUserId = link.agent_user_id;
  const { userNet, systemFee } = computeBuySplit(amountNum, GUEST_FLAGS);

  const { data: userWallet, error: userErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', creditUserId)
    .eq('currency', code)
    .maybeSingle();
  if (userErr) throw userErr;

  let walletId;
  let newBalance;
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
        guest_payment_link: true,
        payment_link_id: link.id,
        instant_test: true,
      },
    })
    .select()
    .single();
  if (txErr) throw txErr;

  await recordBuySystemFee(code, systemFee, {
    metadata: { guest_payment_link: true, payment_link_id: link.id, instant_test: true },
  });

  await deactivatePaymentLinkById(link.id);

  return { success: true, transaction: tx, new_balance: newBalance };
}
