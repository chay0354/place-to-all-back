import { Router } from 'express';
import { supabase } from '../db.js';
import { countryCodeOrDefault } from '../lib/country.js';
import { emailAgentApplication, readAgentApplication, saveAgentApplication } from '../lib/agent-application.js';

const authRouter = Router();
const MAX_AGE_SECONDS = 120; // Only confirm users created in the last 2 minutes

/** GET /api/auth/referral-preview?ref=uuid — public; returns recruiter role for register UI. */
authRouter.get('/referral-preview', async (req, res) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.json({ valid: false, recruiterRole: null });
    const { data } = await supabase.from('profiles').select('role').eq('id', ref).maybeSingle();
    if (!data || (data.role !== 'agent' && data.role !== 'super_agent' && data.role !== 'super_super_agent')) {
      return res.json({ valid: false, recruiterRole: null });
    }
    res.json({ valid: true, recruiterRole: data.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function clipProfile(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/** Personal details collected at signup. Absent for older clients. */
function readSignupProfile(body) {
  const src = body?.profile;
  if (!src || typeof src !== 'object') return null;
  const firstName = clipProfile(src.firstName, 80);
  const lastName = clipProfile(src.lastName, 80);
  const phone = clipProfile(src.phone, 24);
  const dateOfBirth = clipProfile(src.dateOfBirth, 10);
  const idNumber = clipProfile(src.idNumber, 40);
  const idType = src.idType === 'passport' ? 'passport' : src.idType === 'national_id' ? 'national_id' : '';
  const idExpiry = clipProfile(src.idExpiry, 10);
  const nationality = clipProfile(src.nationality, 2).toUpperCase();
  const postalCode = clipProfile(src.postalCode, 16);
  const occupation = clipProfile(src.occupation, 80);
  const city = clipProfile(src.city, 80);
  const address = clipProfile(src.address, 200);
  if (!firstName || !lastName || !phone || !dateOfBirth || !idNumber || !idType || !idExpiry || !nationality || !postalCode || !occupation || !city || !address) {
    return { error: 'Enter your name, phone, date of birth, identity document, nationality, address, and occupation.' };
  }
  if (phone.replace(/\D/g, '').length < 7) return { error: 'Enter a valid phone number.' };
  if (postalCode.length < 3) return { error: 'Enter your postal code.' };
  return { firstName, lastName, phone, dateOfBirth, idNumber, idType, idExpiry, nationality, postalCode, occupation, city, address };
}

/**
 * POST /api/auth/agent-application
 * Limited-company details for an agent request. Does not create a login or an agent role.
 */
authRouter.post('/agent-application', async (req, res) => {
  try {
    const parsed = readAgentApplication(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const path = await saveAgentApplication(parsed.application);
    let emailed = false;
    try {
      const mail = await emailAgentApplication(parsed.application);
      emailed = mail.sent;
    } catch (mailErr) {
      console.error('[agent-application] email failed', mailErr?.message || mailErr);
    }
    res.json({
      ok: true,
      status: 'pending',
      emailed,
      companyName: parsed.application.companyName,
      email: parsed.application.email,
      id: parsed.application.id,
      path,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/confirm-email
 * Body: { userId, role?: 'regular' | 'agent', referredBy?: string, profile?: object }
 * referredBy = agent → regular. referredBy = super_agent → agent. referredBy = super_super_agent → super_agent.
 * A client-chosen agent role does not open an account; that path is /agent-application.
 */
authRouter.post('/confirm-email', async (req, res) => {
  try {
    const { userId, role: requestedRole, referredBy, countryCode } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
    if (fetchErr || !user?.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const created = new Date(user.user.created_at).getTime();
    const now = Date.now();
    if (now - created > MAX_AGE_SECONDS * 1000) {
      return res.status(400).json({ error: 'User too old to auto-confirm' });
    }

    const signup = readSignupProfile(req.body);
    if (signup?.error) return res.status(400).json({ error: signup.error });

    let role;
    let referred_by_id = null;

    if (referredBy) {
      const { data: refProfile } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('id', referredBy)
        .maybeSingle();
      if (!refProfile || (refProfile.role !== 'agent' && refProfile.role !== 'super_agent' && refProfile.role !== 'super_super_agent')) {
        return res.status(400).json({ error: 'Invalid referral link' });
      }
      if (refProfile.role === 'super_super_agent') {
        role = 'super_agent';
        referred_by_id = referredBy;
      } else if (refProfile.role === 'super_agent') {
        role = 'agent';
        referred_by_id = referredBy;
      } else {
        role = 'regular';
        referred_by_id = referredBy;
      }
    } else if (requestedRole === 'agent') {
      return res.status(400).json({
        error: 'Agent accounts are not opened from signup. Submit your company details and wait for approval.',
      });
    } else {
      role = 'regular';
    }

    const country_code = countryCodeOrDefault(countryCode);
    const display_name = signup ? `${signup.firstName} ${signup.lastName}` : null;
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      email_confirm: true,
      ...(signup
        ? {
            user_metadata: {
              first_name: signup.firstName,
              last_name: signup.lastName,
              phone: signup.phone,
              date_of_birth: signup.dateOfBirth,
              id_number: signup.idNumber,
              id_type: signup.idType,
              id_expiry: signup.idExpiry,
              nationality: signup.nationality,
              postal_code: signup.postalCode,
              occupation: signup.occupation,
              city: signup.city,
              address_line: signup.address,
              country_code,
            },
          }
        : {}),
    });
    if (updateErr) throw updateErr;
    const missingCountryColumn = (e) =>
      /country_code/i.test(e?.message || '') && /(column|does not exist|schema cache)/i.test(e?.message || '');

    const { data: existing } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
    const updated_at = new Date().toISOString();
    if (existing) {
      let { error: e1 } = await supabase
        .from('profiles')
        .update({ role, referred_by_id, country_code, ...(display_name ? { display_name } : {}), updated_at })
        .eq('id', userId);
      if (e1 && missingCountryColumn(e1)) {
        ({ error: e1 } = await supabase
          .from('profiles')
          .update({ role, referred_by_id, ...(display_name ? { display_name } : {}), updated_at })
          .eq('id', userId));
      }
      if (e1) throw e1;
    } else {
      let { error: e2 } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          role,
          referred_by_id,
          country_code,
          ...(display_name ? { display_name } : {}),
          updated_at,
        });
      if (e2 && missingCountryColumn(e2)) {
        ({ error: e2 } = await supabase
          .from('profiles')
          .insert({ id: userId, role, referred_by_id, ...(display_name ? { display_name } : {}), updated_at }));
      }
      if (e2) throw e2;
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { authRouter };
