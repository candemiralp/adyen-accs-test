/**
 * Adyen Redirect Handler Module
 *
 * Handles return from Adyen redirect flows (3DS, iDEAL, Bancontact, etc.)
 *
 * This module is self-contained and relies only on localStorage data.
 * No checkout/cart initialization is required.
 */

import { placeOrder } from '@dropins/storefront-order/api.js';
import * as checkoutApi from '@dropins/storefront-checkout/api.js';
import { events } from '@dropins/tools/event-bus.js';
import { getUserTokenCookie } from '../../scripts/initializers/index.js';
import { rootLink } from '../../scripts/commerce.js';
import '../../scripts/initializers/checkout.js';
import { adyenFetch } from '../../scripts/adyen-auth.js';

let resolveCheckoutInitialized;
const checkoutInitialized = new Promise((resolve) => {
  resolveCheckoutInitialized = resolve;
});
events.on('checkout/initialized', () => {
  resolveCheckoutInitialized();
});

// ============================================================================
// STORAGE HELPERS (self-contained to avoid circular dependencies)
// ============================================================================

const STORAGE_KEYS = {
  PAYMENT_RESULT: 'adyen_payment_result',
  PENDING_ORDER: 'adyen_pending_order',
  INTEGRATION_URL: 'adyen_integration_url',
  // Set by commerce-checkout.js before component.submit() for Klarna/Affirm redirects.
  // Contains the exact Commerce payment method code (e.g. 'adyen_klarna_US') so we
  // don't have to reconstruct it from Adyen's paymentMethod.type which lacks the
  // regional suffix and may not match Commerce's available_payment_methods list.
  REDIRECT_PAYMENT_CODE: 'adyen_redirect_payment_code',
};

function getItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage errors
  }
}

function removeItem(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore localStorage errors
  }
}

