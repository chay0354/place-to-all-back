import { Router } from 'express';
import { supabase } from '../db.js';
import { hashSecurityPin, isValidSecurityPin, verifySecurityPin } from '../lib/security-pin.js';
import { checkPhoneVerificationCode, isTwilioConfigured, normalizePhoneE164, sendPhoneVerificationCode } from '../lib/twilio.js';
import { countryCodeOrDefault, normalizeCountryCode } from '../lib/country.js';

export const profileRouter = Router();
const AGENT_LIKE_ROLES = new Set(['agent', 'super_agent', 'super_super_agent', 'admin']);

const PROFILE_BASE_FIELDS =
  'id, role, referred_by_id, username, display_name, avatar_url, id_document_path, id_document_back_path, id_document_uploaded_at, nps_score, nps_submitted_at, security_pin_set_at';

function isMissingCountryColumn(error) {
  const msg = error?.message || '';
  return /country_code/i.test(msg) && /(column|does not exist|schema cache)/i.test(msg);
}

/** Read a profile row, tolerating a missing country_code column (migration 020 not yet applied). */
async function selectProfileRow(userId) {
  let res = await supabase
    .from('profiles')
    .select(`${PROFILE_BASE_FIELDS}, country_code`)
    .eq('id', userId)
    .maybeSingle();
  if (res.error && isMissingCountryColumn(res.error)) {
    res = await supabase.from('profiles').select(PROFILE_BASE_FIELDS).eq('id', userId).maybeSingle();
  }
  return res;
}

function formatAffiliationFeesError(e) {
  const raw = e?.message ?? String(e);
  if (typeof raw === 'string' && raw.includes('affiliate_take_rate')) {
    return `${raw} Apply migration 014 in Supabase (SQL Editor): back/supabase/migrations/014_affiliate_take_rate.sql`;
  }
  if (typeof raw === 'string' && raw.includes('affiliation_team_settings')) {
    return `${raw} Apply migration 021 in Supabase (SQL Editor): back/supabase/migrations/021_affiliation_team_settings.sql`;
  }
  return raw;
}

function maskWalletAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return null;
  if (s.length <= 10) return `${s.slice(0, 2)}${'*'.repeat(Math.max(2, s.length - 4))}${s.slice(-2)}`;
  return `${s.slice(0, 6)}${'*'.repeat(8)}${s.slice(-4)}`;
}

function teamMemberRolesForManager(role) {
  if (role === 'super_super_agent' || role === 'admin') return ['agent', 'super_agent'];
  if (role === 'super_agent') return ['agent'];
  return null;
}

function roleDownlineFilter(role) {
  if (role === 'admin') return { kind: 'network', roles: ['agent', 'super_agent', 'super_super_agent', 'regular'] };
  if (role === 'super_super_agent') return { kind: 'agents', roles: ['agent', 'super_agent'] };
  if (role === 'super_agent') return { kind: 'agents', roles: ['agent'] };
  if (role === 'agent') return { kind: 'regulars', roles: ['regular'] };
  return null;
}

/**
 * Full referral tree under `rootUserId` (BFS on referred_by_id), not including the root.
 * Super / super-super agents recruit agents who recruit regulars; listing only direct + role=agent hid the rest.
 */
async function fetchReferralDescendants(rootUserId, { maxDepth = 25, maxNodes = 500 } = {}) {
  const members = [];
  const seen = new Set([String(rootUserId)]);
  let frontier = [String(rootUserId)];

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && members.length < maxNodes; depth += 1) {
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, created_at')
      .in('referred_by_id', frontier);
    if (error) throw error;
    const next = [];
    for (const row of rows || []) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(row);
      next.push(id);
      if (members.length >= maxNodes) break;
    }
    frontier = next;
  }

  members.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return members;
}

async function selectWalletsForUserIds(userIds) {
  const chunkSize = 80;
  const out = [];
  const ids = [...new Set(userIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase.from('wallets').select('id, user_id, currency').in('user_id', chunk);
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

async function selectProfilesByIds(ids) {
  const chunkSize = 80;
  const out = [];
  const uniq = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const { data, error } = await supabase.from('profiles').select('id, role, display_name, username').in('id', chunk);
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

async function getEmailsByUserIds(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const out = {};
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(id);
        out[id] = data?.user?.email || null;
      } catch {
        out[id] = null;
      }
    }),
  );
  return out;
}

