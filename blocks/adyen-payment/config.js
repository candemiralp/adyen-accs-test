/**
 * Adyen Configuration Module
 *
 * Handles fetching and building Adyen checkout configuration.
 */

import { getStoreConfigCache } from '@dropins/storefront-checkout/api.js';
import { fetchGraphQl } from '@dropins/storefront-cart/api.js';

import { events } from '@dropins/tools/event-bus.js';
import {
  STORAGE_KEYS,
  STORAGE_TTL,
  removeItem,
  getWithExpiry,
  setWithExpiry,
} from './storage.js';
import { formatAmount } from './utils.js';
import { adyenFetch } from '../../scripts/adyen-auth.js';

/**
 * Fallback backend URL used when Commerce SaaS does not surface OOPE payment
 * methods on the cart (e.g. no shipping method set yet, or sandbox config gap).
 * This is the known App Builder runtime endpoint for this project.
 */
const ADYEN_BACKEND_URL_FALLBACK = 'https://35582-adyen-saas.adobeioruntime.net/api/v1/web/adyen/';

// ============================================================================
// BACKEND INTEGRATION URL
// ============================================================================

/**
 * Get the backend integration URL from cache or checkout data.
 * @param {Object} checkoutData - Checkout data containing payment methods
 * @returns {string}
 */
export function getBackendIntegrationUrl(checkoutData) {
  const cached = getWithExpiry(STORAGE_KEYS.INTEGRATION_URL);

  if (cached && !cached.expired) {
    return cached.value;
  }

  // Extract from checkout data
  const integrationUrl = checkoutData?.availablePaymentMethods?.find((m) => m.code?.startsWith('adyen_'))?.oope_payment_method_config?.backend_integration_url;

  if (integrationUrl) {
    setWithExpiry(
      STORAGE_KEYS.INTEGRATION_URL,
      integrationUrl,
      STORAGE_TTL.INTEGRATION_URL,
    );
  }

  return integrationUrl;
}

/**
 * Fetch the backend integration URL directly from Commerce via GraphQL.
 * Used as a fallback when the URL is not yet cached (e.g. first load of the
 * cart or PDP page before the shopper has visited checkout).
 *
 * @param {string} cartId - The masked cart ID (guest) or customer cart ID
 * @param {boolean} isGuest - Whether the cart belongs to a guest shopper
 * @returns {Promise<string|undefined>}
 */
export async function fetchBackendIntegrationUrl(cartId, isGuest) {
  try {
    const query = isGuest
      ? `query($cartId: String!) {
          cart(cart_id: $cartId) {
            available_payment_methods {
              code
              oope_payment_method_config { backend_integration_url }
            }
          }
        }`
      : `{ customerCart {
            available_payment_methods {
              code
              oope_payment_method_config { backend_integration_url }
            }
          }
        }`;

    const variables = isGuest ? { cartId } : {};
    const result = await fetchGraphQl(query, { method: 'POST', variables });
    const methods = isGuest
      ? result?.data?.cart?.available_payment_methods
      : result?.data?.customerCart?.available_payment_methods;

    const integrationUrl = methods?.find((m) => m.code?.startsWith('adyen_'))
      ?.oope_payment_method_config?.backend_integration_url;

    if (integrationUrl) {
      setWithExpiry(
        STORAGE_KEYS.INTEGRATION_URL,
        integrationUrl,
        STORAGE_TTL.INTEGRATION_URL,
      );
    }

    return integrationUrl;
  } catch (err) {
    console.warn('[adyen] fetchBackendIntegrationUrl failed:', err);
    return undefined;
  }
}

/**
 * Resolve the backend integration URL using a three-tier strategy:
 *   1. localStorage cache (populated when shopper previously visited checkout)
 *   2. Commerce GraphQL — available_payment_methods on the cart
 *   3. Hardcoded project fallback — always available, no external dependency
 *
 * Tier 3 means express checkout works even when Commerce SaaS does not surface
 * OOPE payment methods on the cart query (e.g. before a shipping method is set).
 *
 * @param {string} cartId
 * @param {boolean} isGuest
 * @returns {Promise<string>}
 */
export async function resolveBackendUrl(cartId, isGuest) {
  const cached = getBackendIntegrationUrl(null);
  if (cached) return cached;

  const fromGraphQL = await fetchBackendIntegrationUrl(cartId, isGuest);
  if (fromGraphQL) return fromGraphQL;

  return ADYEN_BACKEND_URL_FALLBACK;
}

