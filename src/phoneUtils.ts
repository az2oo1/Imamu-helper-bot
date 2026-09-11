/**
 * Utilities for extracting, normalizing, and generating phone number variations.
 */

/**
 * Extracts raw numeric phone number from a WhatsApp JID or user identifier string.
 * Example: '966512345678:12@s.whatsapp.net' => '966512345678'
 */
export function extractPhoneNumberFromJid(jid: string): string {
  if (!jid) return '';
  const unparsed = jid.split('@')[0].split(':')[0];
  return unparsed.replace(/\D/g, '');
}

/**
 * Strips all non-digit characters except optional leading '+'
 */
export function sanitizePhone(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return digits;
}

/**
 * Generates variations of a phone number to ensure matching against different database formats.
 * Works with Saudi (+966 / 05 / 5) and international phone number formats.
 */
export function generatePhoneVariations(rawPhone: string): string[] {
  const digits = sanitizePhone(rawPhone);
  if (!digits) return [];

  const variations = new Set<string>();

  // 1. Raw digits
  variations.add(digits);

  // 2. With leading '+'
  variations.add(`+${digits}`);

  // Saudi Arabia specifics (+966 / 966 / 05... / 5...)
  if (digits.startsWith('966')) {
    const localPart = digits.slice(3); // e.g. 512345678
    variations.add(localPart);
    variations.add(`0${localPart}`);
    variations.add(`+966${localPart}`);
    variations.add(`966${localPart}`);
    variations.add(`+966 ${localPart}`);
    variations.add(`0${localPart.slice(0, 2)} ${localPart.slice(2, 5)} ${localPart.slice(5)}`);
  } else if (digits.startsWith('05') && digits.length === 10) {
    const localPart = digits.slice(1); // e.g. 512345678
    variations.add(localPart);
    variations.add(digits);
    variations.add(`966${localPart}`);
    variations.add(`+966${localPart}`);
    variations.add(`+966 ${localPart}`);
  } else if (digits.startsWith('5') && digits.length === 9) {
    variations.add(digits);
    variations.add(`0${digits}`);
    variations.add(`966${digits}`);
    variations.add(`+966${digits}`);
    variations.add(`+966 ${digits}`);
  }

  return Array.from(variations);
}

/**
 * Format a phone number for user-friendly logging.
 */
export function formatPhoneForDisplay(phone: string): string {
  const digits = sanitizePhone(phone);
  if (digits.startsWith('966') && digits.length === 12) {
    return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}