/** GET /api/profile — get current user's profile (role, referred_by_id). Requires X-User-Id. */
profileRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data, error } = await selectProfileRow(userId);

    if (error) throw error;
    if (!data) {
      return res.json({ id: userId, role: 'regular', referred_by_id: null, country_code: 'IL' });
    }
    res.json({ ...data, country_code: data.country_code || 'IL' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/profile — update profile fields (avatar_url, id_document_path). Requires X-User-Id. */
profileRouter.patch('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const body = req.body || {};
    const updates = {};
    const response = { ok: true };

    if (body.avatar_url !== undefined) {
      if (body.avatar_url !== null && typeof body.avatar_url !== 'string') {
        return res.status(400).json({ error: 'avatar_url must be a string or null' });
      }
      const avatar_url = body.avatar_url === null ? null : body.avatar_url.trim();
      if (avatar_url && avatar_url.length > 2048) {
        return res.status(400).json({ error: 'avatar_url is too long' });
      }
      updates.avatar_url = avatar_url;
      response.avatar_url = avatar_url;
    }

    if (body.country_code !== undefined) {
      const country_code = normalizeCountryCode(body.country_code);
      if (!country_code) {
        return res.status(400).json({ error: 'country_code must be a 2-letter ISO code' });
      }
      updates.country_code = country_code;
      response.country_code = country_code;
    }

    if (body.id_document_path !== undefined) {
      if (body.id_document_path !== null && typeof body.id_document_path !== 'string') {
        return res.status(400).json({ error: 'id_document_path must be a string or null' });
      }
      const id_document_path = body.id_document_path === null ? null : body.id_document_path.trim();
      if (id_document_path) {
        const prefix = `${userId}/`;
        if (!id_document_path.startsWith(prefix)) {
          return res.status(400).json({ error: 'Invalid id_document_path' });
        }
        if (id_document_path.length > 512) {
          return res.status(400).json({ error: 'id_document_path is too long' });
        }
        updates.id_document_path = id_document_path;
        updates.id_document_uploaded_at = new Date().toISOString();
      } else {
        updates.id_document_path = null;
        updates.id_document_back_path = null;
        updates.id_document_uploaded_at = null;
      }
      response.id_document_path = updates.id_document_path ?? null;
      response.id_document_uploaded_at = updates.id_document_uploaded_at ?? null;
      if (updates.id_document_back_path === null) {
        response.id_document_back_path = null;
      }
    }

    if (body.id_document_back_path !== undefined) {
      if (body.id_document_back_path !== null && typeof body.id_document_back_path !== 'string') {
        return res.status(400).json({ error: 'id_document_back_path must be a string or null' });
      }
      const id_document_back_path =
        body.id_document_back_path === null ? null : body.id_document_back_path.trim();
      if (id_document_back_path) {
        const prefix = `${userId}/`;
        if (!id_document_back_path.startsWith(prefix)) {
          return res.status(400).json({ error: 'Invalid id_document_back_path' });
        }
        if (id_document_back_path.length > 512) {
          return res.status(400).json({ error: 'id_document_back_path is too long' });
        }
        updates.id_document_back_path = id_document_back_path;
        if (!updates.id_document_uploaded_at) {
          updates.id_document_uploaded_at = new Date().toISOString();
        }
      } else {
        updates.id_document_back_path = null;
      }
      response.id_document_back_path = updates.id_document_back_path ?? null;
      if (updates.id_document_uploaded_at) {
        response.id_document_uploaded_at = updates.id_document_uploaded_at;
      }
    }

    if (body.nps_score !== undefined) {
      const n = body.nps_score;
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(400).json({ error: 'nps_score must be an integer from 1 to 10' });
      }
      const { data: npsRow, error: npsErr } = await supabase
        .from('profiles')
        .select('nps_score')
        .eq('id', userId)
        .maybeSingle();
      if (npsErr) throw npsErr;
      if (npsRow?.nps_score != null) {
        return res.status(409).json({ error: 'Feedback already submitted' });
      }
      updates.nps_score = n;
      updates.nps_submitted_at = new Date().toISOString();
      response.nps_score = n;
      response.nps_submitted_at = updates.nps_submitted_at;
    }

    if (body.security_pin !== undefined || body.clear_security_pin === true) {
      const { data: pinRow, error: pinReadErr } = await supabase
        .from('profiles')
        .select('security_pin_hash')
        .eq('id', userId)
        .maybeSingle();
      if (pinReadErr) throw pinReadErr;
      const hasPin = Boolean(pinRow?.security_pin_hash);

      if (body.clear_security_pin === true || body.security_pin === null) {
        if (hasPin) {
          if (!body.current_pin) {
            return res.status(400).json({ error: 'Enter your current PIN to remove it' });
          }
          if (!verifySecurityPin(body.current_pin, userId, pinRow.security_pin_hash)) {
            return res.status(401).json({ error: 'Current PIN is incorrect' });
          }
        }
        updates.security_pin_hash = null;
        updates.security_pin_set_at = null;
        response.security_pin_set_at = null;
      } else if (typeof body.security_pin === 'string') {
        if (hasPin) {
          if (!body.current_pin) {
            return res.status(400).json({ error: 'Enter your current PIN to change it' });
          }
          if (!verifySecurityPin(body.current_pin, userId, pinRow.security_pin_hash)) {
            return res.status(401).json({ error: 'Current PIN is incorrect' });
          }
        }
        updates.security_pin_hash = hashSecurityPin(body.security_pin, userId);
        updates.security_pin_set_at = new Date().toISOString();
        response.security_pin_set_at = updates.security_pin_set_at;
      } else {
        return res.status(400).json({ error: 'security_pin must be a 6-digit string or null' });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.updated_at = new Date().toISOString();
    const { data: existing } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
    if (existing) {
      let { error: upErr } = await supabase.from('profiles').update(updates).eq('id', userId);
      if (upErr && isMissingCountryColumn(upErr) && 'country_code' in updates) {
        const { country_code, ...safe } = updates;
        ({ error: upErr } = await supabase.from('profiles').update(safe).eq('id', userId));
        delete response.country_code;
      }
      if (upErr) throw upErr;
    } else {
      let { error: insErr } = await supabase.from('profiles').insert({ id: userId, role: 'regular', ...updates });
      if (insErr && isMissingCountryColumn(insErr) && 'country_code' in updates) {
        const { country_code, ...safe } = updates;
        ({ error: insErr } = await supabase.from('profiles').insert({ id: userId, role: 'regular', ...safe }));
        delete response.country_code;
      }
      if (insErr) throw insErr;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/profile/verify-pin — check quick PIN before dashboard access. Requires X-User-Id. */
profileRouter.post('/verify-pin', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const pin = req.body?.pin;
    if (!isValidSecurityPin(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('security_pin_hash, security_pin_set_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;

    if (!data?.security_pin_hash) {
      return res.json({ ok: true, skipped: true });
    }

    if (!verifySecurityPin(pin, userId, data.security_pin_hash)) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/profile/phone/send — send SMS verification code via Twilio Verify. */
profileRouter.post('/phone/send', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    if (!isTwilioConfigured()) {
      return res.status(503).json({ error: 'SMS verification is not configured' });
    }

    const phone = normalizePhoneE164(req.body?.phone, req.body?.countryCode || '+1');
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid phone number with country code' });
    }

    const result = await sendPhoneVerificationCode(phone);
    res.json({ ok: true, phone: result.to, status: result.status });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(status).json({ error: e.message });
  }
});

/** POST /api/profile/phone/verify — confirm SMS code and save phone on the auth user. */
profileRouter.post('/phone/verify', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    if (!isTwilioConfigured()) {
      return res.status(503).json({ error: 'SMS verification is not configured' });
    }

    const phone = normalizePhoneE164(req.body?.phone, req.body?.countryCode || '+1');
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid phone number with country code' });
    }

    await checkPhoneVerificationCode(phone, req.body?.code);

    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      phone,
      phone_confirm: true,
    });
    if (updateErr) {
      if (updateErr.message?.toLowerCase().includes('already')) {
        return res.status(409).json({ error: 'This phone number is already linked to another account' });
      }
      throw updateErr;
    }

    res.json({ ok: true, phone });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(status).json({ error: e.message });
  }
});

/** DELETE /api/profile/phone — remove verified phone from the auth user. */
profileRouter.delete('/phone', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      phone: null,
      phone_confirm: false,
    });
    if (updateErr) throw updateErr;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/profile/downline — agent: direct regulars only. super_agent / super_super_agent: full referral tree.
 * Requires X-User-Id.
 */
