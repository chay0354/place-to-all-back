import { Router } from 'express';
import { supabase } from '../db.js';

export const profileRouter = Router();
const AGENT_LIKE_ROLES = new Set(['agent', 'super_agent', 'super_super_agent']);

function formatAffiliationFeesError(e) {
  const raw = e?.message ?? String(e);
  if (typeof raw === 'string' && raw.includes('affiliate_take_rate')) {
    return `${raw} Apply migration 014 in Supabase (SQL Editor): back/supabase/migrations/014_affiliate_take_rate.sql`;
  }
  return raw;
}

function roleDownlineFilter(role) {
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

    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, referred_by_id, username, display_name')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.json({ id: userId, role: 'regular', referred_by_id: null });
    }
    res.json(data);
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
    if (role === 'super_agent' || role === 'super_super_agent') {
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
    if (role === 'super_agent' || role === 'super_super_agent') {
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
