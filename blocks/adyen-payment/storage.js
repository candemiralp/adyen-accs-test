/**
 * Adyen Storage Module
 *
 * Centralized localStorage operations for Adyen payment data.
 * All keys and storage logic in one place.
 */

export const STORAGE_KEYS = {
  PAYMENT_RESULT: 'adyen_payment_result',
  PENDING_ORDER: 'adyen_pending_order',
  INTEGRATION_URL: 'adyen_integration_url',
  PUBLIC_CONFIG: 'adyen_public_configuration',
  CHECKOUT_ATTEMPT_PREFIX: 'adyen_checkout_attempt_',
  LAST_CHECKOUT_ATTEMPT: 'adyen_last_checkout_attempt',
  INSTANCE_SNAPSHOT: 'adyen_instance_snapshot',
  PAYMENT_ERROR: 'adyen_payment_error',
  // Guest email and first/last name to pre-fill the login form after a
  // payment failure redirect so the customer does not have to re-type them.
  GUEST_EMAIL: 'adyen_guest_email',
  GUEST_FIRSTNAME: 'adyen_guest_firstname',
  GUEST_LASTNAME: 'adyen_guest_lastname',
  // Commerce payment method code for redirect-based flows (Klarna, Affirm, etc.)
  // Set before component.submit() so redirect.js can use the exact registered code
  // instead of reconstructing it from Adyen's paymentMethod.type (which lacks regional
  // suffixes like _US and may not match Commerce's available_payment_methods).
  REDIRECT_PAYMENT_CODE: 'adyen_redirect_payment_code',
};

// TTL constants (in seconds)
export const STORAGE_TTL = {
  INTEGRATION_URL: 86400, // 24 hours
  PUBLIC_CONFIG: 86400, // 24 hours
};

/**
 * Safely get item from localStorage
 * @param {string} key
 * @returns {string|null}
 */
export function getItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Safely set item in localStorage
 * @param {string} key
 * @param {string} value
 */
export function setItem(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Safely remove item from localStorage
 * @param {string} key
 */
export function removeItem(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Get and parse JSON from localStorage
 * @param {string} key
 * @returns {Object|null}
 */
export function getJSON(key) {
  const stored = getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Stringify and set JSON in localStorage
 * @param {string} key
 * @param {Object} value
 */
export function setJSON(key, value) {
  setItem(key, JSON.stringify(value));
}

/**
 * Get item with TTL check
 * @param {string} key
 * @returns {{ value: any, expired: boolean } | null}
 */
export function getWithExpiry(key) {
  const entry = getJSON(key);
  if (!entry) return null;

  const now = Math.round(Date.now() / 1000);
  const expired = entry[':expiry'] && entry[':expiry'] < now;

  return { value: entry.value, expired };
}

/**
 * Set item with TTL
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 */
export function setWithExpiry(key, value, ttlSeconds) {
  const entry = {
    value,
    ':expiry': Math.round(Date.now() / 1000) + ttlSeconds,
  };
  setJSON(key, entry);
}