profileRouter.get('/downline', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();

    if (meErr) throw meErr;
    const role = me?.role || 'regular';

    const filter = roleDownlineFilter(role);
    if (!filter) {
      return res.json({ kind: 'none', members: [] });
    }

    let list;
    if (role === 'super_agent' || role === 'super_super_agent' || role === 'admin') {
      list = await fetchReferralDescendants(userId);
      const kind = 'network';
      const members = await Promise.all(
        list.map(async (row) => {
          const { data: u } = await supabase.auth.admin.getUserById(row.id);
          return {
            ...row,
            email: u?.user?.email || null,
          };
        }),
      );
      return res.json({ kind, members });
    }

    let query = supabase
      .from('profiles')
      .select('id, username, display_name, role, created_at')
      .eq('referred_by_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);
    query = filter.roles.length > 1 ? query.in('role', filter.roles) : query.eq('role', filter.roles[0]);

    const { data: rows, error: qErr } = await query;

    if (qErr) throw qErr;

    list = rows || [];
    const members = await Promise.all(
      list.map(async (row) => {
        const { data: u } = await supabase.auth.admin.getUserById(row.id);
        return {
          ...row,
          email: u?.user?.email || null,
        };
      }),
    );

    res.json({ kind: filter.kind, members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/profile/affiliation-dashboard
 * Agent+ only. Returns downline members plus each member's recent transactions
 * and fee flow rows so agents can see where buy fees/commissions were routed.
 */
profileRouter.get('/affiliation-dashboard', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();
    if (meErr) throw meErr;
    const role = me?.role || 'regular';
    if (!AGENT_LIKE_ROLES.has(role)) {
      return res.status(403).json({ error: 'Affiliation dashboard is available for agent and above only' });
    }

    const filter = roleDownlineFilter(role);
    let members;
    let responseKind = filter.kind;
    if (role === 'super_agent' || role === 'super_super_agent' || role === 'admin') {
      members = await fetchReferralDescendants(userId);
      responseKind = 'network';
    } else {
      let downlineQuery = supabase
        .from('profiles')
        .select('id, username, display_name, role, created_at')
        .eq('referred_by_id', userId)
        .order('created_at', { ascending: false })
        .limit(300);
      downlineQuery =
        filter.roles.length > 1 ? downlineQuery.in('role', filter.roles) : downlineQuery.eq('role', filter.roles[0]);

      const { data: membersRaw, error: membersErr } = await downlineQuery;
      if (membersErr) throw membersErr;
      members = membersRaw || [];
    }

    const memberIds = members.map((m) => m.id);
    if (memberIds.length === 0) {
      return res.json({ kind: responseKind, members: [] });
    }

    const [wallets, { data: txRows, error: txErr }] = await Promise.all([
      selectWalletsForUserIds(memberIds),
      supabase
        .from('transactions')
        .select('id, from_wallet_id, to_wallet_id, amount, type, metadata, created_at')
        .order('created_at', { ascending: false })
        .limit(2000),
    ]);
    if (txErr) throw txErr;

    const memberSet = new Set(memberIds);
    const walletById = new Map((wallets || []).map((w) => [w.id, w]));
    const isFeeType = (t) => t === 'fee' || t === 'affiliate';
    const relatedTx = (txRows || []).filter((tx) => {
      const fromUser = walletById.get(tx.from_wallet_id)?.user_id || null;
      const toUser = walletById.get(tx.to_wallet_id)?.user_id || null;
      if (memberSet.has(fromUser) || memberSet.has(toUser)) return true;
      if (!isFeeType(tx.type)) return false;
      const md = tx.metadata || {};
      const buyerId = md.buyer_user_id || md.user_id || md.payer_user_id || null;
      return memberSet.has(buyerId);
    });

    const relatedUserIds = new Set(memberIds);
    for (const tx of relatedTx) {
      const fromUser = walletById.get(tx.from_wallet_id)?.user_id || null;
      const toUser = walletById.get(tx.to_wallet_id)?.user_id || null;
      if (fromUser) relatedUserIds.add(fromUser);
      if (toUser) relatedUserIds.add(toUser);
    }

    const relatedIdList = [...relatedUserIds];
    const [emailsById, profileRows] = await Promise.all([
      getEmailsByUserIds(relatedIdList),
      selectProfilesByIds(relatedIdList),
    ]);
    const profilesById = (profileRows || []).reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {});

    function txDescription(tx, memberId) {
      const fromUser = walletById.get(tx.from_wallet_id)?.user_id || null;
      const toUser = walletById.get(tx.to_wallet_id)?.user_id || null;
      if (tx.type === 'buy') return memberId === toUser ? 'Buy credited' : 'Buy paid';
      if (tx.type === 'sell') return memberId === fromUser ? 'Sell' : 'Sell related';
      if (tx.type === 'transfer') return memberId === fromUser ? 'Transfer sent' : 'Transfer received';
      if (tx.type === 'fee') return 'System fee';
      if (tx.type === 'affiliate') {
        const kind = tx.metadata?.kind;
        if (kind === 'super_super_upline') return 'Super-super commission';
        if (kind === 'super_upline') return 'Super-agent commission';
        return 'Affiliate commission';
      }
      return tx.type || 'transaction';
    }

    const outMembers = members.map((m) => {
      const memberTx = relatedTx
        .filter((tx) => {
          const fromUser = walletById.get(tx.from_wallet_id)?.user_id || null;
          const toUser = walletById.get(tx.to_wallet_id)?.user_id || null;
          return fromUser === m.id || toUser === m.id;
        })
        .slice(0, 25)
        .map((tx) => {
          const fromWallet = walletById.get(tx.from_wallet_id) || null;
          const toWallet = walletById.get(tx.to_wallet_id) || null;
          const direction = fromWallet?.user_id === m.id ? 'out' : 'in';
          const fromUserId = fromWallet?.user_id || null;
          const toUserId = toWallet?.user_id || null;
          return {
            id: tx.id,
            created_at: tx.created_at,
            type: tx.type,
            amount: Number(tx.amount) || 0,
            currency: toWallet?.currency || fromWallet?.currency || tx.metadata?.currency || '—',
            direction,
            description: txDescription(tx, m.id),
            from_user: fromUserId
              ? {
                  id: fromUserId,
                  email: emailsById[fromUserId] || null,
                  role: profilesById[fromUserId]?.role || null,
                  display_name: profilesById[fromUserId]?.display_name || profilesById[fromUserId]?.username || null,
                }
              : null,
            to_user: toUserId
              ? {
                  id: toUserId,
                  email: emailsById[toUserId] || null,
                  role: profilesById[toUserId]?.role || null,
                  display_name: profilesById[toUserId]?.display_name || profilesById[toUserId]?.username || null,
                }
              : null,
          };
        });

      const feeFlows = relatedTx
        .filter((tx) => {
          if (!isFeeType(tx.type)) return false;
          const md = tx.metadata || {};
          const buyerId = md.buyer_user_id || md.user_id || md.payer_user_id || null;
          return buyerId === m.id;
        })
        .slice(0, 25)
        .map((tx) => {
          const toWallet = walletById.get(tx.to_wallet_id) || null;
          const receiverId = toWallet?.user_id || null;
          const receiverProfile = receiverId ? profilesById[receiverId] : null;
          return {
            id: tx.id,
            created_at: tx.created_at,
            type: tx.type,
            fee_kind: tx.metadata?.kind || (tx.type === 'fee' ? 'platform' : 'affiliate'),
            amount: Number(tx.amount) || 0,
            currency: toWallet?.currency || tx.metadata?.currency || '—',
            receiver: receiverId
              ? {
                  id: receiverId,
                  email: emailsById[receiverId] || null,
                  role: receiverProfile?.role || null,
                  display_name: receiverProfile?.display_name || receiverProfile?.username || null,
                }
              : null,
          };
        });

      return {
        ...m,
        email: emailsById[m.id] || null,
        transactions: memberTx,
        fee_flows: feeFlows,
      };
    });

    res.json({ kind: responseKind, members: outMembers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/profile/affiliation-team
 * Super / super-super only: direct agents under the manager with nickname, earn %, masked wallet.
 */
profileRouter.get('/affiliation-team', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('id, role, affiliate_take_rate')
      .eq('id', userId)
      .maybeSingle();
    if (meErr) throw meErr;
    const role = me?.role || 'regular';
    const allowedRoles = teamMemberRolesForManager(role);
    if (!allowedRoles) {
      return res.status(403).json({ error: 'Team management is for super agents only' });
    }

    const { data: rows, error: qErr } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, created_at, referred_by_id')
      .eq('referred_by_id', userId)
      .in('role', allowedRoles)
      .order('created_at', { ascending: false })
      .limit(200);
    if (qErr) throw qErr;

    const members = rows || [];
    const memberIds = members.map((m) => m.id);

    let settingsByMember = {};
    if (memberIds.length) {
      const { data: settings, error: sErr } = await supabase
        .from('affiliation_team_settings')
        .select('member_id, nickname, earn_rate, notes, updated_at')
        .eq('manager_id', userId)
        .in('member_id', memberIds);
      if (sErr) throw sErr;
      settingsByMember = Object.fromEntries((settings || []).map((s) => [s.member_id, s]));
    }

    let walletsByUser = {};
    if (memberIds.length) {
      const { data: wallets } = await supabase
        .from('coinbase_wallets')
        .select('user_id, delivery_address, default_address, wallet_id')
        .in('user_id', memberIds);
      for (const w of wallets || []) {
        if (!walletsByUser[w.user_id]) walletsByUser[w.user_id] = w;
      }
    }

    const defaultEarnPercent =
      me?.affiliate_take_rate != null && me.affiliate_take_rate !== ''
        ? Math.round(Number(me.affiliate_take_rate) * 10000) / 100
        : 4;

    const out = await Promise.all(
      members.map(async (m) => {
        const { data: u } = await supabase.auth.admin.getUserById(m.id);
        const setting = settingsByMember[m.id] || null;
        const walletRow = walletsByUser[m.id] || null;
        const rawWallet =
          walletRow?.delivery_address || walletRow?.default_address || walletRow?.wallet_id || null;
        const earnPercent =
          setting?.earn_rate != null && setting.earn_rate !== ''
            ? Math.round(Number(setting.earn_rate) * 10000) / 100
            : null;

        return {
          id: m.id,
          username: m.username,
          display_name: m.display_name,
          role: m.role,
          created_at: m.created_at,
          email: u?.user?.email || null,
          nickname: setting?.nickname || null,
          notes: setting?.notes || null,
          earnPercent,
          defaultEarnPercent,
          walletMasked: maskWalletAddress(rawWallet),
          joined_at: m.created_at,
          settingsUpdatedAt: setting?.updated_at || null,
        };
      }),
    );

    res.json({ role, members: out, defaultEarnPercent, maxEarnPercent: 6 });
  } catch (e) {
    res.status(500).json({ error: formatAffiliationFeesError(e) });
  }
});

/**
 * PATCH /api/profile/affiliation-team/:memberId
 * Body: { nickname?: string|null, earnPercent?: number|null, notes?: string|null }
 */
profileRouter.patch('/affiliation-team/:memberId', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const memberId = req.params.memberId;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });

    const { data: me, error: meErr } = await supabase.from('profiles').select('id, role').eq('id', userId).maybeSingle();
    if (meErr) throw meErr;
    const role = me?.role || 'regular';
    const allowedRoles = teamMemberRolesForManager(role);
    if (!allowedRoles) {
      return res.status(403).json({ error: 'Team management is for super agents only' });
    }

    const { data: member, error: mErr } = await supabase
      .from('profiles')
      .select('id, role, referred_by_id')
      .eq('id', memberId)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!member || member.referred_by_id !== userId || !allowedRoles.includes(member.role)) {
      return res.status(404).json({ error: 'Agent not found in your team' });
    }

    const body = req.body || {};
    const patch = { updated_at: new Date().toISOString() };

    if (Object.prototype.hasOwnProperty.call(body, 'nickname')) {
      const nick = body.nickname == null ? null : String(body.nickname).trim().slice(0, 64);
      patch.nickname = nick || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      const notes = body.notes == null ? null : String(body.notes).trim().slice(0, 280);
      patch.notes = notes || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'earnPercent')) {
      if (body.earnPercent === null || body.earnPercent === '') {
        patch.earn_rate = null;
      } else {
        const pct = Number(body.earnPercent);
        if (Number.isNaN(pct) || pct < 0 || pct > 6) {
          return res.status(400).json({ error: 'earnPercent must be between 0 and 6' });
        }
        patch.earn_rate = pct / 100;
      }
    }

    if (Object.keys(patch).length <= 1) {
      return res.status(400).json({ error: 'Provide nickname, earnPercent, and/or notes' });
    }

    const { error: upErr } = await supabase.from('affiliation_team_settings').upsert(
      {
        manager_id: userId,
        member_id: memberId,
        ...patch,
      },
      { onConflict: 'manager_id,member_id' },
    );
    if (upErr) throw upErr;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: formatAffiliationFeesError(e) });
  }
});

