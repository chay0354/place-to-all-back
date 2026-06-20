export const DEFAULT_COUNTRY_CODE = 'IL';

export function normalizeCountryCode(raw) {
  const code = String(raw || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

export function countryCodeOrDefault(raw) {
  return normalizeCountryCode(raw) || DEFAULT_COUNTRY_CODE;
}
