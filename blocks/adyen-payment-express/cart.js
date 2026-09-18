/**
 * Express Checkout Cart Helpers
 *
 * Resolves the active cart for both guest and authenticated shoppers.
 * Also handles adding a product (PDP flow) and shipping estimation.
 */

import { events } from '@dropins/tools/event-bus.js';
import {
  createGuestCart,
  getCartDataFromCache,
  getCustomerCartPayload,
  addProductsToCart,
} from '@dropins/storefront-cart/api.js';
import { estimateShippingMethods } from '@dropins/storefront-checkout/api.js';
import {
  waitForAuthState,
  CORE_FETCH_GRAPHQL,
} from '../../scripts/commerce.js';
import { get as cacheGet, invalidate as cacheInvalidate } from './cache.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { nrEventBatcher } from './nr-events.js';

/** Maximum ms to wait for the cart dropin to emit cart/initialized.
 * Reduced from 8s to 4s. Cart typically initializes within 1-2s on normal networks.
 * If not received by 4s, we proceed anyway — can retry on demand if needed.
 */
const CART_INIT_TIMEOUT_MS = 4000;

/** Circuit breaker singleton for cart refresh queries (Phase 5 Week 3).
 * Detects persistent failures and falls back to stale/dropin cache.
 * Emits state transition events to New Relic for production observability.
 */
const circuitBreaker = getCircuitBreaker({}, { nrCustomEvents: nrEventBatcher });

/** Cache for resolveCart() result (all blocks share the same cart). */
let resolveCartCache = null;

/** In-flight promise for resolveCart() to avoid duplicate concurrent calls. */
let resolveCartInFlight = null;

/** Track the last known cartId from sessionStorage to detect changes. */
let lastKnownSessionCartId = null;

/** Flag to track if event listeners have been registered. */
let eventListenersRegistered = false;

/**
 * Clear the resolveCart cache when the cart state changes.
 * This ensures fresh resolution on the next resolveCart() call.
 */
function clearResolveCartCache() {
  if (resolveCartCache) {
    console.debug('[CART-DEBUG] Clearing resolveCart cache due to cart state change');
    resolveCartCache = null;
  }
}

/**
 * Invalidate the cart totals cache on cart mutations.
 * Called when cart state changes to ensure refreshCartTotals() refetches.
 */
function invalidateCartTotalsCache(reason) {
  const cartCache = getCartDataFromCache();
  const cartId = cartCache?.id;
  if (cartId) {
    cacheInvalidate(cartId, reason);
  }
}

/**
 * Set up event listeners to invalidate the resolveCart cache when cart state changes.
 * Called once per page load to register listeners for:
 * - cart/updated: Cart contents changed
 * - cart/reset: Cart was reset
 * - order/placed: Order was placed (new cart needed on next checkout)
 * - sessionStorage DROPINS_CART_ID change: User switched carts
 */
function setupCacheInvalidationListeners() {
  if (eventListenersRegistered) {
    return;
  }

  // Listen for cart/updated event (contents changed)
  events.on('cart/updated', () => {
    console.debug('[CART-DEBUG] cart/updated event fired; clearing resolveCart cache');
    clearResolveCartCache();
    invalidateCartTotalsCache('cart/updated');
  });

  // Listen for cart/reset event (cart was reset)
  events.on('cart/reset', () => {
    console.debug('[CART-DEBUG] cart/reset event fired; clearing resolveCart cache');
    clearResolveCartCache();
    invalidateCartTotalsCache('cart/reset');
  });

  // Listen for order/placed event (order completed; will need new cart)
  events.on('order/placed', () => {
    console.debug('[CART-DEBUG] order/placed event fired; clearing resolveCart cache');
    clearResolveCartCache();
    invalidateCartTotalsCache('order/placed');
  });

  // Listen for sessionStorage changes (another tab or iframe may change DROPINS_CART_ID)
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function sessionStorageSetItem(key, value) {
    if (key === 'DROPINS_CART_ID') {
      const newCartId = value;
      if (newCartId !== lastKnownSessionCartId) {
        console.debug('[CART-DEBUG] sessionStorage DROPINS_CART_ID changed; clearing resolveCart cache', {
          old: lastKnownSessionCartId,
          new: newCartId,
        });
        lastKnownSessionCartId = newCartId;
        clearResolveCartCache();
        invalidateCartTotalsCache('sessionStorage_DROPINS_CART_ID_changed');
      }
    }
    originalSetItem.call(this, key, value);
  };

  eventListenersRegistered = true;
  console.debug('[CART-DEBUG] Cache invalidation listeners registered');
}

