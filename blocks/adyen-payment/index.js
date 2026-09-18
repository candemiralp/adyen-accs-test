/* eslint-disable no-console */
/**
 * Adyen Payment Module
 *
 * Main entry point for Adyen payment integration.
 * Handles initialization, checkout instance management, and event coordination.
 *
 * Module structure:
 * - storage.js: localStorage operations
 * - state.js: State management (PaymentResult, PendingOrder, etc.)
 * - config.js: Configuration builders and fetchers
 * - handlers.js: Payment handlers (onSubmit, onAdditionalDetails, etc.)
 */

import { events } from '@dropins/tools/event-bus.js';
import { getStoreConfigCache } from '@dropins/storefront-checkout/api.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { loadCSS } from '../../scripts/aem.js';

import { getAdyenCheckoutFactory, loadAdyenWebSDK } from './utils.js';
import { adyenFetch } from '../../scripts/adyen-auth.js';

import {
  clearCheckoutAttemptId,
  clearPaymentResult,
  clearPendingOrderData,
  setPaymentResult,
  setPaymentResultFetchPromise,
  getPaymentResultFetchPromise,
  setActiveComponent,
  getActiveComponent,
  getCheckoutAttemptId,
  getPaymentResult,
  getPaymentResultSync,
  getPendingOrderData,
  setPendingOrderData,
  getPreviousOrderData,
  setRedirectPaymentCode,
  getRedirectPaymentCode,
  clearRedirectPaymentCode,
  setExtraPaymentParams,
  getExtraPaymentParams,
} from './state.js';

import {
  getBackendIntegrationUrl,
  fetchPublicConfiguration,
  fetchPaymentMethods,
  buildStaticConfig,
  buildBaseConfiguration,
} from './config.js';

import {
  manualSubmit,
  createDefaultOnSubmit,
  createDefaultOnAdditionalDetails,
  createDefaultOnPaymentCompleted,
  waitForOnSubmitResult,
  setHandlePlaceOrderActive,
} from './handlers.js';

import {
  STORAGE_KEYS,
  getJSON,
  setJSON,
  removeItem,
  getWithExpiry,
} from './storage.js';

// ============================================================================
// BROWSER DETECTION & PAYMENT METHOD FILTERING
// ============================================================================

/**
 * Detects if the current browser is Safari
 * @returns {boolean} true if running on Safari
 */
function isSafari() {
  const ua = window.navigator.userAgent;
  // Safari user agent contains "Safari" but not "Chrome", "Firefox", "Edge"
  return /Safari/.test(ua) && !/Chrome|Firefox|Edge|OPR/.test(ua);
}

/**
 * Detects if the current browser supports Google Pay
 * Google Pay is available on Chrome, Edge, and Android browsers,
 * but NOT on Safari or Firefox
 * @returns {boolean} true if running on a browser that supports Google Pay
 */
function isGooglePaySupported() {
  const ua = window.navigator.userAgent;
  // Safari: contains "Safari" but not "Chrome", "Firefox", "Edge"
  const isSafariCheck = /Safari/.test(ua) && !/Chrome|Firefox|Edge|OPR/.test(ua);
  // Firefox
  const isFirefox = /Firefox/.test(ua);

  return !isSafariCheck && !isFirefox;
}

/**
 * Filters payment methods based on browser capabilities.
 * Removes Apple Pay on non-Safari browsers and Google Pay on Safari/Firefox.
 * @param {object} paymentMethodsResponse - The payment methods response from backend
 * @returns {object} Filtered payment methods response
 */
function filterPaymentMethodsByBrowser(paymentMethodsResponse) {
  if (!paymentMethodsResponse || !paymentMethodsResponse.paymentMethods) {
    return paymentMethodsResponse;
  }

  const safariSupport = isSafari();
  const googlePaySupport = isGooglePaySupported();

  console.debug('[ADYEN-PAYMENT] Filtering payment methods', {
    isSafari: safariSupport,
    googlePaySupported: googlePaySupport,
    originalCount: paymentMethodsResponse.paymentMethods.length,
    originalTypes: paymentMethodsResponse.paymentMethods.map((pm) => pm.type),
  });

  // Filter out unsupported payment methods
  const filtered = {
    ...paymentMethodsResponse,
    paymentMethods: paymentMethodsResponse.paymentMethods.filter((pm) => {
      // Remove Apple Pay on non-Safari
      if (pm.type === 'applepay' && !safariSupport) {
        console.debug('[ADYEN-PAYMENT] Filtering out Apple Pay (not Safari)');
        return false;
      }
      // Remove Google Pay on Safari/Firefox
      if (pm.type === 'googlepay' && !googlePaySupport) {
        console.debug('[ADYEN-PAYMENT] Filtering out Google Pay (Safari/Firefox)');
        return false;
      }
      return true;
    }),
  };

  console.debug('[ADYEN-PAYMENT] Filtered payment methods', {
    filteredCount: filtered.paymentMethods.length,
    filteredTypes: filtered.paymentMethods.map((pm) => pm.type),
  });
  console.debug('[ADYEN-PAYMENT] Filtered response object:', filtered);

  return filtered;
}

// Re-export state management functions
export {
  setPaymentResult,
  getPaymentResult,
  getPaymentResultSync,
  clearPaymentResult,
  setPendingOrderData,
  getPendingOrderData,
  clearPendingOrderData,
  setActiveComponent,
  getActiveComponent,
  getCheckoutAttemptId,
  clearCheckoutAttemptId,
  setPaymentResultFetchPromise,
  getPreviousOrderData, // deprecated, use getPaymentResult instead
  setRedirectPaymentCode,
  getRedirectPaymentCode,
  clearRedirectPaymentCode,
  setExtraPaymentParams,
  getExtraPaymentParams,
};

// Re-export handler utilities
export { waitForOnSubmitResult, setHandlePlaceOrderActive };

// Re-export config functions
export {
  getBackendIntegrationUrl,
  fetchPublicConfiguration,
  fetchPaymentMethods,
  buildStaticConfig,
  buildBaseConfiguration,
};

// Re-export handlers
export {
  manualSubmit,
  createDefaultOnSubmit,
  createDefaultOnAdditionalDetails,
  createDefaultOnPaymentCompleted,
};

// ============================================================================
// MODULE STATE
// ============================================================================