// ============================================================================
// PUBLIC CONFIGURATION
// ============================================================================

/**
 * Fetch public configuration from the backend.
 * Results are cached for 24 hours.
 * @param {string} backendUrl
 * @param {string} scope
 * @param {boolean} isGuest
 * @returns {Promise<Object>}
 */
export async function fetchPublicConfiguration(backendUrl, scope, _shopperId, isGuest) {
  const cached = getWithExpiry(STORAGE_KEYS.PUBLIC_CONFIG);

  if (cached && !cached.expired) {
    return cached.value;
  }

  // Clear expired cache
  if (cached?.expired) {
    removeItem(STORAGE_KEYS.PUBLIC_CONFIG);
  }

  const cartId = sessionStorage.getItem('DROPINS_CART_ID');
  const url = new URL(`${backendUrl}public-configuration`);
  const response = await adyenFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  }, { backendUrl, cartId, isGuest });

  const publicConfiguration = await response.json();

  setWithExpiry(
    STORAGE_KEYS.PUBLIC_CONFIG,
    publicConfiguration,
    STORAGE_TTL.PUBLIC_CONFIG,
  );

  return publicConfiguration;
}

// ============================================================================
// PAYMENT METHODS
// ============================================================================

/**
 * In-memory cache for payment methods responses, keyed by cartId.
 * Prevents duplicate API calls when multiple express checkout blocks
 * initialize concurrently with the same cart.
 * Cache key format: `${cartId}:${JSON.stringify(body)}`
 */
const paymentMethodsCache = new Map();
const paymentMethodsInFlight = new Map();

/**
 * Build a cache key from cartId and request body.
 * @param {string} cartId
 * @param {Object} body
 * @returns {string}
 */
function buildPaymentMethodsCacheKey(cartId, body) {
  return `${cartId}:${JSON.stringify(body)}`;
}

/**
 * Wait for CartID to be available in sessionStorage with timeout.
 * Used as a defensive guard when payment methods are fetched before cart is ready.
 * @param {number} maxWaitMs - Maximum time to wait (default 10 seconds)
 * @returns {Promise<string|null>} CartID or null if timeout
 */
export async function waitForCartId(maxWaitMs = 10000) {
  const startTime = Date.now();
  const pollInterval = 100; // Check every 100ms

  while (Date.now() - startTime < maxWaitMs) {
    const cartId = sessionStorage.getItem('DROPINS_CART_ID');
    if (cartId) {
      return cartId;
    }
    // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return null;
}

/**
 * Wait for the cart dropin to emit cart/initialized event.
 * This ensures the cart is fully initialized before fetching payment methods.
 * Maximum wait time is 8 seconds.
 * @returns {Promise<Object|null>} Cart payload or null if timeout
 */
export function waitForCartInitialized() {
  // Reduced from 8s to 4s. Cart/initialized typically fires within 1-2s on fast networks.
  // If not received by 4s, we proceed anyway — express checkout can initialize without it
  // and will retry on demand (e.g., when fetching payment methods).
  const CART_INIT_TIMEOUT_MS = 4000;
  const last = events.lastPayload('cart/initialized');

  if (last !== undefined) {
    return Promise.resolve(last);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, CART_INIT_TIMEOUT_MS);
    events.on('cart/initialized', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Fetch payment methods from the backend with caching and deduplication.
 * Multiple concurrent calls with the same cartId + body will share a single request.
 * @param {string} backendUrl
 * @param {Object} body
 * @param {boolean} isGuest
 * @returns {Promise<Object>}
 */
export async function fetchPaymentMethods(backendUrl, body, _shopperId, isGuest) {
  let cartId = sessionStorage.getItem('DROPINS_CART_ID');

  // Defensive: wait for CartID if not immediately available (e.g., PDP first load)
  if (!cartId) {
    console.debug('[adyen] CartID not in sessionStorage; waiting for cart initialization...');
    cartId = await waitForCartId(10000);
    if (!cartId) {
      console.warn('[adyen] CartID timeout; proceeding with undefined CartID');
    }
  }

  const cacheKey = buildPaymentMethodsCacheKey(cartId, body);

  // Check if response is cached
  if (paymentMethodsCache.has(cacheKey)) {
    console.debug('[adyen] payment methods cache hit:', { cartId, cacheKey });
    return paymentMethodsCache.get(cacheKey);
  }

  // Check if request is already in flight; if so, wait for it
  if (paymentMethodsInFlight.has(cacheKey)) {
    console.debug('[adyen] payment methods request in flight; waiting:', { cartId, cacheKey });
    return paymentMethodsInFlight.get(cacheKey);
  }

  const endpoint = `${backendUrl.replace(/\/$/, '')}/payments-methods`;

  // FRONTEND DEBUG: Log request details
  // eslint-disable-next-line no-console
  console.debug('[FRONTEND-DEBUG] fetchPaymentMethods called with isGuest:', isGuest, {
    endpoint,
    cartId,
    bodyKeys: Object.keys(body),
    body,
    backendUrl,
    isGuest,
    typeof_isGuest: typeof isGuest,
  });

  // Create the fetch promise and store it for deduplication
  const fetchPromise = adyenFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, cartId, isGuest: String(isGuest) }),
  }, { backendUrl, cartId, isGuest })
    .then(async (response) => {
      // eslint-disable-next-line no-console
      console.debug('[FRONTEND-DEBUG] fetchPaymentMethods response', {
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        headers: {
          contentType: response.headers.get('content-type'),
          xOpenWhiskId: response.headers.get('x-openwhisk-activation-id'),
        },
      });

      const jsonData = await response.json();

      // Cache the response
      paymentMethodsCache.set(cacheKey, jsonData);
      paymentMethodsInFlight.delete(cacheKey);

      return jsonData;
    })
    .catch((err) => {
      // Don't cache errors, remove from in-flight on failure
      paymentMethodsInFlight.delete(cacheKey);
      throw err;
    });

  // Store the promise while request is in flight
  paymentMethodsInFlight.set(cacheKey, fetchPromise);

  return fetchPromise;
}