function getJSON(key) {
  const stored = getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

function setJSON(key, value) {
  setItem(key, JSON.stringify(value));
}

// ============================================================================
// STATE HELPERS
// ============================================================================

let paymentResultCache = null;

function setPaymentResult(result) {
  paymentResultCache = result;
  setJSON(STORAGE_KEYS.PAYMENT_RESULT, result);
}

function getPaymentResultSync() {
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

function clearPaymentResult() {
  paymentResultCache = null;
  removeItem(STORAGE_KEYS.PAYMENT_RESULT);
}

function getPendingOrderData() {
  return getJSON(STORAGE_KEYS.PENDING_ORDER);
}

function clearPendingOrderData() {
  removeItem(STORAGE_KEYS.PENDING_ORDER);
}

function getBackendIntegrationUrl() {
  const entry = getJSON(STORAGE_KEYS.INTEGRATION_URL);
  if (!entry) return null;

  const now = Math.round(Date.now() / 1000);
  const expired = entry[':expiry'] && entry[':expiry'] < now;

  if (expired) {
    return null;
  }

  return entry.value;
}

// ============================================================================
// URL HELPERS
// ============================================================================

/**
 * Build the order-details URL with appropriate parameters.
 * @param {Object} orderData - Order data containing number and token
 * @returns {string}
 */
export function buildOrderDetailsUrl(orderData) {
  const token = getUserTokenCookie();
  const orderRef = token ? orderData.number : orderData.token;
  const orderNumber = orderData.number;
  const { email } = orderData;
  const encodedOrderRef = encodeURIComponent(orderRef);
  const encodedOrderNumber = encodeURIComponent(orderNumber);
  const encodedEmail = encodeURIComponent(email);

  return token
    ? rootLink(`/order-details?orderRef=${encodedOrderRef}`)
    : rootLink(`/order-details?orderRef=${encodedOrderRef}&orderNumber=${encodedOrderNumber}&email=${encodedEmail}`);
}

// ============================================================================
// REDIRECT HANDLER
// ============================================================================

/**
 * @typedef {Object} RedirectResult
 * @property {boolean} success - Whether the redirect was handled successfully
 * @property {string} [redirect] - URL to redirect to (if applicable)
 * @property {boolean} [paymentFailed] - Whether payment failed for an existing order
 * @property {Object} [orderData] - Order data when payment failed for server-side flow
 * @property {string} [error] - Error message (if any)
 */

/**
 * Handle return from Adyen redirect (3DS, iDEAL, Bancontact, Klarna, Affirm, etc.)
 *
 * Two scenarios on redirect return:
 *
 * 1. SERVER-SIDE PAYMENT (Credit Card + 3DS redirect):
 *    Order was already placed before redirect. pendingOrderData exists in localStorage.
 *    After handling redirect, we just navigate to order confirmation.
 *
 * 2. CLIENT-SIDE PAYMENT (iDEAL, Bancontact, Affirm, Klarna, etc.):
 *    Order was NOT placed before redirect. No pendingOrderData.
 *    After handling redirect, we need to call placeOrder().
 *
 * @param {Object} params
 * @param {Function} params.displayOverlaySpinner - Show loading spinner
 * @param {Function} params.removeOverlaySpinner - Hide loading spinner
 * @returns {Promise<RedirectResult>} Result of the redirect handling
 */
export async function handleAdyenRedirect({
  removeOverlaySpinner,
}) {
  const urlParams = new URLSearchParams(window.location.search);
  const redirectResultParam = urlParams.get('redirectResult');

  if (!redirectResultParam) {
    return { success: true, redirect: '/checkout' };
  }

  let storedPendingOrder = null;

  try {
    // Check if we have pending order data from a server-side payment flow
    // (order was already placed before redirect, e.g. credit card 3DS)
    storedPendingOrder = getPendingOrderData();

    if (storedPendingOrder) {
      // SERVER-SIDE FLOW: Order already placed, submit details to Adyen
      const backendUrl = getBackendIntegrationUrl();
      if (!backendUrl) {
        throw new Error('Backend integration URL not found in cache');
      }

      const paymentDetailsEndpoint = `${backendUrl}payments-details`;
      const guestEmail = getJSON(STORAGE_KEYS.GUEST_EMAIL);
      const shopperId = storedPendingOrder?.email || guestEmail;
      const isGuestCart = !getUserTokenCookie();
      const response = await adyenFetch(paymentDetailsEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ details: { redirectResult: redirectResultParam } }),
      }, { backendUrl, shopperId, isGuestCart });

      if (!response.ok) {
        throw new Error(`Payment details request failed: ${response.status}`);
      }

      const paymentResult = await response.json();

      if (paymentResult.resultCode === 'Authorised'
        || paymentResult.resultCode === 'Pending'
        || paymentResult.resultCode === 'Received') {
        setPaymentResult({
          pspReference: paymentResult.pspReference,
          merchantReference: paymentResult.merchantReference,
          paymentMethod: paymentResult.paymentMethod,
          donationToken: paymentResult.donationToken,
          action: paymentResult.action,
          resultCode: paymentResult.resultCode,
        });

        clearPendingOrderData();
        return { success: true, orderData: storedPendingOrder };
      }

      clearPaymentResult();
      clearPendingOrderData();
      console.warn('Adyen 3DS payment failed for existing order:', paymentResult.resultCode);
      return {
        success: false,
        paymentFailed: true,
        orderData: storedPendingOrder,
        error: paymentResult.resultCode,
      };
    }

    // CLIENT-SIDE FLOW: Order was NOT placed before redirect
    // Wait for checkout dropin to initialise, then set payment method and place order
    await checkoutInitialized;

    const paymentResultData = getPaymentResultSync();

    // Prefer the Commerce payment method code stored before the redirect (e.g.
    // 'adyen_klarna_paynow', 'adyen_klarna_US'). Fall back to constructing from
    // paymentMethod.type only if the stored code is not available — the Adyen
    // SDK's type ('klarna', 'klarna_paynow') lacks regional suffixes and may not
    // match the code in Commerce's available_payment_methods list.
    const storedPaymentCode = getItem(STORAGE_KEYS.REDIRECT_PAYMENT_CODE);
    const paymentMethodCode = storedPaymentCode
      || (paymentResultData?.paymentMethod?.type
        ? `adyen_${paymentResultData.paymentMethod.type}`
        : undefined);

    // Clear the stored code now that we've read it — it was a one-time signal
    removeItem(STORAGE_KEYS.REDIRECT_PAYMENT_CODE);

    // Extract paymentData from the action before stripping it.
    // The Adyen redirect action contains a paymentData token that the backend
    // needs to call /payments/details. This must be passed alongside the
    // redirectResult so the Commerce webhook can finalize the payment.
    const paymentData = paymentResultData?.action?.paymentData;

    // Strip action from payment result to prevent redirection loop
    const { action: _action, ...paymentResultDataWithoutAction } = paymentResultData ?? {};
    setPaymentResult(paymentResultDataWithoutAction);

    const cartId = urlParams.get('cartId') || paymentResultData?.cartId;
    if (!cartId) {
      throw new Error('Cart ID not found for client-side payment flow');
    }

    // Build additional_data: always include details (redirectResult).
    // Include paymentData if available — the Commerce Adyen module and backend
    // webhook both use paymentData to verify the redirect result with Adyen.
    // Include state if stored — the backend's details flow takes priority over
    // the state flow, so passing both ensures the redirect result is used while
    // satisfying any Commerce-side availability checks.
    const additionalData = [
      { key: 'details', value: JSON.stringify({ redirectResult: redirectResultParam }) },
    ];
    if (paymentData) {
      additionalData.push({ key: 'paymentData', value: paymentData });
    }
    const stateData = paymentResultData?.stateData;
    if (stateData) {
      additionalData.push({ key: 'state', value: JSON.stringify(stateData) });
    }

    await checkoutApi.setPaymentMethod({
      code: paymentMethodCode,
      additional_data: additionalData,
    });

    const orderData = await placeOrder(cartId);

    try {
      sessionStorage.setItem('recent_order_data', JSON.stringify(orderData));
    } catch {
      // Ignore sessionStorage errors
    }

    return { success: true, orderData };
  } catch (error) {
    clearPaymentResult();
    console.debug('Adyen redirect handling error:', error);

    // SERVER-SIDE FLOW: order was placed before redirect — show payment failure UI
    if (storedPendingOrder) {
      clearPendingOrderData();
      return {
        success: false,
        paymentFailed: true,
        orderData: storedPendingOrder,
        error: error.message,
      };
    }

    // CLIENT-SIDE FLOW: no order placed — send back to checkout
    clearPendingOrderData();
    return { success: false, redirect: '/checkout' };
  } finally {
    removeOverlaySpinner();
  }
}
