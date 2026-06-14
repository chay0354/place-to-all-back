function twilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !verifyServiceSid) {
    return null;
  }
  return { accountSid, authToken, verifyServiceSid };
}

export function isTwilioConfigured() {
  return Boolean(twilioConfig());
}

/** Normalize to E.164 (+ and digits only). */
export function normalizePhoneE164(raw, defaultCountryCode = '+1') {
  const input = String(raw || '').trim();
  if (!input) return null;

  if (input.startsWith('+')) {
    const digits = input.slice(1).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }

  const digits = input.replace(/\D/g, '');
  if (!digits) return null;
  const cc = String(defaultCountryCode || '+1').replace(/\D/g, '');
  const combined = `${cc}${digits}`;
  if (combined.length < 8 || combined.length > 15) return null;
  return `+${combined}`;
}

async function twilioFormPost(path, fields) {
  const cfg = twilioConfig();
  if (!cfg) {
    const err = new Error('SMS verification is not configured');
    err.status = 503;
    throw err;
  }

  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  const body = new URLSearchParams(fields);
  const res = await fetch(`https://verify.twilio.com/v2${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Could not reach SMS service');
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    err.code = data.code;
    throw err;
  }
  return data;
}

export async function sendPhoneVerificationCode(phone) {
  const data = await twilioFormPost(`/Services/${twilioConfig().verifyServiceSid}/Verifications`, {
    To: phone,
    Channel: 'sms',
  });
  return { status: data.status, to: data.to };
}

export async function checkPhoneVerificationCode(phone, code) {
  const trimmed = String(code || '').trim();
  if (!/^\d{4,8}$/.test(trimmed)) {
    const err = new Error('Enter the verification code from your SMS');
    err.status = 400;
    throw err;
  }

  const data = await twilioFormPost(`/Services/${twilioConfig().verifyServiceSid}/VerificationCheck`, {
    To: phone,
    Code: trimmed,
  });

  if (data.status !== 'approved') {
    const err = new Error('Incorrect or expired code');
    err.status = 401;
    throw err;
  }

  return { status: data.status, to: data.to };
}
