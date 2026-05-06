/**
 * Direct Reap Sandbox test: create a card and fetch its details.
 *
 * Run:
 *   npm run test:reap-card
 *   node scripts/test-reap-sandbox-card.js
 *   node scripts/test-reap-sandbox-card.js <user-ref-id>
 */

import 'dotenv/config';

const BASE_URL = (process.env.REAP_BASE_URL || 'https://sandbox.api.caas.reap.global').replace(/\/+$/, '');
const API_KEY = process.env.REAP_API_KEY;
const API_VERSION = process.env.REAP_API_VERSION || 'v2.0';

const USER_REF = process.argv[2] || `sandbox-user-${Date.now()}`;

function required(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}

function headers() {
  return {
    accept: 'application/json',
    'Accept-Version': API_VERSION,
    'content-type': 'application/json',
    'x-reap-api-key': API_KEY,
  };
}

function buildPayload(userRef) {
  const country = process.env.REAP_SANDBOX_COUNTRY || 'HKG';
  const city = process.env.REAP_SANDBOX_CITY || 'Hong Kong';
  const line1 = process.env.REAP_SANDBOX_ADDR_LINE1 || 'Flat A on 1/F';
  const line2 = process.env.REAP_SANDBOX_ADDR_LINE2 || '123 Penny Lane';
  const businessName = process.env.REAP_SANDBOX_BUSINESS_NAME || 'Place To All Limited';
  const businessRegistrationNumber = process.env.REAP_SANDBOX_BUSINESS_REG_NO || 'ABC123456';
  const cardName = (process.env.REAP_SANDBOX_CARD_NAME || businessName).toUpperCase().slice(0, 27);
  const dialCode = process.env.REAP_OTP_DIAL_CODE || '852';
  const phoneNumber = process.env.REAP_OTP_PHONE || '95123456';
  const spendLimit = Number(process.env.REAP_SANDBOX_SPEND_LIMIT || 1000) || 1000;

  const address = {
    line1,
    line2,
    country,
    city,
  };

  return {
    cardType: 'Virtual',
    spendLimit,
    customerType: 'Business',
    kyc: {
      fullName: businessName,
      entityType: 'Company',
      registeredAddress: address,
      businessName,
      businessRegistrationNumber,
      businessOperationAddress: address,
    },
    preferredCardName: cardName,
    meta: {
      id: String(userRef),
      otpPhoneNumber: {
        dialCode: String(dialCode),
        phoneNumber: String(phoneNumber),
      },
    },
  };
}

async function main() {
  required('REAP_API_KEY', API_KEY);

  console.log('[0] Config');
  console.log(JSON.stringify({ BASE_URL, API_VERSION, USER_REF }, null, 2));

  const createPayload = buildPayload(USER_REF);
  const createRes = await fetch(`${BASE_URL}/cards`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(createPayload),
  });
  const createJson = await createRes.json().catch(() => ({}));

  console.log('[1] Create card response');
  console.log(JSON.stringify({ status: createRes.status, body: createJson }, null, 2));
  if (!createRes.ok || !createJson?.id) {
    throw new Error(createJson?.message || createJson?.error || `Create card failed (${createRes.status})`);
  }

  const cardId = createJson.id;
  const getRes = await fetch(`${BASE_URL}/cards/${encodeURIComponent(cardId)}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'Accept-Version': API_VERSION,
      'x-reap-api-key': API_KEY,
    },
  });
  const getJson = await getRes.json().catch(() => ({}));

  console.log('[2] Retrieve card response');
  console.log(JSON.stringify({ status: getRes.status, body: getJson }, null, 2));
  if (!getRes.ok) {
    throw new Error(getJson?.message || getJson?.error || `Get card failed (${getRes.status})`);
  }

  console.log('\n--- OK: Reap sandbox card creation works ---');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});

