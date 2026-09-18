/**
 * Adyen State Module
 *
 * Centralized state management for Adyen payment flow.
 * Handles PaymentResult, PendingOrder, and checkout attempt tracking.
 */

import {
  STORAGE_KEYS,
  getJSON,
  setJSON,
  removeItem,
  getItem,
  setItem,
} from './storage.js';

// ============================================================================
// PAYMENT RESULT STATE
// ============================================================================
// Data from Adyen's payment response (pspReference, paymentMethod, donationToken, etc.)
// Used when placing an order after client-side payment authorization.
// Stored in memory and localStorage to survive redirects.
// ============================================================================

/**
 * Additional order information stored after payment.
 * Matches backend OrderAdditionalInfo interface from order-result-store.ts
 *
 * @typedef {Object} PaymentResult
 * @property {string} [pspReference] - Adyen payment reference
 * @property {string} [merchantReference] - Merchant reference for the payment
 * @property {Object} [paymentMethod] - Payment method info from Adyen component
 * @property {string} [donationToken] - Token for Adyen Giving donations
 * @property {Object} [action] - Additional action required (3DS, redirect, etc.)
 * @property {string} [resultCode] - Adyen result code (Authorised, Pending, etc.)
 * @property {string} [cartId] - Commerce cart ID for client-side redirect completion
 */

// In-memory cache
let paymentResultCache = null;

// Track pending fetch to prevent race conditions
let paymentResultFetchPromise = null;

/**
 * Store payment result from Adyen response.
 * Uses localStorage to survive redirects (e.g., 3DS redirect flows).
 * @param {PaymentResult} result
 */
export function setPaymentResult(result) {
  paymentResultCache = result;
  setJSON(STORAGE_KEYS.PAYMENT_RESULT, result);
}

/**
 * Get the current payment result.
 * If a fetch is in progress, waits for it to complete before returning.
 * @returns {Promise<PaymentResult|null>}
 */
export async function getPaymentResult() {
  // Wait for any pending fetch to complete
  if (paymentResultFetchPromise) {
    try {
      await paymentResultFetchPromise;
    } catch {
      // Fetch failed, continue to check cache/storage
    }
  }

  if (paymentResultCache) {
    return paymentResultCache;
  }

  const stored = getJSON(STORAGE_KEYS.PAYMENT_RESULT);
  if (stored) {
    paymentResultCache = stored;
    return paymentResultCache;
  }

  return null;
}

/**
 * Get the current payment result synchronously (without waiting for pending fetch).
 * Use this only when you're certain no fetch is in progress.
 * @returns {PaymentResult|null}
 */
export function getPaymentResultSync() {
  if (paymentResultCache) {
    return paymentResultCache;
  }

  const stored = getJSON(STORAGE_KEYS.PAYMENT_RESULT);
  if (stored) {
    paymentResultCache = stored;
    return paymentResultCache;
  }

  return null;
}

/**
 * Clear payment result from memory and storage.
 */
export function clearPaymentResult() {
  paymentResultCache = null;
  removeItem(STORAGE_KEYS.PAYMENT_RESULT);
}

/**
 * @deprecated Use getPaymentResult() instead. This alias exists for backward compatibility.
 * @returns {PaymentResult|null}
 */
export function getPreviousOrderData() {
  return getPaymentResultSync() || {
    pspReference: null,
    merchantReference: null,
    paymentMethod: null,
    donationToken: null,
    action: null,
    resultCode: null,
  };
}

/**
 * Set the pending fetch promise for payment result.
 * Used by fetchOrderResult to track in-flight requests.
 * @param {Promise|null} promise
 */
export function setPaymentResultFetchPromise(promise) {
  paymentResultFetchPromise = promise;
}

/**
 * Get the current fetch promise (for cleanup checks).
 * @returns {Promise|null}
 */
export function getPaymentResultFetchPromise() {
  return paymentResultFetchPromise;
}

// ============================================================================
// PENDING ORDER STATE
// ============================================================================
// Full Commerce order data when order was placed server-side before redirect/3DS.
// After additional action completes, we use this to navigate to order confirmation
// WITHOUT calling placeOrder() again.
// ============================================================================

// In-memory cache
let pendingOrderCache = null;

/**
 * Set pending order data when an order was placed server-side but requires additional action.
 * Uses localStorage to survive redirects (e.g., 3DS redirect flows).
 *
 * @param {Object|null} orderData - The order data from initial placement, or null to clear
 */
export function setPendingOrderData(orderData) {
  pendingOrderCache = orderData;
  if (orderData) {
    setJSON(STORAGE_KEYS.PENDING_ORDER, orderData);
  } else {
    removeItem(STORAGE_KEYS.PENDING_ORDER);
  }
}

/**
 * Get the current pending order data (if any).
 * @returns {Object|null}
 */