// ============================================================================
// CONFIG BUILDERS
// ============================================================================

/**
 * Get country code from checkout data (billing or shipping address).
 * @param {Object} checkoutData
 * @returns {string}
 */
function getCountryCodeFromCheckout(checkoutData) {
  const billingCountry = checkoutData?.billingAddress?.country?.code
    || checkoutData?.billingAddress?.country;
  const shippingCountry = checkoutData?.shippingAddress?.country?.code
    || checkoutData?.shippingAddress?.country;
  return billingCountry || shippingCountry || '';
}

/**
 * Build static configuration from public config.
 * Country code priority: publicCfg > checkout addresses > store default country
 * @param {Object} publicCfg
 * @param {Object} [checkoutData] - Optional checkout data for country code fallback
 * @returns {Object}
 */
export function buildStaticConfig(publicCfg, checkoutData = null) {
  const storeConfig = getStoreConfigCache();
  const locale = navigator?.language || 'en-US';
  const countryCode = publicCfg.countryCode
    || getCountryCodeFromCheckout(checkoutData)
    || storeConfig?.defaultCountry
    || 'US';

  // Disable analytics in test environment due to CORS issues on checkoutanalytics-test.adyen.com
  // Enable only in production (live) environments
  const isTestEnvironment = publicCfg.environment === 'test';

  return {
    environment: publicCfg.environment,
    clientKey: publicCfg.clientKey,
    locale,
    countryCode,
    analytics: {
      enabled: !isTestEnvironment,
    },
  };
}

/**
 * Build base configuration for Adyen checkout.
 * Note: Shopper details (email, name, addresses) are NOT included here
 * as they are not valid AdyenCheckout properties. They are passed during
 * payment submission in the onSubmit handler.
 * @param {Object} params
 * @returns {Object}
 */
export function buildBaseConfiguration({
  publicCfg,
  checkoutData,
  cartData,
  paymentMethods,
  onSubmit,
  onAdditionalDetails,
  onPaymentCompleted,
  onPaymentFailed,
  onError,
}) {
  return {
    ...buildStaticConfig(publicCfg, checkoutData),
    paymentMethodsResponse: paymentMethods,
    amount: formatAmount(
      cartData.total?.includingTax?.value,
      cartData.total?.includingTax?.currency,
    ),
    onSubmit,
    onAdditionalDetails,
    onPaymentCompleted,
    onPaymentFailed,
    onError,
  };
}