/**
 * Wait for the cart dropin to finish initializing.
 *
 * The cart dropin emits `cart/initialized` once after its first GraphQL fetch.
 * `events.lastPayload` returns the payload synchronously if it has already
 * fired; otherwise we wait up to CART_INIT_TIMEOUT_MS for the event.
 *
 * @returns {Promise<Object|null>} Resolved cart payload (may be null for empty guest carts)
 */
function waitForCartInit() {
  const last = events.lastPayload('cart/initialized');
  if (last !== undefined) return Promise.resolve(last);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CART_INIT_TIMEOUT_MS);
    events.on('cart/initialized', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Resolve the active cart.
 *
 * Waits for the cart dropin to finish initializing (so its GraphQL endpoint
 * is configured and the cart ID cookie has been read) before attempting to
 * read cart data. Falls back to creating a new guest cart only when no
 * existing cart is found (correct for PDP cold-start with no prior session).
 *
 * All express checkout blocks (Google Pay, Apple Pay, PayPal) share the same
 * cart by using this cache. The first call resolves the cart; subsequent calls
 * return the cached result or wait for the in-flight promise to complete.
 *
 * @returns {Promise<{ cartId: string, isGuest: boolean, isEmpty: boolean }>}
 */
export async function resolveCart() {
  // Set up cache invalidation listeners on first call
  setupCacheInvalidationListeners();

  // Return cached result if available
  if (resolveCartCache) {
    console.debug('[CART-DEBUG] resolveCart() cache hit:', resolveCartCache);
    return resolveCartCache;
  }

  // Return in-flight promise if another call is already resolving the cart
  if (resolveCartInFlight) {
    console.debug('[CART-DEBUG] resolveCart() in-flight; waiting for concurrent resolution...');
    return resolveCartInFlight;
  }

  // Create the in-flight promise so subsequent calls wait for this one
  resolveCartInFlight = (async () => {
    try {
      console.debug('[CART-DEBUG] resolveCart() called, waiting for auth state...');

      // Wait for the authenticated event to fire (8s timeout after reduction)
      // This reliably indicates whether the user is authenticated or a guest
      const isAuthenticated = await waitForAuthState();

      console.debug('[CART-DEBUG] waitForAuthState() returned:', {
        isAuthenticated,
        timestamp: new Date().toISOString(),
      });

      // Determine isGuest: true if NOT authenticated, false if authenticated
      const isGuest = !isAuthenticated;

      console.debug('[CART-DEBUG] Determined isGuest:', {
        isGuest,
        isAuthenticated,
      });

      // Wait for the cart dropin to be ready before touching its APIs.
      // This is critical: the dropin sets its GraphQL endpoint asynchronously
      // inside its initializer, so calling fetchGraphQl before it finishes
      // results in silent failures (undefined endpoint → request never sent).
      const cartPayload = await waitForCartInit();

      let result;
      if (!isGuest) {
        // For authenticated users, prefer the already-loaded payload; fall back to fetch.
        const id = cartPayload?.id;
        if (id) {
          result = {
            cartId: id,
            isGuest: false,
            isEmpty: !(cartPayload.totalQuantity > 0),
          };
          console.debug('[CART-DEBUG] resolveCart() returning (authenticated, from payload):', result);
        } else {
          const cart = await getCustomerCartPayload();
          if (!cart?.id) throw new Error('Failed to fetch customer cart');
          result = {
            cartId: cart.id,
            isGuest: false,
            isEmpty: !(cart.totalQuantity > 0),
          };
          console.debug('[CART-DEBUG] resolveCart() returning (authenticated, from fetch):', result);
        }
      } else {
        // Guest: use the cart the dropin already loaded (has items, correct ID).
        const id = cartPayload?.id;
        if (id) {
          result = {
            cartId: id,
            isGuest: true,
            isEmpty: !(cartPayload.totalQuantity > 0),
          };
          console.debug('[CART-DEBUG] resolveCart() returning (guest, from payload):', result);
        } else {
          // Dropin returned null (no cookie / empty cart) — fall back to in-memory cache.
          const cached = getCartDataFromCache();
          if (cached?.id) {
            result = {
              cartId: cached.id,
              isGuest: true,
              isEmpty: !(cached.totalQuantity > 0),
            };
            console.debug('[CART-DEBUG] resolveCart() returning (guest, from cache):', result);
          } else {
            // Last resort: create a new guest cart (PDP with no prior session).
            const maskedId = await createGuestCart();
            if (!maskedId) throw new Error('Failed to create guest cart');
            result = { cartId: maskedId, isGuest: true, isEmpty: true };
            console.debug('[CART-DEBUG] resolveCart() returning (guest, new cart):', result);
          }
        }
      }

      // Cache the result for subsequent calls
      resolveCartCache = result;
      return result;
    } finally {
      // Clear in-flight promise so future calls can make fresh resolveCart() calls if needed
      resolveCartInFlight = null;
    }
  })();

  return resolveCartInFlight;
}

/**
 * Session-level idempotency: tracks SKUs successfully added to the cart in
 * the current page session. Resets automatically on page reload (module re-eval).
 *
 * On PDP, the user may open and close a payment sheet multiple times before
 * completing a purchase. Without this guard each sheet open would call
 * addProductsToCart and keep incrementing the cart item quantity.
 *
 * @type {Set<string>}
 */
const addedToCartSkus = new Set();

/**
 * In-flight deduplication: prevents concurrent callers (the three express
 * blocks all starting simultaneously) from firing duplicate mutations.
 *
 * @type {Map<string, Promise<void>>}
 */
const addToCartInFlight = new Map();

/**
 * Add a product to the cart (PDP express-checkout flow only).
 *
 * Safe to call multiple times per page session for the same SKU — the item
 * is added exactly once. Concurrent calls with the same SKU share a single
 * in-flight promise.
 *
 * NOTE: addToCart must be called only when the user initiates an express
 * checkout (button click / sheet open), never on page load. Calling it on
 * page load would silently add the product to the cart on every PDP visit
 * regardless of whether the user intends to buy.
 *
 * @param {string} sku
 * @param {number} qty
 * @returns {Promise<void>}
 */
export async function addToCart(sku, qty = 1) {
  console.debug('[CART] addToCart: START', {
    sku,
    qty,
    alreadyAdded: addedToCartSkus.has(sku),
    inFlight: addToCartInFlight.has(sku),
    timestamp: new Date().toISOString(),
  });

  // Already added in this page session — no-op.
  if (addedToCartSkus.has(sku)) {
    console.debug('[CART] addToCart: SKIPPED (already in session)', { sku });
    return undefined;
  }

  // Another caller is already in-flight for this SKU — share its promise.
  if (addToCartInFlight.has(sku)) {
    console.debug('[CART] addToCart: REUSING in-flight promise', { sku });
    return addToCartInFlight.get(sku);
  }

  // The shopper may have already added this SKU to the cart through a different
  // control (e.g. the PDP's own Add to Cart button) before starting express
  // checkout. addedToCartSkus only remembers what THIS module has added, so without
  // this check we'd call addProductsToCart again and double the line item quantity
  // — the underlying cause of an order being placed with the wrong total.
  // getCartDataFromCache() is already-fetched dropin state, so this costs no
  // extra network round trip.
  const cachedCart = getCartDataFromCache();
  const alreadyInCart = (cachedCart?.items ?? []).some(
    (item) => item.sku === sku
      || item.product?.sku === sku
      || item.configurableProduct?.sku === sku,
  );
  if (alreadyInCart) {
    console.debug('[CART] addToCart: SKIPPED (already in live cart)', { sku });
    addedToCartSkus.add(sku);
    return undefined;
  }

  const startTime = performance.now();
  const promise = addProductsToCart([{ sku, quantity: qty }])
    .then(() => {
      console.debug('[CART] addToCart: addProductsToCart SUCCESS', {
        sku,
        elapsedMs: Math.round(performance.now() - startTime),
      });
      addedToCartSkus.add(sku);
      // Invalidate cart totals cache since cart contents changed
      invalidateCartTotalsCache('addToCart');
    })
    .catch((err) => {
      console.error('[CART] addToCart: addProductsToCart FAILED', {
        sku,
        error: err.message,
        stack: err.stack,
        elapsedMs: Math.round(performance.now() - startTime),
      });
      throw err;
    })
    .finally(() => {
      console.debug('[CART] addToCart: CLEANUP', {
        sku,
        totalElapsedMs: Math.round(performance.now() - startTime),
      });
      addToCartInFlight.delete(sku);
    });

  addToCartInFlight.set(sku, promise);
  console.debug('[CART] addToCart: promise created and stored', { sku });
  return promise;
}

/**
 * Check if a product SKU has already been added to the cart in this page session.
 * Used to prevent duplicate add-to-cart mutations in the PDP express checkout flow.
 *
 * @param {string} sku - The product SKU to check
 * @returns {boolean} - True if the SKU was already added in this session
 */
export function hasAddedToCart(sku) {
  return addedToCartSkus.has(sku);
}

/**
 * Refetch current cart totals directly from the Commerce backend.
 *
 * Instead of relying on the cart dropin's cache (which may be stale after
 * addProductsToCart), this function queries the current cart directly via
 * GraphQL. This ensures we have the authoritative backend total before
 * submitting the payment.
 *
 * Implements three layers of resilience (Phase 5):
 * 1. 30s memoization with concurrent request coalescing (cache.js)
 * 2. Circuit breaker that skips queries on persistent failures (circuit-breaker.js)
 * 3. Fallback to stale cache or dropin cart state
 *
 * Cache invalidates on cart mutations (add-to-cart, set-shipping) and payment
 * completion. Circuit breaker opens on 3 consecutive failures or >50% error
 * rate in 5-minute window; falls back for 30s then test-fires recovery.
 *
 * Returns { value: number, currency: string } for the current cart grand_total,
 * or null if unable to fetch (caller falls back to DOM parsing or unit price * qty).
 *
 * Used by express checkout blocks (Google Pay, Apple Pay, PayPal) after adding
 * a product to ensure the payment amount matches the backend cart total.
 *
 * @returns {Promise<{ value: number, currency: string }|null>}
 */
export async function refreshCartTotals() {
  const startTime = performance.now();
  console.debug('[CART] refreshCartTotals: START', {
    timestamp: new Date().toISOString(),
  });

  try {
    // Get the cart ID from the dropin's cache. This is safe — the cart ID
    // is set during cart initialization and doesn't go stale. We just need it
    // to query the cart's current totals.
    const cartCache = getCartDataFromCache();
    const cartId = cartCache?.id;

    if (!cartId) {
      console.warn('[CART] refreshCartTotals: FAILED - no cartId in cache', {
        cacheExists: !!cartCache,
        elapsedMs: Math.round(performance.now() - startTime),
      });

      // Emit failure event to NR
      nrEventBatcher.recordCustomEvent('CartRefreshFailure', {
        cartId: null,
        duration_ms: Math.round(performance.now() - startTime),
        fallback_reason: 'no_cart_id',
        circuit_state: circuitBreaker.getState(),
        timestamp: new Date().toISOString(),
      });

      return null;
    }

    // Emit request event to NR
    nrEventBatcher.recordCustomEvent('CartRefreshRequested', {
      cartId,
      timestamp: new Date().toISOString(),
      circuit_state: circuitBreaker.getState(),
    });

    console.debug('[CART] refreshCartTotals: cart ID obtained', {
      cartId,
      circuitState: circuitBreaker.getState(),
      elapsedMs: Math.round(performance.now() - startTime),
    });

    // Query function: fetch via cache layer with 30s TTL and 1s GraphQL timeout
    const queryFn = async () => {
      const { value: cartTotal } = await cacheGet(
        cartId,
        async () => {
          const { data, errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
            `query getCartTotal($cartId: String!) {
              cart(cart_id: $cartId) {
                prices {
                  grand_total {
                    value
                    currency
                  }
                }
              }
            }`,
            {
              method: 'POST',
              cache: 'no-cache',
              variables: { cartId },
            },
          );

          if (errors?.length) {
            throw new Error(`GraphQL errors: ${errors.map((e) => e.message).join(', ')}`);
          }

          const total = data?.cart?.prices?.grand_total;
          if (!total?.value || !total?.currency) {
            throw new Error('grand_total not in response');
          }

          return total;
        },
        30000, // 30s TTL
        1000, // 1s GraphQL timeout
      );
      return cartTotal;
    };

    // Fallback function: try dropin cache (already loaded cart data)
    const fallbackFn = () => {
      const currentCache = getCartDataFromCache();
      if (currentCache?.prices?.grand_total) {
        console.debug('[CART] refreshCartTotals: fallback to dropin cache', {
          value: currentCache.prices.grand_total.value,
          currency: currentCache.prices.grand_total.currency,
          circuitState: circuitBreaker.getState(),
        });
        return {
          value: currentCache.prices.grand_total.value,
          currency: currentCache.prices.grand_total.currency,
        };
      }
      return null;
    };

    // Call with circuit breaker: detects persistent failures and falls back gracefully
    const cartTotal = await circuitBreaker.call(queryFn, fallbackFn);
    const elapsed = Math.round(performance.now() - startTime);

    if (!cartTotal) {
      console.warn('[CART] refreshCartTotals: FAILED - no cart total', {
        circuitState: circuitBreaker.getState(),
        elapsedMs: elapsed,
      });

      // Emit failure event to NR
      nrEventBatcher.recordCustomEvent('CartRefreshFailure', {
        cartId,
        duration_ms: elapsed,
        fallback_reason: circuitBreaker.getState() === 'Open' ? 'circuit_breaker_open' : 'fallback_null',
        circuit_state: circuitBreaker.getState(),
        timestamp: new Date().toISOString(),
      });

      return null;
    }

    console.debug('[CART] refreshCartTotals: SUCCESS', {
      value: cartTotal.value,
      currency: cartTotal.currency,
      circuitState: circuitBreaker.getState(),
      elapsedMs: elapsed,
    });

    // Emit success event to NR
    nrEventBatcher.recordCustomEvent('CartRefreshSuccess', {
      cartId,
      duration_ms: elapsed,
      // ponytail: cache_hit null = unknown (not yet tracked); defer to Phase 6
      cache_hit: null,
      circuit_state: circuitBreaker.getState(),
      timestamp: new Date().toISOString(),
    });

    return {
      value: cartTotal.value,
      currency: cartTotal.currency,
    };
  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    console.error('[CART] refreshCartTotals: EXCEPTION', {
      error: err.message,
      stack: err.stack,
      circuitState: circuitBreaker.getState(),
      elapsedMs: elapsed,
    });

    // Emit failure event to NR
    try {
      nrEventBatcher.recordCustomEvent('CartRefreshFailure', {
        cartId: getCartDataFromCache()?.id || null,
        duration_ms: elapsed,
        fallback_reason: 'exception',
        error_message: err.message,
        circuit_state: circuitBreaker.getState(),
        timestamp: new Date().toISOString(),
      });
    } catch (eventErr) {
      console.debug('[CART] Failed to emit CartRefreshFailure event', eventErr.message);
    }

    return null;
  }
}

/**
 * Call Commerce estimateShippingMethods with a partial wallet address.
 * Returns an array of ShippingMethod objects or throws on failure.
 * @param {{ countryCode: string, region?: string, postcode?: string }} address
 * @returns {Promise<Array>}
 */
export async function estimateShipping(address) {
  const methods = await estimateShippingMethods({
    criteria: {
      country_code: address.countryCode,
      region_name: address.region || undefined,
      zip: address.postcode || undefined,
    },
  });
  return methods || [];
}

/**
 * Fetch the logged-in customer's Commerce account email.
 *
 * Uses CORE_FETCH_GRAPHQL directly — this instance already has the
 * `Authorization: Bearer <token>` header injected by the auth initializer,
 * so it works without depending on any dropin's internal authenticated state.
 *
 * Returns null for guests (GraphQL returns an error for unauthenticated calls)
 * or on any network/parse failure.
 *
 * @returns {Promise<string|null>}
 */
export async function getLoggedInCustomerEmail() {
  try {
    const CUSTOMER_EMAIL_QUERY = 'query { customer { email } }';
    const { data, errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
      CUSTOMER_EMAIL_QUERY,
      {
        method: 'GET',
        cache: 'no-cache',
      },
    );
    if (errors?.length || !data?.customer?.email) return null;
    return data.customer.email;
  } catch {
    return null;
  }
}

/**
 * Fetch the logged-in customer's default shipping address from their account.
 * Used in PayPal express checkout to pre-populate the shipping address
 * when the customer is authenticated and has a default address saved.
 *
 * Returns null for guests or if the customer has no default address.
 *
 * @returns {Promise<{ firstName: string, lastName: string, street: string,
 *   city: string, region: string, postcode: string, countryCode: string }|null>}
 */
export async function getLoggedInCustomerDefaultAddress() {
  try {
    const CUSTOMER_ADDRESS_QUERY = `query {
       customer {
         addresses {
           default_shipping
           firstname
           lastname
           street
           city
           region {
             region
             region_id
           }
           postcode
           country_code
         }
       }
     }`;
    const { data, errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
      CUSTOMER_ADDRESS_QUERY,
      {
        method: 'GET',
        cache: 'no-cache',
      },
    );
    if (errors?.length || !data?.customer?.addresses) return null;

    // Find the default shipping address
    const defaultAddr = data.customer.addresses.find((addr) => addr.default_shipping);
    if (!defaultAddr) return null;

    return {
      firstName: defaultAddr.firstname || '',
      lastName: defaultAddr.lastname || '',
      street: defaultAddr.street?.[0] || '',
      city: defaultAddr.city || '',
      region: defaultAddr.region?.region || '',
      regionId: defaultAddr.region?.region_id || undefined,
      postcode: defaultAddr.postcode || '',
      countryCode: defaultAddr.country_code || '',
    };
  } catch {
    return null;
  }
}

/**
 * Check if the cart contains only virtual (non-shippable) items.
 * Used in PayPal express checkout to skip shipping steps for digital products.
 *
 * @param {string} cartId - The cart ID to check
 * @returns {Promise<boolean>} - True if the cart is virtual (no shipping needed), false otherwise
 */
export async function isCartVirtual(cartId) {
  try {
    const CART_VIRTUAL_QUERY = `query {
      cart(cart_id: "${cartId}") {
        is_virtual
      }
    }`;
    const { data, errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
      CART_VIRTUAL_QUERY,
      {
        method: 'POST',
        cache: 'no-cache',
      },
    );
    if (errors?.length || data?.cart?.is_virtual === undefined) return false;
    return data.cart.is_virtual;
  } catch {
    return false;
  }
}