export function getPendingOrderData() {
  if (pendingOrderCache) {
    return pendingOrderCache;
  }

  const stored = getJSON(STORAGE_KEYS.PENDING_ORDER);
  if (stored) {
    pendingOrderCache = stored;
    return pendingOrderCache;
  }

  return null;
}

/**
 * Clear pending order data from both memory and localStorage.
 */
export function clearPendingOrderData() {
  pendingOrderCache = null;
  removeItem(STORAGE_KEYS.PENDING_ORDER);
}

// ============================================================================
// CHECKOUT ATTEMPT ID
// ============================================================================
// Unique ID per cart for tracking checkout attempts in Adyen.
// Persists across page refreshes and redirect flows.
// ============================================================================

// In-memory cache for last used checkoutAttemptId
let lastCheckoutAttemptIdCache = null;

/**
 * Get or create a checkoutAttemptId for the current cart.
 * Uses localStorage to survive 3DS/payment redirects.
 * Falls back to last used attemptId if cartId is not available (e.g., on order confirmation).
 * @param {string} cartId
 * @returns {string}
 */
export function getCheckoutAttemptId(cartId) {
  if (!cartId) {
    // Return the last used attemptId if available (check cache, then storage)
    if (lastCheckoutAttemptIdCache) {
      return lastCheckoutAttemptIdCache;
    }
    const storedLast = getItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT);
    if (storedLast) {
      lastCheckoutAttemptIdCache = storedLast;
      return storedLast;
    }
    // Generate a new one as last resort
    const newId = crypto.randomUUID();
    lastCheckoutAttemptIdCache = newId;
    setItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT, newId);
    return newId;
  }

  const key = `${STORAGE_KEYS.CHECKOUT_ATTEMPT_PREFIX}${cartId}`;
  let attemptId = getItem(key);

  if (!attemptId) {
    attemptId = crypto.randomUUID();
    setItem(key, attemptId);
  }

  // Store as last used for fallback (both in memory and localStorage)
  lastCheckoutAttemptIdCache = attemptId;
  setItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT, attemptId);

  return attemptId;
}

/**
 * Clear the checkoutAttemptId for a specific cart.
 * @param {string} cartId
 */
export function clearCheckoutAttemptId(cartId) {
  if (!cartId) return;
  const key = `${STORAGE_KEYS.CHECKOUT_ATTEMPT_PREFIX}${cartId}`;
  removeItem(key);
  // Note: Don't clear lastCheckoutAttemptId
  // - it may still be necessary for order confirmation/donation
}

// ============================================================================
// REDIRECT PAYMENT CODE
// ============================================================================
// The Commerce payment method code (e.g. 'adyen_klarna_US') for redirect-based
// flows. Stored before component.submit() so redirect.js can use the exact code
// instead of reconstructing it from Adyen's paymentMethod.type (which has no
// regional suffix and may not match Commerce's available_payment_methods list).
// ============================================================================

/**
 * Store the Commerce payment method code that will be used for the redirect.
 * Call this just before component.submit() for Klarna/Affirm redirect flows.
 * @param {string} code - Commerce payment method code (e.g. 'adyen_klarna_US')
 */
export function setRedirectPaymentCode(code) {
  setItem(STORAGE_KEYS.REDIRECT_PAYMENT_CODE, code);
}

/**
 * Get the stored Commerce payment method code for the current redirect.
 * @returns {string|null}
 */
export function getRedirectPaymentCode() {
  return getItem(STORAGE_KEYS.REDIRECT_PAYMENT_CODE);
}

/**
 * Clear the stored redirect payment code (call after use or on failure).
 */
export function clearRedirectPaymentCode() {
  removeItem(STORAGE_KEYS.REDIRECT_PAYMENT_CODE);
}

// ============================================================================
// ACTIVE COMPONENT
// ============================================================================
// Reference to the currently active Adyen payment component.
// ============================================================================

let activeComponent = null;

/**
 * Set the active Adyen payment component.
 * @param {Object} component
 */
export function setActiveComponent(component) {
  activeComponent = component;
}

/**
 * Get the active Adyen payment component.
 * @returns {Object|null}
 */
export function getActiveComponent() {
  return activeComponent;
}

// ============================================================================
// EXTRA PAYMENT PARAMETERS
// ============================================================================
// Additional payment parameters that may be required by certain payment methods.
// ============================================================================

let extraPaymentParams = {};

/**
 * Set extra payment parameters for the current payment attempt.
 * @param {Object} params - Extra payment parameters
 */
export function setExtraPaymentParams(params) {
  extraPaymentParams = params || {};
}

/**
 * Get the current extra payment parameters.
 * @returns {Object}
 */
export function getExtraPaymentParams() {
  return extraPaymentParams;
}
