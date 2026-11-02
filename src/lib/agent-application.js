import { createHash, randomUUID } from 'crypto';
import { supabase } from '../db.js';
import { countryCodeOrDefault } from './country.js';

const BUCKET = 'agent-applications';
const MAX = 160;

function clip(value, max = MAX) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function emailOk(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function readAgentApplication(body) {
  const companyName = clip(body?.companyName);
  const companyNumber = clip(body?.companyNumber, 40);
  const countryCode = countryCodeOrDefault(body?.countryCode);
  const address = clip(body?.address, 200);
  const city = clip(body?.city, 80);
  const postalCode = clip(body?.postalCode, 16);
  const incorporatedOn = clip(body?.incorporatedOn, 10);
  const taxId = clip(body?.taxId, 40);
  const contactName = clip(body?.contactName);
  const contactTitle = clip(body?.contactTitle, 80);
  const phone = clip(body?.phone, 24);
  const email = clip(body?.email, 120).toLowerCase();
  const referredBy = clip(body?.referredBy, 80);
  const agreed = body?.agreed === true;
  const phoneDigits = phone.replace(/\D/g, '');

  if (companyName.length < 2) return { error: 'Enter the company legal name.' };
  if (companyNumber.length < 3) return { error: 'Enter the company registration number.' };
  if (address.length < 4) return { error: 'Enter the registered address.' };
  if (city.length < 2) return { error: 'Enter the company city.' };
  if (postalCode.length < 3) return { error: 'Enter the company postal code.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incorporatedOn) || Number.isNaN(Date.parse(incorporatedOn)) || incorporatedOn > new Date().toISOString().slice(0, 10)) {
    return { error: 'Enter the incorporation date.' };
  }
  if (taxId.length < 4) return { error: 'Enter the tax or VAT number.' };
  if (contactName.length < 2) return { error: 'Enter the contact person’s name.' };
  if (contactTitle.length < 2) return { error: 'Enter the contact person’s role.' };
  if (phoneDigits.length < 7) return { error: 'Enter a contact phone number.' };
  if (!emailOk(email)) return { error: 'Enter a valid contact email.' };
  if (!agreed) return { error: 'A company agreement and our approval are required before an account is opened.' };

  return {
    application: {
      id: randomUUID(),
      status: 'pending',
      companyName,
      companyNumber,
      countryCode,
      address,
      city,
      postalCode,
      incorporatedOn,
      taxId,
      contactName,
      contactTitle,
      phone,
      email,
      referredBy: referredBy || null,
      agreed,
      createdAt: new Date().toISOString(),
    },
  };
}

function objectPath(email) {
  const hash = createHash('sha256').update(email).digest('hex');
  return `${hash}.json`;
}

async function ensureBucket() {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (!error) return;
  const msg = error.message || '';
  if (/already exists|duplicate/i.test(msg)) return;
  throw error;
}

export async function saveAgentApplication(application) {
  await ensureBucket();
  const path = objectPath(application.email);
  const payload = Buffer.from(JSON.stringify(application), 'utf8');
  const { error } = await supabase.storage.from(BUCKET).upload(path, payload, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw error;
  return path;
}

function approvalInbox() {
  return (
    process.env.AGENT_APPLICATION_EMAIL ||
    process.env.ADMIN_OPERATOR_EMAIL ||
    'admin@admin.com'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function emailAgentApplication(application) {
  const to = approvalInbox();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  const host = process.env.SMTP_HOST || '';
  if (!host || !from) {
    return { sent: false, reason: 'email_not_configured', to };
  }
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
  const lines = [
    'A limited-company agent application is waiting for approval.',
    'Do not open an agent account until you approve it and a company agreement is in place.',
    '',
    `Company: ${application.companyName}`,
    `Company number: ${application.companyNumber}`,
    `Country: ${application.countryCode}`,
    `Address: ${application.address}, ${application.city} ${application.postalCode}`,
    `Incorporated: ${application.incorporatedOn}`,
    `Tax or VAT: ${application.taxId}`,
    `Contact: ${application.contactName}, ${application.contactTitle}`,
    `Phone: ${application.phone}`,
    `Email: ${application.email}`,
    application.referredBy ? `Referred by: ${application.referredBy}` : '',
    `Application id: ${application.id}`,
    `Submitted: ${application.createdAt}`,
  ].filter(Boolean);
  await transport.sendMail({
    from,
    to: to.join(', '),
    replyTo: application.email,
    subject: `Agent application pending: ${application.companyName}`,
    text: lines.join('\n'),
  });
  return { sent: true, to };
}