/**
 * GET /api/profile/affiliation-fees — single affiliate take % for agent / super_agent / super_super_agent.
 * affiliateTakePercent null → app uses default 4%; max is 6%.
 */
profileRouter.get('/affiliation-fees', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('id, role, affiliate_take_rate')
      .eq('id', userId)
      .maybeSingle();
    if (meErr) throw meErr;
    const role = me?.role || 'regular';
    if (!AGENT_LIKE_ROLES.has(role)) {
      return res.status(403).json({ error: 'Affiliation fee settings are for agent roles only' });
    }

    const defaults = { platformPercent: 4, defaultAffiliateTakePercent: 4, maxAffiliateTakePercent: 6 };
    const hierarchyNote =
      'Platform keeps 4% on qualifying buys. Your affiliate tier (direct recruiter, super-agent, or super-super — whichever applies to your account) can take between 0% and 6% of gross for that tier. Lower values credit more crypto to the buyer.';

    const affiliateTakePercent =
      me?.affiliate_take_rate != null && me.affiliate_take_rate !== ''
        ? Math.round(Number(me.affiliate_take_rate) * 10000) / 100
        : null;

    res.json({
      role,
      defaults,
      hierarchyNote,
      affiliateTakePercent,
      maxAffiliateTakePercent: 6,
      defaultAffiliateTakePercent: 4,
    });
  } catch (e) {
    res.status(500).json({ error: formatAffiliationFeesError(e) });
  }
});

/**
 * PATCH /api/profile/affiliation-fees — body: { affiliateTakePercent: number } where 0 ≤ n ≤ 6
 */
profileRouter.patch('/affiliation-fees', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const body = req.body || {};
    const pct = Number(body.affiliateTakePercent);
    if (body.affiliateTakePercent === undefined || Number.isNaN(pct)) {
      return res.status(400).json({ error: 'affiliateTakePercent is required (0–6)' });
    }
    if (pct < 0 || pct > 6) {
      return res.status(400).json({ error: 'affiliateTakePercent must be between 0 and 6' });
    }

    const { data: me, error: meErr } = await supabase.from('profiles').select('id, role').eq('id', userId).maybeSingle();
    if (meErr) throw meErr;
    const role = me?.role || 'regular';
    if (!AGENT_LIKE_ROLES.has(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { error: upErr } = await supabase
      .from('profiles')
      .update({ affiliate_take_rate: pct / 100 })
      .eq('id', userId);
    if (upErr) throw upErr;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: formatAffiliationFeesError(e) });
  }
});