let checkoutData = null;
let cartData = null;
let configuration = null;
let publicConfig = null;
let staticConfig = null;
let AdyenCheckoutInstance = null;
let scope;
let isUserAuthenticated = false; // Track authenticated status from auth/authenticated event

/** @returns {Object|null} The current cart data (populated after cart/data event) */
export const getCartDataSnapshot = () => cartData;

/** @returns {Object|null} The current checkout data (populated after checkout/initialized event) */
export const getCheckoutDataSnapshot = () => checkoutData;

/** @returns {string} The current store view scope code */
export const getScopeCode = () => scope || '';

// Track initialization state
let initPromise = null;
let initResolver = null;
let initState = 'idle'; // 'idle' | 'waiting' | 'pending' | 'succeeded' | 'failed'
let lastInitError = null;

// Track last values that influence paymentMethods
let lastCountryCode = null;
let lastAmount = null;
let lastShopperEmail = null;
let cachedPaymentMethods = null; // Cache payment methods response
// Key: `${countryCode}|${amount}|${shopperEmail}` to detect cache invalidation
let cachedPaymentMethodsKey = null;
// Promise for in-flight request to deduplicate concurrent calls
let pendingPaymentMethodsRequest = null;

// Callback for checkout instance updates
let beforeCheckoutUpdateCallback = null;

// Callback invoked when cart recovery starts after a 3DS2 payment failure,
// before the redirect to /checkout. Registered externally via setRecoveryStartCallback.
let recoveryStartCallback = null;

// Debounce for data updates
const DATA_UPDATE_DEBOUNCE_MS = 1200;
let updateDebounceTimer = null;
let isUpdating = false;
// Set to true when handleDataUpdate is called while isUpdating is true so that
// the trailing update is not silently dropped — updateCheckoutInstance re-runs
// once the in-flight request completes.
let pendingUpdate = false;

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Triggers the Place Order button click.
 */
export function triggerPlaceOrder() {
  console.info('[triggerPlaceOrder] Called - attempting to find and click place-order button');
  console.info('[triggerPlaceOrder] Stack trace:');
  console.debug('Stack trace');

  const placeOrderButton = document.querySelector(
    '.checkout__place-order button',
  );
  if (placeOrderButton) {
    console.info('[triggerPlaceOrder] Button found, clicking it');
    placeOrderButton.click();
  } else {
    console.error('[triggerPlaceOrder] Place Order button not found');
  }
}

/**
 * Mount the Adyen native 3DS component in a modal overlay.
 * Uses the existing AdyenCheckout singleton — does NOT create a new instance.
 *
 * @param {Object} action - The threeDS2 action object from order-result
 * @param {Object} _orderData - Reserved for future use
 * @param {Object} [options]
 * @param {Function} [options.onDismiss] - Called when the user closes the modal
 * @param {Function} [options.onMounted] - Called immediately after the overlay is appended to DOM
 */
export async function mountNative3DSComponent(
  action,
  _orderData,
  options = {},
) {
  const { onDismiss, onComplete, onMounted } = options;

  // Guard against duplicate overlays — call prior teardown if one exists
  const existing = document.querySelector('.adyen-3ds-overlay');
  if (existing?.__teardown) existing.__teardown();
  else if (existing) existing.parentNode?.removeChild(existing);

  // Build modal DOM
  const overlay = document.createElement('div');
  overlay.className = 'adyen-3ds-overlay';

  const modal = document.createElement('div');
  modal.className = 'adyen-3ds-modal';

  // Fix 4: ARIA attributes for the modal div
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', '3D Secure verification');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'adyen-3ds-modal__close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close 3D Secure verification');
  closeBtn.textContent = '✕';

  const container = document.createElement('div');
  container.id = 'adyen-3ds-container';

  modal.appendChild(closeBtn);
  modal.appendChild(container);
  overlay.appendChild(modal);

  // Capture overflow before appending to DOM and before locking scroll
  const previousOverflow = document.body.style.overflow;

  // Store teardown on the element BEFORE appending to the DOM so that
  // onAdditionalDetails (which queries .adyen-3ds-overlay) always finds a
  // valid __teardown reference — even if the fingerprint step completes
  // silently during the subsequent await loadCSS / getAdyenCheckout calls.
  function teardown() {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    document.body.style.overflow = previousOverflow;
    // Resume any checkout instance updates that were deferred while the
    // 3DS2 modal was active (e.g. cart/data or checkout/values events that
    // fired during the challenge and were skipped by the guard above).
    handleDataUpdate();
  }

  overlay.__teardown = teardown;
  // Store onComplete so createDefaultOnAdditionalDetails can signal pre-auth success
  overlay.__onComplete = typeof onComplete === 'function' ? onComplete : null;

  document.body.style.overflow = 'hidden';

  // Load CSS explicitly — adyen-payment block is never decorated on the
  // checkout page, so its stylesheet is never auto-loaded by AEM EDS.
  await loadCSS(
    `${window.hlx.codeBasePath}/blocks/adyen-payment/adyen-payment.css`,
  );

  document.body.appendChild(overlay);

  // Notify caller that the overlay is now in the DOM — used to remove the
  // checkout spinner at the exact moment the modal becomes visible, so there
  // is no bare-page flash between spinner teardown and modal appearance.
  if (typeof onMounted === 'function') onMounted();

  closeBtn.addEventListener('click', () => {
    teardown();
    clearPendingOrderData();
    if (typeof onDismiss === 'function') onDismiss();
  });

  // Fix 1: Wrap mount in try/catch to avoid orphaned overlay on error
  try {
    const checkout = await getAdyenCheckout();
    checkout.createFromAction(action).mount(container);
  } catch (err) {
    teardown();
    throw err;
  }

  // Fix 2: Return teardown so the caller can clean up on the success path
  return teardown;
}

/**
 * Start fetching order result from the backend (non-blocking).
 * Use `await getPaymentResult()` to wait for the result if needed.
 *
 * @param {string} incrementId - The order increment ID
 * @param {string} email - The customer email
 * @param {string} [passedCartId] - Optional cartId. If not provided, fetches from sessionStorage.
 * @param {string} [orderToken] - The Commerce order token (`orderV2.token` from placeOrder).
 *   Proves the caller owns this specific order, so a guest read is no longer gated only by
 *   knowing incrementId + email. Absent for logged-in customers, who the backend binds to their
 *   account instead. Same anchor already sent to recover-cart.
 */
export function fetchOrderResult(incrementId, email, passedCartId, orderToken) {
  const fetchPromise = (async () => {
    const backendUrl = getBackendIntegrationUrl(checkoutData);
    const endpoint = `${backendUrl.replace(/\/$/, '')}/order-result`;
    // Use passed cartId if provided, otherwise get from sessionStorage.
    // Note: passedCartId should be provided when called from handleOrderPlaced,
    // since cart/reset has already cleared sessionStorage by that point.
    // We can't rely on paymentResultData.cartId because it's only populated
    // from a previous order attempt, not the current one.
    const cartId = passedCartId || sessionStorage.getItem('DROPINS_CART_ID');

    console.info('[fetchOrderResult] Starting fetch with:', {
      incrementId,
      email,
      cartId,
      passedCartId,
      hasOrderToken: !!orderToken,
      endpoint,
    });

    const response = await adyenFetch(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incrementId,
          customerEmail: email,
          cartId,
          // Omitted rather than sent empty when absent: the backend treats a supplied token as a
          // claim it must verify, so an empty string would be a claim that can never resolve.
          ...(orderToken && { orderToken }),
        }),
      },
      { backendUrl, cartId, isGuest: checkoutData.isGuest },
    );

    const result = await response.json();

    console.info('[fetchOrderResult] Response received:', {
      resultCode: result.resultCode,
      pspReference: result.pspReference,
      newCartId: result.newCartId,
      hasAction: !!result.action,
      responseKeys: Object.keys(result),
    });

    setPaymentResult({
      pspReference: result.pspReference,
      merchantReference: result.merchantReference,
      paymentMethod: result.paymentMethod,
      donationToken: result.donationToken,
      action: result.action,
      resultCode: result.resultCode,
      ...(cartId && { cartId }),
      ...(result.newCartId && { newCartId: result.newCartId }),
    });

    return result;
  })();

  setPaymentResultFetchPromise(fetchPromise);

  // Clean up the promise reference when done
  fetchPromise.finally(() => {
    if (getPaymentResultFetchPromise() === fetchPromise) {
      setPaymentResultFetchPromise(null);
    }
  });
}

/**
 * Call the backend recover-cart endpoint to create a new Commerce cart after
 * a payment failure.  Updates the stored payment result with the new cartId.
 *
 * Only call this when `getPaymentResult()` returns a failure resultCode
 * (Refused, Error, Cancelled) AND the result does not already contain a newCartId.
 *
 * @param {string} incrementId - The order increment ID
 * @param {string} email - The customer email
 * @param {string} [resultCode] - The Adyen result code known to the frontend
 *   (e.g. 'Refused', 'Error', 'Cancelled'). Forwarded to the backend so it can
 *   trust the frontend's authoritative result from /payments/details rather than
 *   re-querying its own store (which may still hold a stale intermediate 3DS2
 *   result code such as 'IdentifyShopper' if the Adyen webhook has not yet arrived).
 * @param {Object} [extra] - Additional fields forwarded to the backend
 * @param {string} [extra.orderToken] - Guest order token (for server-side cancel)
 * @param {string|number} [extra.orderId] - Magento order ID (for server-side cancel)
 * @param {string} [extra.comment] - Human-readable comment to add to the order
 * @returns {Promise<string|null>} The new cart ID, or null if recovery failed
 */
export async function recoverCart(incrementId, email, resultCode, extra = {}) {
  const backendUrl = getBackendIntegrationUrl(checkoutData);
  const endpoint = `${backendUrl.replace(/\/$/, '')}/recover-cart`;

  const { orderToken, orderId, comment } = extra;

  console.info('[recoverCart] Starting recovery with:', {
    incrementId,
    email,
    resultCode,
    orderId,
    orderToken,
    endpoint,
  });

  try {
    // Get the cartId from payment result (stored during order submission)
    const paymentResultData = getPaymentResultSync() || {};
    const response = await adyenFetch(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incrementId,
          customerEmail: email,
          // The cart that produced the order — the backend verifies the guest token against
          // this and requires the cart to be the one that produced incrementId.
          ...(paymentResultData.cartId && { cartId: paymentResultData.cartId }),
          ...(resultCode && { resultCode }),
          ...(orderToken && { orderToken }),
          ...(orderId && { orderId }),
          ...(comment && { comment }),
        }),
      },
      {
        backendUrl,
        cartId: paymentResultData.cartId,
        isGuest: checkoutData.isGuest,
      },
    );

    if (!response.ok) {
      console.error(`[recoverCart] recover-cart failed with status ${response.status}`);
      return null;
    }

    const data = await response.json();

    const newCartId = data?.newCartId || null;

    console.info('[recoverCart] Recovery response:', {
      newCartId,
      responseKeys: Object.keys(data),
    });

    if (newCartId) {
      console.info('[recoverCart] Setting new cart ID:', newCartId);
      // Merge newCartId into the stored payment result so checkout retry
      // flow can use it.
      const currentResult = getPaymentResultSync();
      setPaymentResult({ ...currentResult, newCartId });

      // The backend always creates a guest cart (masked token) regardless of whether
      // the original order was placed as guest or authenticated customer.
      //
      // For authenticated users the dropin merge flow handles everything:
      //   1. localStorage.DROPIN__CART__CART__AUTHENTICATED is cleared by cart/reset
      //   2. We write the masked token to the cookie
      //   3. On /checkout, auth dropin fires authenticated:true → dropin calls Q()
      //      (authenticated path): creates a new customerCart, sees cookie !== new cart id
      //      → triggers mergeCarts(masked token → customer cart) → items merged ✅
      //
      // For guests the dropin reads the cookie directly and uses it as the cart token.
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);
      document.cookie = `DROPIN__CART__CART-ID=${newCartId}; expires=${expires.toUTCString()}; path=/`;
    }

    return newCartId;
  } catch (err) {
    console.error('[recoverCart] Recovery error:', err);
    return null;
  }
}

/**
 * Call the backend pre-auth-payments endpoint to perform authentication-only
 * 3DS2 verification before placing a Magento order.
 *
 * @param {Object} componentData - The Adyen component's .data (paymentMethod, browserInfo, etc.)
 * @param {Object} cart - Current cart data (id, total, items)
 * @param {Object} checkout - Current checkout data (email, billingAddress, etc.)
 * @param {string} [scopeCode] - Store view code
 * @returns {Promise<Object>} Adyen response { resultCode, action?, pspReference }
 */
export async function fetchPreAuthPayment(
  componentData,
  cart,
  checkout,
  scopeCode,
) {
  console.debug('[FRONTEND-TRACE] fetchPreAuthPayment called with checkout data:', {
    checkoutKeys: Object.keys(checkout),
    checkoutEmail: checkout.email,
    checkoutIsGuest: checkout.isGuest,
    checkoutData: checkout,
    cartId: cart?.id,
    cartTotal: cart?.total,
  });

  const backendUrl = getBackendIntegrationUrl(checkout);
  const endpoint = `${backendUrl.replace(/\/$/, '')}/pre-auth-payments`;

  const amount = {
    value: Math.round((cart.total?.includingTax?.value || 0) * 100),
    currency: cart.total?.includingTax?.currency || 'USD',
  };

  const billingAddress = checkout.billingAddress
    ? {
      country:
          checkout.billingAddress.country?.code
          || checkout.billingAddress.country
          || '',
      street: checkout.billingAddress.street?.[0] || '',
      city: checkout.billingAddress.city || '',
      stateOrProvince:
          checkout.billingAddress.region?.code
          || checkout.billingAddress.region
          || '',
      postalCode: checkout.billingAddress.postcode || '',
      houseNumberOrName: '',
    }
    : undefined;

  const deliveryAddress = checkout.shippingAddress
    ? {
      country:
          checkout.shippingAddress.country?.code
          || checkout.shippingAddress.country
          || '',
      street: checkout.shippingAddress.street?.[0] || '',
      city: checkout.shippingAddress.city || '',
      stateOrProvince:
          checkout.shippingAddress.region?.code
          || checkout.shippingAddress.region
          || '',
      postalCode: checkout.shippingAddress.postcode || '',
      houseNumberOrName: '',
    }
    : undefined;

  const shopperName = checkout.billingAddress?.firstname && checkout.billingAddress?.lastname
    ? {
      firstName: checkout.billingAddress.firstname,
      lastName: checkout.billingAddress.lastname,
    }
    : undefined;

  const paymentRequest = {
    ...componentData,
    amount,
    reference: cart.id,
    shopperEmail: checkout.email,
    shopperName,
    shopperLocale:
      checkout.locale
      || (navigator.language?.startsWith('en-') ? 'en-US' : navigator.language)
      || 'en-US',
    billingAddress,
    deliveryAddress,
    origin: window.location.origin,
    countryCode: billingAddress?.country,
  };

  const requestBody = {
    paymentRequest,
    cartId: cart.id,
    isGuest: String(checkout.isGuest ?? true),
    scope: scopeCode || '',
  };

  console.debug('[FRONTEND-TRACE] About to send pre-auth-payments request:', {
    endpoint,
    requestBody,
    paymentRequestKeys: Object.keys(paymentRequest),
    paymentRequest,
  });

  const response = await adyenFetch(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
    { backendUrl, cartId: cart.id, isGuest: checkout.isGuest ?? true },
  );

  if (!response.ok) {
    throw new Error(`pre-auth-payments failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Save a serializable snapshot of the current instance state to localStorage.
 * Allows restoring the Adyen checkout instance later without cartData or checkoutData.
 */
export function saveInstanceSnapshot() {
  if (!configuration || !publicConfig || !staticConfig) return;
  const snapshot = {
    publicConfig,
    staticConfig,
    scope,
    paymentMethodsResponse: configuration.paymentMethodsResponse,
    amount: configuration.amount,
    lastCountryCode,
    lastAmount,
    lastShopperEmail,
  };
  setJSON(STORAGE_KEYS.INSTANCE_SNAPSHOT, snapshot);
}

/**
 * Remove the stored instance snapshot from localStorage.
 */
export function clearInstanceSnapshot() {
  removeItem(STORAGE_KEYS.INSTANCE_SNAPSHOT);
}

/**
 * Restore the Adyen checkout instance from a previously saved snapshot.
 * Does not require cartData or checkoutData to be available.
 * @returns {Promise<boolean>} true if restored successfully, false if no snapshot found
 */
export async function restoreFromSnapshot() {
  const snapshot = getJSON(STORAGE_KEYS.INSTANCE_SNAPSHOT);
  if (!snapshot?.publicConfig || !snapshot?.paymentMethodsResponse) return false;

  publicConfig = snapshot.publicConfig;
  staticConfig = snapshot.staticConfig;
  scope = snapshot.scope;
  lastCountryCode = snapshot.lastCountryCode;
  lastAmount = snapshot.lastAmount;
  lastShopperEmail = snapshot.lastShopperEmail;

  await loadAdyenSDK(publicConfig.environment);

  // Build configuration directly — no cartData/checkoutData needed
  // Filter payment methods based on browser capabilities before restoring
  const filteredSnapshot = filterPaymentMethodsByBrowser(snapshot.paymentMethodsResponse);

  configuration = {
    ...snapshot.staticConfig,
    paymentMethodsResponse: filteredSnapshot,
    amount: snapshot.amount,
    onSubmit: () => {},
    onAdditionalDetails: () => {},
    onPaymentCompleted: () => {},
    onPaymentFailed: () => {},
    onError: () => {},
  };

  const AdyenCheckoutFactory = getAdyenCheckoutFactory();
  AdyenCheckoutInstance = await AdyenCheckoutFactory(configuration);

  initState = 'succeeded';
  if (!initPromise) {
    initPromise = Promise.resolve();
  }
  if (initResolver) {
    initResolver();
    initResolver = null;
  }

  return true;
}

/**
 * Get AdyenCheckout instance (singleton).
 * @returns {Promise<Object>}
 */
export async function getAdyenCheckout() {
  await ensureInitialized();

  if (!AdyenCheckoutInstance) {
    throw new Error('AdyenCheckout instance not initialized');
  }

  return AdyenCheckoutInstance;
}

/**
 * Get Adyen public configuration.
 * @returns {Promise<Object>}
 */
export async function getAdyenConfiguration() {
  await ensureInitialized();
  return configuration;
}

/**
 * Get the raw public configuration fetched from the backend (includes ACH settings etc.).
 * Used by the ACH block to read achMerchantName and achMandateText.
 * @returns {Promise<Object>}
 */
export async function getAdyenPublicConfig() {
  await ensureInitialized();
  return publicConfig;
}

/**
 * Check if customer is logged in.
 * @returns {Promise<boolean>}
 */
export async function isCustomerLoggedIn() {
  await ensureInitialized();
  return !checkoutData.isGuest;
}

/**
 * Get the backend integration URL for the current checkout context.
 * Used by payment method blocks that need to call backend endpoints directly.
 * @returns {Promise<string>}
 */
export async function getAdyenBackendUrl() {
  await ensureInitialized();
  return getBackendIntegrationUrl(checkoutData);
}

/**
 * Get the shopper email and scope for the current checkout session.
 * Used by payment method blocks that call stored-payment-methods directly.
 * Note: isGuest status is passed separately to API calls, not via this context object.
 * @returns {Promise<{shopperEmail: string, scope: string}>}
 */
export async function getAdyenShopperContext() {
  // NOTE: Do NOT call ensureInitialized() here - it would create a circular dependency
  // during initialization. checkoutData and scope are set by the main checkout
  // before initialization begins, so they're always available at this point.
  return {
    shopperEmail: checkoutData.email || '',
    scope: scope || '',
  };
}

/**
 * Register a callback to be invoked before the checkout instance is updated.
 * @param {Function|null} callback - Async function returning boolean, or null to unregister
 * @returns {Function} Unregister function
 */
export function registerBeforeCheckoutUpdate(callback) {
  beforeCheckoutUpdateCallback = callback;

  return () => {
    if (beforeCheckoutUpdateCallback === callback) {
      beforeCheckoutUpdateCallback = null;
    }
  };
}

/**
 * Register a callback to be invoked when cart recovery starts after a 3DS2
 * payment failure, immediately before the redirect to /checkout. Use this to
 * show a loading spinner while the recovery request is in flight.
 *
 * @param {Function|null} callback - Called with no arguments when recovery begins
 * @returns {Function} Unregister function
 */
export function setRecoveryStartCallback(callback) {
  recoveryStartCallback = callback;
  return () => {
    if (recoveryStartCallback === callback) {
      recoveryStartCallback = null;
    }
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Check if we can determine a country code.
 * Country code is required for Adyen checkout initialization.
 * Priority: checkout addresses > cached public config > store default country
 * @returns {boolean}
 */
function hasCountryCode() {
  // Check checkout addresses (highest priority - user's actual location)
  const billingCountry = checkoutData?.billingAddress?.country?.code
    || checkoutData?.billingAddress?.country;
  const shippingCountry = checkoutData?.shippingAddress?.country?.code
    || checkoutData?.shippingAddress?.country;

  if (billingCountry || shippingCountry) {
    return true;
  }

  // Check cached public config for backend default
  const cachedConfig = getWithExpiry(STORAGE_KEYS.PUBLIC_CONFIG);
  if (
    cachedConfig
    && !cachedConfig.expired
    && cachedConfig.value?.countryCode
  ) {
    return true;
  }

  // Fallback to store default country from Adobe Commerce config
  const storeConfig = getStoreConfigCache();
  if (storeConfig?.defaultCountry) {
    return true;
  }

  return false;
}

function hasMinimumData() {
  const hasCheckoutData = checkoutData && checkoutData.availablePaymentMethods;
  const hasCartData = cartData && cartData.id;
  return hasCheckoutData && hasCartData && hasCountryCode();
}

async function loadAdyenSDK(environment) {
  console.debug('[ADYEN-PAYMENT] loadAdyenSDK called, environment:', environment);
  const AdyenCheckoutFactory = getAdyenCheckoutFactory();
  console.debug(
    '[ADYEN-PAYMENT] AdyenCheckoutFactory available:',
    !!AdyenCheckoutFactory,
  );
  if (!AdyenCheckoutFactory) {
    console.debug('[ADYEN-PAYMENT] Loading Adyen Web SDK...');
    await loadAdyenWebSDK(environment);
    console.debug('[ADYEN-PAYMENT] Adyen Web SDK loaded');
  }
}

function scheduleInit() {
  if (!initPromise) {
    initPromise = new Promise((resolve) => {
      initResolver = resolve;
    });
    initState = 'waiting';
  }
  return initPromise;
}

/**
 * Build a cache key for payment methods based on parameters that affect the result.
 * @param {string} countryCode
 * @param {number} amount
 * @param {string} shopperEmail
 * @returns {string}
 */
function buildPaymentMethodsCacheKey(countryCode, amount, shopperEmail) {
  return `${countryCode}|${amount}|${shopperEmail || ''}`;
}

async function tryInitialize() {
  console.debug('[ADYEN-PAYMENT] tryInitialize called, initState:', initState);
  if (initState === 'succeeded' || initState === 'pending') {
    console.debug('[ADYEN-PAYMENT] Already initialized or pending, returning');
    return;
  }

  if (!hasMinimumData()) {
    console.debug('[ADYEN-PAYMENT] Minimum data not available, scheduling init');
    if (initState === 'idle') {
      scheduleInit();
    }
    return;
  }

  initState = 'pending';
  console.debug(
    '[ADYEN-PAYMENT] Minimum data available, starting initialization',
  );

  try {
    // Clear cached checkout instance
    clearInstanceSnapshot();

    // Get scope from store config
    const storeConfig = getStoreConfigCache();
    scope = storeConfig?.code
      || (await getConfigValue('headers.cs.Magento-Store-View-Code'));

    // Get backend URL and fetch public config
    const backendUrl = getBackendIntegrationUrl(checkoutData);
    const shopperId = checkoutData?.email || checkoutData?.shopperId;
    const { isGuest } = checkoutData;
    console.debug('[ADYEN-PAYMENT] Fetching public configuration...');
    publicConfig = await fetchPublicConfiguration(
      backendUrl,
      scope,
      shopperId,
      isGuest,
    );
    console.debug(
      '[ADYEN-PAYMENT] Public config received, environment:',
      publicConfig.environment,
    );

    // Load Adyen Web SDK
    console.debug('[ADYEN-PAYMENT] Loading Adyen SDK...');
    await loadAdyenSDK(publicConfig.environment);
    console.debug(
      '[ADYEN-PAYMENT] SDK loaded, window.AdyenWeb:',
      !!window.AdyenWeb,
    );

    // Build static config (pass checkoutData for country code fallback)
    console.debug('[ADYEN-PAYMENT] Building static config...');
    staticConfig = buildStaticConfig(publicConfig, checkoutData);
    console.debug('[ADYEN-PAYMENT] Static config built:', {
      countryCode: staticConfig.countryCode,
    });

    // Get shopper context (email, isGuest, scope)
    console.debug('[ADYEN-PAYMENT] Getting shopper context...');
    const shopperContext = await getAdyenShopperContext();
    console.debug('[Adyen] Shopper context:', {
      hasEmail: !!shopperContext.shopperEmail,
      isGuest: checkoutData.isGuest,
      cartId: cartData?.id,
    });
    console.debug('[ADYEN-PAYMENT] Shopper context obtained');

    // Build cache key for payment methods
    console.debug('[ADYEN-PAYMENT] Building payment methods cache key...');
    const amount = Math.round((cartData.total?.includingTax?.value || 0) * 100);
    const paymentMethodsCacheKey = buildPaymentMethodsCacheKey(
      staticConfig.countryCode,
      amount,
      shopperContext.shopperEmail,
    );

    console.debug('[Adyen] Payment methods cache key:', paymentMethodsCacheKey);

    // Check if we have cached result
    if (
      cachedPaymentMethods
      && cachedPaymentMethodsKey === paymentMethodsCacheKey
    ) {
      console.debug('[Adyen] Using cached payment methods');
    } else if (pendingPaymentMethodsRequest) {
      // Deduplicate in-flight request
      console.debug('[Adyen] Deduplicating in-flight payment methods request');
    } else {
      // Fetch fresh payment methods
      console.debug('[Adyen] Fetching fresh payment methods');
      pendingPaymentMethodsRequest = fetchPaymentMethods(
        backendUrl,
        {
          countryCode: staticConfig.countryCode,
          amount: {
            value: amount,
            currency: cartData.total?.includingTax?.currency || 'USD',
          },
          ...shopperContext,
        },
        shopperId,
        checkoutData.isGuest,
      )
        .then((result) => {
          console.debug(
            '[Adyen] Payment methods fetched successfully:',
            Object.keys(result),
          );
          cachedPaymentMethods = result;
          cachedPaymentMethodsKey = paymentMethodsCacheKey;
          pendingPaymentMethodsRequest = null;
          return result;
        })
        .catch((error) => {
          console.debug('[Adyen] Payment methods fetch failed:', error);
          pendingPaymentMethodsRequest = null;
          throw error;
        });
    }

    console.debug('[ADYEN-PAYMENT] Awaiting payment methods...');
    const paymentMethods = await (pendingPaymentMethodsRequest
      || Promise.resolve(cachedPaymentMethods));
    console.debug(
      '[ADYEN-PAYMENT] Payment methods resolved, building configuration...',
    );

    // Track values for change detection
    lastCountryCode = staticConfig.countryCode;
    lastAmount = amount;
    lastShopperEmail = shopperContext.shopperEmail;

    // Build full configuration
    console.debug('[ADYEN-PAYMENT] Building base configuration...');

    // Filter payment methods based on browser capabilities
    const filteredPaymentMethods = filterPaymentMethodsByBrowser(paymentMethods);

    configuration = buildBaseConfiguration({
      publicCfg: publicConfig,
      checkoutData,
      cartData,
      paymentMethods: filteredPaymentMethods,
      onSubmit: createDefaultOnSubmit(
        backendUrl,
        () => cartData,
        () => checkoutData,
        scope,
      ),
      onAdditionalDetails: createDefaultOnAdditionalDetails(
        backendUrl,
        () => cartData,
        recoverCart,
        {
          onRecoveryStart: recoveryStartCallback
            ? () => recoveryStartCallback()
            : undefined,
          getCheckoutData: () => checkoutData,
        },
      ),
      onPaymentCompleted: createDefaultOnPaymentCompleted(
        backendUrl,
        () => cartData,
        {
          recoverCartFn: recoverCart,
          getCheckoutData: () => checkoutData,
        },
      ),
      onPaymentFailed: (result) => {
        console.debug('Payment failed:', result);
        // If a pre-auth 3DS2 modal is open, close it and signal failure to the
        // waiting handlePlaceOrder Promise.  The SDK fires onPaymentFailed
        // (instead of onAdditionalDetails) when the challenge is refused by
        // the bank, so without this the overlay would stay open indefinitely.
        const overlay3ds = document.querySelector('.adyen-3ds-overlay');
        if (overlay3ds?.__onComplete) {
          const cb = overlay3ds.__onComplete;
          overlay3ds.__onComplete = null;
          overlay3ds.__teardown?.();
          cb({ resultCode: result?.resultCode || 'Refused' });
        }
        // Post-order 3DS2 refusals are already fully handled by onAdditionalDetails
        // (modal closed, error shown, pendingOrderData cleared).  The SDK fires
        // onPaymentFailed as well, but calling component.props.onError here would
        // produce a second error banner in the wrong place (card block container).
        // Card-level failures (no overlay ever) are handled by the card component's
        // own onPaymentFailed / onError options set in adyen-payment-cards.js.
      },
      onError: (error) => {
        console.error('Adyen error:', error);
      },
    });

    console.debug('[ADYEN-PAYMENT] Configuration built successfully');
    console.debug('[ADYEN-PAYMENT] Configuration paymentMethodsResponse:', {
      hasPaymentMethods: !!configuration.paymentMethodsResponse?.paymentMethods,
      count: configuration.paymentMethodsResponse?.paymentMethods?.length,
      types: configuration.paymentMethodsResponse?.paymentMethods?.map((pm) => pm.type),
    });
    // Create Adyen Checkout instance
    console.debug('[ADYEN-PAYMENT] Creating AdyenCheckout instance...');
    const AdyenCheckoutFactory = getAdyenCheckoutFactory();
    console.debug(
      '[ADYEN-PAYMENT] AdyenCheckoutFactory available:',
      !!AdyenCheckoutFactory,
    );
    AdyenCheckoutInstance = await AdyenCheckoutFactory(configuration);
    console.debug('[ADYEN-PAYMENT] AdyenCheckout instance created successfully');
    console.debug('[ADYEN-PAYMENT] AdyenCheckout instance paymentMethods:', {
      hasPaymentMethods: !!AdyenCheckoutInstance?.paymentMethods,
      count: AdyenCheckoutInstance?.paymentMethods?.length,
      types: AdyenCheckoutInstance?.paymentMethods?.map((pm) => pm.type),
    });

    initState = 'succeeded';
    console.debug('[ADYEN-PAYMENT] initState set to succeeded');

    if (initResolver) {
      console.debug('[ADYEN-PAYMENT] Calling initResolver...');
      initResolver();
      initResolver = null;
    }
  } catch (error) {
    console.debug('[ADYEN-PAYMENT] Adyen initialization failed:', error);
    initState = 'failed';
    lastInitError = error;

    if (initResolver) {
      initResolver();
      initResolver = null;
    }
  }
}

async function ensureInitialized() {
  console.debug(
    '[ADYEN-PAYMENT] ensureInitialized called, initState:',
    initState,
  );
  await scheduleInit();
  console.debug('[ADYEN-PAYMENT] After scheduleInit, initState:', initState);

  if (initState === 'failed') {
    const baseMessage = 'Adyen initialization failed';
    const details = lastInitError?.message ? `: ${lastInitError.message}` : '';
    throw new Error(`${baseMessage}${details}`);
  }

  if (!configuration || !AdyenCheckoutInstance) {
    console.debug(
      '[ADYEN-PAYMENT] Not ready: configuration:',
      !!configuration,
      'AdyenCheckoutInstance:',
      !!AdyenCheckoutInstance,
    );
    throw new Error('Adyen checkout is not ready yet.');
  }
  console.debug('[ADYEN-PAYMENT] ensureInitialized complete');
}

// ============================================================================
// CHECKOUT INSTANCE UPDATES
// ============================================================================

async function updateCheckoutInstance() {
  if (!AdyenCheckoutInstance || !checkoutData || !cartData) {
    return;
  }

  // Do not update the checkout instance while a 3DS2 modal is active.
  // AdyenCheckoutInstance.update() unmounts all components including the
  // active 3DS challenge, leaving only the modal shell. The teardown in
  // mountNative3DSComponent will call handleDataUpdate() once the overlay
  // is removed so no update is permanently skipped.
  if (document.querySelector('.adyen-3ds-overlay')) {
    return;
  }

  const backendUrl = getBackendIntegrationUrl(checkoutData);

  const paymentButton = document.querySelector('.checkout__place-order button');
  if (paymentButton) {
    if (
      ['adyen_googlepay', 'adyen_applepay', 'adyen_paypal'].includes(
        checkoutData.selectedPaymentMethod.code,
      )
    ) {
      paymentButton.classList.add('checkout__place-order--hidden');
    } else {
      paymentButton.classList.remove('checkout__place-order--hidden');
    }
  }

  // Check if we need to refetch payment methods
  const countryChanged = staticConfig?.countryCode !== lastCountryCode;
  const amountChanged = cartData.total?.includingTax?.value !== lastAmount;
  const emailChanged = checkoutData.email !== lastShopperEmail;

  console.debug('[Adyen] Data change detection:', {
    countryChanged,
    amountChanged,
    emailChanged,
  });

  if (countryChanged || amountChanged || emailChanged) {
    // Check with registered callback if update should proceed
    if (beforeCheckoutUpdateCallback) {
      const shouldProceed = await beforeCheckoutUpdateCallback();
      if (!shouldProceed) {
        return;
      }
    }

    // Get shopper context
    const shopperContext = await getAdyenShopperContext();
    console.debug('[Adyen] Updating payment methods with context:', {
      hasEmail: !!shopperContext.shopperEmail,
      isGuest: checkoutData.isGuest,
    });

    // Build cache key
    const amount = Math.round((cartData.total?.includingTax?.value || 0) * 100);
    const paymentMethodsCacheKey = buildPaymentMethodsCacheKey(
      staticConfig.countryCode,
      amount,
      shopperContext.shopperEmail,
    );

    console.debug('[Adyen] Updated cache key:', paymentMethodsCacheKey);

    // Check cache or deduplicate
    let paymentMethods;
    if (
      cachedPaymentMethods
      && cachedPaymentMethodsKey === paymentMethodsCacheKey
    ) {
      console.debug('[Adyen] Using cached payment methods for update');
      paymentMethods = cachedPaymentMethods;
    } else if (pendingPaymentMethodsRequest) {
      console.debug('[Adyen] Deduplicating in-flight payment methods for update');
      paymentMethods = await pendingPaymentMethodsRequest;
    } else {
      console.debug('[Adyen] Fetching fresh payment methods for update');
      const shopperId = checkoutData?.email || checkoutData?.shopperId;
      pendingPaymentMethodsRequest = fetchPaymentMethods(
        backendUrl,
        {
          countryCode: staticConfig.countryCode,
          amount: {
            value: amount,
            currency: cartData.total?.includingTax?.currency || 'USD',
          },
          ...shopperContext,
        },
        shopperId,
        checkoutData.isGuest,
      )
        .then((result) => {
          console.debug(
            '[Adyen] Payment methods updated successfully:',
            Object.keys(result),
          );
          cachedPaymentMethods = result;
          cachedPaymentMethodsKey = paymentMethodsCacheKey;
          pendingPaymentMethodsRequest = null;
          return result;
        })
        .catch((error) => {
          console.debug('[Adyen] Payment methods update failed:', error);
          pendingPaymentMethodsRequest = null;
          throw error;
        });
      paymentMethods = await pendingPaymentMethodsRequest;
    }

    // Update tracked values
    lastCountryCode = staticConfig.countryCode;
    lastAmount = amount;
    lastShopperEmail = shopperContext.shopperEmail;

    // Rebuild configuration
    configuration = buildBaseConfiguration({
      publicCfg: publicConfig,
      checkoutData,
      cartData,
      paymentMethods,
      onSubmit: createDefaultOnSubmit(
        backendUrl,
        () => cartData,
        () => checkoutData,
        scope,
      ),
      onAdditionalDetails: createDefaultOnAdditionalDetails(
        backendUrl,
        () => cartData,
        recoverCart,
        {
          onRecoveryStart: recoveryStartCallback
            ? () => recoveryStartCallback()
            : undefined,
          getCheckoutData: () => checkoutData,
        },
      ),
      onPaymentCompleted: createDefaultOnPaymentCompleted(
        backendUrl,
        () => cartData,
        {
          recoverCartFn: recoverCart,
          getCheckoutData: () => checkoutData,
        },
      ),
      onPaymentFailed: (result) => {
        console.debug('Payment failed:', result);
        // If a pre-auth 3DS2 modal is open, close it and signal failure to the
        // waiting handlePlaceOrder Promise.  The SDK fires onPaymentFailed
        // (instead of onAdditionalDetails) when the challenge is refused by
        // the bank, so without this the overlay would stay open indefinitely.
        const overlay3ds = document.querySelector('.adyen-3ds-overlay');
        if (overlay3ds?.__onComplete) {
          const cb = overlay3ds.__onComplete;
          overlay3ds.__onComplete = null;
          overlay3ds.__teardown?.();
          cb({ resultCode: result?.resultCode || 'Refused' });
        }
        // Post-order 3DS2 refusals are already fully handled by onAdditionalDetails
        // (modal closed, error shown, pendingOrderData cleared).  The SDK fires
        // onPaymentFailed as well, but calling component.props.onError here would
        // produce a second error banner in the wrong place (card block container).
        // Card-level failures (no overlay ever) are handled by the card component's
        // own onPaymentFailed / onError options set in adyen-payment-cards.js.
      },
      onError: (error) => {
        console.error('Adyen error:', error);
      },
    });

    // Update checkout instance
    await AdyenCheckoutInstance.update(configuration);
  }
}

function handleDataUpdate() {
  if (updateDebounceTimer) {
    clearTimeout(updateDebounceTimer);
  }

  console.debug('[Adyen] Data update triggered, debouncing...');

  updateDebounceTimer = setTimeout(async () => {
    if (isUpdating) {
      // An update arrived while a fetch was in-flight.  Mark it so the
      // running updateCheckoutInstance loop picks it up after it finishes
      // rather than silently dropping it.
      console.debug('[Adyen] Update queued while in-flight update pending');
      pendingUpdate = true;
      return;
    }
    isUpdating = true;
    console.debug('[Adyen] Starting checkout instance update');

    try {
      // Process updates until no further one was queued during our fetch.
      do {
        pendingUpdate = false;
        // eslint-disable-next-line no-await-in-loop
        await updateCheckoutInstance();
      } while (pendingUpdate);
    } catch (error) {
      console.debug('Adyen update failed:', error);
    } finally {
      isUpdating = false;
    }
  }, DATA_UPDATE_DEBOUNCE_MS);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

events.on('checkout/initialized', async (data) => {
  // Use authenticated status from auth/authenticated event
  // Fallback to localStorage check if auth event hasn't fired yet
  const authValue = localStorage.getItem('DROPIN__CART__CART__AUTHENTICATED');
  const isAuthenticated = isUserAuthenticated || authValue === 'true';

  checkoutData = {
    ...data,
    isGuest: !isAuthenticated, // isGuest = false for authenticated users
  };

  console.debug('[FRONTEND-DEBUG] checkout/initialized event received:', {
    type: data.type,
    email: data.email,
    isUserAuthenticated,
    authValue,
    isAuthenticated,
    isGuest: checkoutData.isGuest,
    shopperId: data.shopperId,
    allStorageKeys: Object.keys(localStorage),
    fullData: data,
  });
  if (initState === 'succeeded') {
    handleDataUpdate();
  } else {
    await tryInitialize();
  }
});

events.on('checkout/values', async (data) => {
  // Determine if user is authenticated from localStorage
  const isAuthenticated = localStorage.getItem('DROPIN__CART__CART__AUTHENTICATED') === 'true';

  if (checkoutData) {
    checkoutData = { ...checkoutData, ...data, isGuest: !isAuthenticated };
  } else {
    checkoutData = { ...data, isGuest: !isAuthenticated };
  }
  if (initState === 'succeeded') {
    handleDataUpdate();
  } else {
    await tryInitialize();
  }
});

events.on('checkout/updated', (data) => {
  // Determine if user is authenticated from localStorage
  const isAuthenticated = localStorage.getItem('DROPIN__CART__CART__AUTHENTICATED') === 'true';

  checkoutData = { ...data, isGuest: !isAuthenticated };
  handleDataUpdate();
});

events.on('cart/data', async (cart) => {
  cartData = cart;
  if (initState === 'succeeded') {
    handleDataUpdate();
  } else {
    await tryInitialize();
  }
});

events.on('cart/reset', (cart) => {
  // Clear checkout attempt IDs when cart is reset
  if (cart?.id) {
    clearCheckoutAttemptId(cart.id);
  }
  if (cartData?.id && cartData.id !== cart?.id) {
    clearCheckoutAttemptId(cartData.id);
  }
  // Clear payment data from previous checkout attempt.
  // NOTE: Do NOT clear pendingOrderData here — it is set immediately after
  // placeOrder and must survive the cart/reset event that placeOrder fires.
  // pendingOrderData is consumed (and cleared) by onAdditionalDetails on
  // the server-side 3DS2 path, and cleared by onDismiss if the user cancels.
  clearPaymentResult();
});

events.on('authenticated', (isAuthenticated) => {
  isUserAuthenticated = Boolean(isAuthenticated);
  // Set global auth state for cross-block access (e.g., express payment blocks)
  window.__ADYEN_AUTH_STATE__ = { isAuthenticated: isUserAuthenticated };
  console.debug(
    '[AUTH-STATE-SET] authenticated event received, setting __ADYEN_AUTH_STATE__:',
    {
      isAuthenticated: isUserAuthenticated,
      timestamp: new Date().toISOString(),
      stackTrace: new Error().stack,
    },
  );
  // If checkout is already initialized, update isGuest based on new auth state
  if (checkoutData) {
    checkoutData = { ...checkoutData, isGuest: !isUserAuthenticated };
    console.debug(
      '[FRONTEND-DEBUG] Updated checkoutData.isGuest based on authenticated event:',
      {
        isGuest: checkoutData.isGuest,
      },
    );
  }
});

events.on('order/placed', () => {
  // Clear checkout attempt ID when order is successfully placed
  if (cartData?.id) {
    clearCheckoutAttemptId(cartData.id);
  }
  // Note: Don't clear pendingOrderData here - it's needed for redirect flows
});
