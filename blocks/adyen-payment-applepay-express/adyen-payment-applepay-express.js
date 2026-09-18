/**
 * Adyen Apple Pay Express Checkout Block
 *
 * Renders an Apple Pay button on Cart and PDP pages, driving a full express
 * checkout flow: resolve/create cart → SDK init → shipping estimation →
 * address + shipping method → POST /payments → place order → redirect.
 *
 * PDP usage: add `data-sku` attribute on the block element (populated by the
 * PDP template) so the block can add the product before starting the flow.
 */

import {
  getStoreConfigCache,
  initializeCheckout,
  setEndpoint as setCheckoutEndpoint,
} from '@dropins/storefront-checkout/api.js';
import {
  getCartDataFromCache,
  setEndpoint as setCartEndpoint,
} from '@dropins/storefront-cart/api.js';
import { setEndpoint as setOrderEndpoint } from '@dropins/storefront-order/api.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { events } from '@dropins/tools/event-bus.js';
import {
  CORE_FETCH_GRAPHQL,
  CS_FETCH_GRAPHQL,
  waitForAuthState,
} from '../../scripts/commerce.js';
import { adyenFetch } from '../../scripts/adyen-auth.js';
import {
  fetchPublicConfiguration,
  fetchPaymentMethods,
  buildStaticConfig,
  resolveBackendUrl,
  waitForCartInitialized,
} from '../adyen-payment/config.js';
import {
  loadAdyenWebSDK,
  getAdyenCheckoutFactory,
  formatAmount,
} from '../adyen-payment/utils.js';
import {
  showExpressLoading,
  hideExpressLoading,
  showExpressError,
  resolveCart,
  addToCart,
  refreshCartTotals,
  estimateShipping,
  setShippingMethod,
  commerceToApplePayShippingMethods,
  applePayContactToCommerce,
  setGuestEmail,
  setBilling,
  setShipping,
  placeOrderWithPayment,
  redirectToConfirmation,
  getLoggedInCustomerEmail,
} from '../adyen-payment-express/index.js';

/**
 * Browser compatibility check for Apple Pay.
 * Apple Pay is only supported on Safari and WebKit-based browsers (iOS Safari, iPadOS Safari).
 * Returns false for Chrome, Firefox, Edge, and other non-Safari browsers.
 *
 * @returns {boolean} true if browser supports Apple Pay, false otherwise
 */
function isApplePaySupported() {
  const ua = window.navigator.userAgent;
  console.debug('[applepay-express] Browser UA:', ua);

  // Safari: contains "Safari" but not "Chrome", "Firefox", "Edge", "OPR" (Opera)
  // Note: iOS Safari and iPadOS Safari both contain "Safari" in their UA string
  const isSafari = /Safari/.test(ua) && !/Chrome|Firefox|Edge|OPR/.test(ua);

  console.debug('[applepay-express] isApplePaySupported():', isSafari);
  return isSafari;
}

/**
 * Lazy-load helper — defer cart resolution until authenticated event has fired.
/**
 * Async initializer — all heavy work (network calls, SDK load) runs here.
 * Separated from decorate() so decorate() can return immediately without
 * blocking the AEM loadSection/loadBlock pipeline and delaying first paint.
 *
 * @param {HTMLElement} block
 * @param {HTMLElement} container
 */
async function initExpressCheckout(block, container) {
  try {
    // ── 0. Wire dropin GraphQL endpoints ──
    // CORE_FETCH_GRAPHQL is populated by initializeCommerce() before blocks run.
    setCartEndpoint(CORE_FETCH_GRAPHQL);
    setCheckoutEndpoint(CORE_FETCH_GRAPHQL);
    setOrderEndpoint(CORE_FETCH_GRAPHQL);

    // ── 0.5. Wait for auth state to be set by authenticated event ──
    // The auth dropin fires the authenticated event asynchronously during its initialization.
    // We must wait for it before calling resolveCart(), which needs the correct isGuest value.
    // Extended timeout (15s) accommodates slower network conditions and dropin init.
    console.debug('[applepay-express] Waiting for auth state before resolveCart()');
    await waitForAuthState();
    console.debug('[applepay-express] Auth state ready, proceeding with resolveCart()');

    // ── 1. Resolve the active cart (create guest or fetch customer cart) ──
    const sku = block.dataset.sku || null;
    const { cartId, isGuest, isEmpty } = await resolveCart();
    console.debug('[applepay-express] resolveCart() returned:', { cartId, isGuest, isEmpty });

    // Store CartID in sessionStorage so other blocks (and waitForCartId) can access it
    if (cartId) {
      sessionStorage.setItem('DROPINS_CART_ID', cartId);
    }

    // On the cart page (no sku), hide the block if the cart has no items.
    if (!sku && isEmpty) {
      block.style.display = 'none';
      return;
    }

    // ── 2. Initialize checkout dropin internal state with the resolved cartId ──
    await initializeCheckout({ id: cartId });

    // ── 2a. Fetch the logged-in customer's Commerce email ──
    // For authenticated shoppers we must use the Commerce account email (not the
    // wallet email) so the backend's findCustomerByEmail lookup succeeds.
    // CORE_FETCH_GRAPHQL already has the Authorization bearer token set by the
    // auth initializer, so this works without any dropin internal auth state.
    // Returns null for guests or on failure; we fall back to the wallet email below.
    let customerEmail = null;
    if (!isGuest) {
      customerEmail = await getLoggedInCustomerEmail();
    }

    // ── 3. Determine initial price for payment sheet amounts ──
    // On PDP (sku present) the item is not yet in cart. Read the unit price from
    // the PDP dropin event bus (pdp/data), which normalizes price data as:
    //   prices.final.amount       (SimpleProductView)
    //   prices.final.minimumAmount (ComplexProductView / configurable)
    // Fall back to prerendered JSON-LD when the event bus is unavailable.
    // On cart page use the live cart grand total from the dropin cache.
    let cartTotalValue;
    let cartCurrency;
    if (sku) {
      const qty = parseInt(
        document.querySelector(
          '.pdp-product__quantity input, [name="quantity"]',
        )?.value || '1',
        10,
      ) || 1;
      let unitPrice = 0;
      let unitCurrency = 'USD';

      // Price source 1: pdp/data event bus (populated by the PDP dropin).
      // Express blocks are loaded after product-details.js awaits dropin renders
      // (which fire pdp/data), so lastPayload is populated at this point.
      // The dropin normalizes Catalog Service GraphQL price data into:
      //   prices.final.amount        (SimpleProductView — same min/max)
      //   prices.final.minimumAmount (ComplexProductView / configurable)
      //   prices.regular.amount      (regular/non-discounted price)
      const pdpData = events.lastPayload('pdp/data');
      const pdpFinal = pdpData?.prices?.final;
      const pdpRegular = pdpData?.prices?.regular;
      const pdpPrice = pdpFinal?.amount ?? pdpFinal?.minimumAmount ?? pdpRegular?.amount;
      if (pdpPrice > 0) {
        unitPrice = pdpPrice;
        unitCurrency = pdpFinal?.currency ?? pdpRegular?.currency ?? 'USD';
      }

      // Price source 2: prerendered JSON-LD structured data.
      // product-details.js skips setMetaTags() when isProductPrerendered() is true,
      // so OG meta tags are absent — but the JSON-LD <script> block is server-rendered.
      if (!(unitPrice > 0)) {
        try {
          const jsonLdEl = document.querySelector(
            'script[type="application/ld+json"]',
          );
          if (jsonLdEl) {
            const jsonLd = JSON.parse(jsonLdEl.textContent);
            const offer = Array.isArray(jsonLd.offers)
              ? jsonLd.offers[0]
              : jsonLd.offers;
            const jsonLdPrice = parseFloat(offer?.price);
            if (jsonLdPrice > 0) {
              unitPrice = jsonLdPrice;
              unitCurrency = offer?.priceCurrency ?? 'USD';
            }
          }
        } catch (_e) {
          // JSON-LD absent or malformed — continue to next source
        }
      }

      // Price source 3: Catalog Service GraphQL direct query.
      // Tries CS_FETCH_GRAPHQL (same endpoint the PDP dropin uses) with the correct
      // CS schema. This can succeed when the dropin's cached payload is stale or when
      // a variant selection has changed the effective price after init.
      if (!(unitPrice > 0)) {
        try {
          const csQuery = `{
            products(skus: [${JSON.stringify(sku)}]) {
              __typename
              ... on SimpleProductView {
                price {
                  final { amount { value currency } }
                  regular { amount { value currency } }
                }
              }
              ... on ComplexProductView {
                priceRange {
                  minimum {
                    final { amount { value currency } }
                    regular { amount { value currency } }
                  }
                }
              }
            }
          }`;
          const { data: csData } = await CS_FETCH_GRAPHQL.fetchGraphQl(
            csQuery,
            {
              method: 'GET',
              cache: 'no-cache',
            },
          );
          const csProduct = csData?.products?.[0];
          const csPrice = csProduct?.price?.final?.amount?.value
            ?? csProduct?.price?.regular?.amount?.value
            ?? csProduct?.priceRange?.minimum?.final?.amount?.value
            ?? csProduct?.priceRange?.minimum?.regular?.amount?.value;
          const csCurrency = csProduct?.price?.final?.amount?.currency
            ?? csProduct?.priceRange?.minimum?.final?.amount?.currency;
          if (csPrice > 0) {
            unitPrice = csPrice;
            unitCurrency = csCurrency ?? 'USD';
          }
        } catch (_e) {
          // CS query failed — continue to DOM fallback
        }
      }

      // Price source 4: DOM text parsing (last resort).
      // If the Catalog Service does not return pricing (e.g. B2B shared-catalog
      // restrictions, un-indexed products), the PDP dropin still renders the price
      // visually from the prerendered HTML. Parse the first numeric value from the
      // rendered .pdp-price-range element as a best-effort fallback.
      if (!(unitPrice > 0)) {
        const priceEl = document.querySelector('.pdp-price-range');
        if (priceEl) {
          const text = priceEl.textContent?.trim() ?? '';
          const match = text.match(/\d[\d,.]*\d|\d/);
          if (match) {
            const domPrice = parseFloat(match[0].replace(/,(?=\d{3}\b)/g, ''));
            if (domPrice > 0) unitPrice = domPrice;
          }
        }
      }

      cartTotalValue = unitPrice * qty;
      cartCurrency = unitCurrency;
    } else {
      const cartCache = getCartDataFromCache();
      const cartTotal = cartCache?.prices?.grand_total
        ?? cartCache?.total?.includingTax
        ?? null;
      cartTotalValue = cartTotal?.value ?? 0;
      cartCurrency = cartTotal?.currency ?? 'USD';
    }

    // ── 4. Resolve scope + backend URL ──
    const storeConfig = getStoreConfigCache();
    const scope = storeConfig?.code
      || (await getConfigValue('headers.cs.Magento-Store-View-Code'));
    const backendUrl = await resolveBackendUrl(cartId, isGuest);
    if (!backendUrl) throw new Error('Adyen backend URL unavailable');

    // ── 4.5. Wait for cart/initialized event before fetching payment methods ──
    // This ensures CartID is available in sessionStorage for the backend call.
    // On PDP first load, the cart dropin may still be initializing when we reach
    // fetchPaymentMethods, so we defer the call until the cart/initialized event.
    console.debug('[applepay-express] Waiting for cart/initialized event before payment methods...');
    await waitForCartInitialized();
    console.debug('[applepay-express] cart/initialized event received, proceeding with fetchPaymentMethods');

    // ── 5. Load SDK + public config ──
    const publicCfg = await fetchPublicConfiguration(backendUrl, scope, null, isGuest);
    await loadAdyenWebSDK(publicCfg.environment);

    const staticCfg = buildStaticConfig(publicCfg);
    let currency = cartCurrency || staticCfg.amount?.currency || 'USD';

    // ── 6. Fetch payment methods with real cart amount ──
    // Now safe: CartID is available in sessionStorage, and multiple concurrent
    // calls will be deduplicated via the cache in config.js.
    const paymentMethods = await fetchPaymentMethods(backendUrl, {
      countryCode: staticCfg.countryCode,
      amount: formatAmount(cartTotalValue, currency),
      shopperEmail: !isGuest && customerEmail ? customerEmail : '',
    }, null, isGuest);

    // ── 5. Build AdyenCheckout instance ──
    const AdyenCheckoutFactory = getAdyenCheckoutFactory();
    const checkout = await AdyenCheckoutFactory({
      ...staticCfg,
      paymentMethodsResponse: paymentMethods,
    });

    // ── 6. Create Apple Pay component ──
    // Note: applePayConfig may be absent when the request comes from a non-Safari
    // browser or a device without Apple Pay. isAvailable() will handle this
    // gracefully by rejecting, which hides the block. Pass an empty configuration
    // if the backend didn't return one so the component can still run its check.
    const applePayConfig = paymentMethods.paymentMethods?.find(
      (pm) => pm.type === 'applepay',
    );
    let selectedShippingMethod = null;

    const applePayComponent = new window.AdyenWeb.ApplePay(checkout, {
      configuration: applePayConfig?.configuration ?? {},
      isExpress: true,

      // Called when shopper selects a shipping address in the wallet sheet
      onShippingContactSelected: async (resolve, reject, event) => {
        try {
          const contact = event.shippingContact;

          // ── Step 0: Add product to cart (PDP only) ──
          // Deferred to here so page load does not silently accumulate cart items.
          // The idempotency guard in cart.js ensures this is a no-op on repeat calls.
          if (sku) {
            const qty = parseInt(
              document.querySelector(
                '.pdp-product__quantity input, [name="quantity"]',
              )?.value || '1',
              10,
            ) || 1;
            // Subscribe before calling addToCart so we don't miss the cart/data event.
            // cart/data.prices is undefined in the dropin payload; find the specific
            // SKU item so pre-existing cart items don't inflate the price.
            const pricePromise = new Promise((resolvePrice) => {
              const unsub = events.on('cart/data', (cartData) => {
                unsub.off();
                const cartItems = cartData?.items ?? [];
                const matched = cartItems.find(
                  (item) => item.sku === sku
                    || item.product?.sku === sku
                    || item.configurableProduct?.sku === sku,
                );
                const itemTotal = matched?.rowTotal?.value ?? matched?.price?.value ?? null;
                const itemCurrency = matched?.rowTotal?.currency
                  ?? matched?.price?.currency
                  ?? 'USD';
                resolvePrice(
                  itemTotal > 0
                    ? { value: itemTotal, currency: itemCurrency }
                    : null,
                );
              });
              // Timeout: if cart/data doesn't fire within 3s, resolve with null
              setTimeout(() => resolvePrice(null), 3000);
            });
            await addToCart(sku, qty);
            const priceResult = await pricePromise;
            if (priceResult?.value > 0) {
              cartTotalValue = priceResult.value;
              currency = priceResult.currency ?? currency;
            } else {
              // Fallback: if cart/data event didn't fire or timed out, refresh totals
              const refreshedTotal = await refreshCartTotals();
              if (refreshedTotal?.value !== undefined && refreshedTotal.value > 0) {
                console.debug('[applepay-express] Fallback: cart totals refreshed', {
                  previousTotal: cartTotalValue,
                  newTotal: refreshedTotal.value,
                });
                cartTotalValue = refreshedTotal.value;
                currency = refreshedTotal.currency ?? currency;
              }
            }
          }

          const methods = await estimateShipping({
            countryCode: contact.countryCode,
            region: contact.administrativeArea,
            postcode: contact.postalCode,
          });
          if (!methods.length) {
            reject({
              errors: [new window.ApplePayError('shippingContactInvalid')],
            });
            return;
          }
          [selectedShippingMethod] = methods;
          resolve({
            newShippingMethods: commerceToApplePayShippingMethods(methods),
            newTotal: { label: 'Total', amount: cartTotalValue.toFixed(2) },
          });
        } catch {
          reject({
            errors: [new window.ApplePayError('addressUnserviceable')],
          });
        }
      },

      // Called when shopper selects a shipping method in the wallet sheet
      onShippingMethodSelected: async (resolve, _reject, event) => {
        selectedShippingMethod = {
          carrierCode:
            event.shippingMethod.identifier?.split('_')[0]
            || event.shippingMethod.identifier,
          methodCode: event.shippingMethod.identifier,
        };
        resolve({});
      },

      // Called after shopper authorizes payment
      //
      // IMPORTANT: Apple Pay's sheet has a strict timeout. We MUST call resolve() or
      // reject() as fast as possible. To stay within the budget we only do the Adyen
      // /payments POST before resolving. All Commerce mutations (setGuestEmail, setBilling,
      // setShipping, setShippingMethod) and placeOrder happen AFTER resolve() — once the
      // sheet is dismissed, there is no timeout.
      onAuthorized: async (resolve, reject, event) => {
        const { payment } = event;
        const { billingContact } = payment;
        const { shippingContact } = payment;
        const billingAddress = applePayContactToCommerce(
          billingContact || shippingContact,
        );
        const shippingAddress = applePayContactToCommerce(shippingContact);

        // Use the Commerce account email for logged-in shoppers so the backend's
        // findCustomerByEmail lookup succeeds. For guests, use the wallet email.
        const walletEmail = shippingContact.emailAddress || '';
        const paymentShopperEmail = !isGuest && customerEmail ? customerEmail : walletEmail;

        // ── Step 0: Apply shipping method BEFORE payment submission ──
        // This ensures the backend cart includes shipping in its grandTotal during
        // payment validation. Error handling: if this fails, we still proceed to
        // payment to avoid hard failure — the setShipping() call in Step 3 will
        // apply the method again during order finalization.
        try {
          if (selectedShippingMethod) {
            console.debug('[applepay-express] Applying shipping method BEFORE payment', {
              carrierCode: selectedShippingMethod.carrierCode,
              methodCode: selectedShippingMethod.methodCode,
            });
            await setShippingMethod(selectedShippingMethod, cartId);
            console.debug('[applepay-express] Shipping method applied successfully', {
              cartId,
              methodCode: selectedShippingMethod.methodCode,
            });
          }
        } catch (err) {
          console.debug('[applepay-express] Warning: shipping method failed before payment:', err);
          // Continue to payment — order finalization will retry
        }

        // ── Step 1: POST /payments — the only async call before resolve ──
        let result;
        try {
          const res = await adyenFetch(
            `${backendUrl}payments`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cartId,
                isGuest: String(isGuest),
                scope,
                paymentRequest: {
                  ...payment.token.paymentData,
                  amount: formatAmount(cartTotalValue, currency),
                  paymentMethod: {
                    type: 'applepay',
                    applePayToken: payment.token.paymentData,
                  },
                  origin: window.location.origin,
                  reference: cartId,
                  shopperEmail: paymentShopperEmail,
                  shopperName: {
                    firstName: shippingContact.givenName || '',
                    lastName: shippingContact.familyName || '',
                  },
                },
              }),
            },
            { backendUrl, cartId, isGuest },
          );

          result = await res.json();

          // Adyen may return 'Authorised', 'Pending', or 'Received' for wallet payments.
          const SUCCESS_CODES = ['Authorised', 'Pending', 'Received'];
          if (!SUCCESS_CODES.includes(result.resultCode)) {
            showExpressError(
              container,
              'Payment was not authorised. Please try again.',
            );
            reject(new Error(result.resultCode));
            return;
          }
        } catch (err) {
          console.debug('[applepay-express] onAuthorized payment error:', err);
          showExpressError(
            container,
            'An error occurred while processing your payment.',
          );
          reject(err);
          return;
        }

        // ── Step 2: Resolve immediately — dismisses the Apple Pay sheet ──
        // Do NOT call reject() after this point under any circumstances.
        resolve({ status: window.ApplePaySession.STATUS_SUCCESS });

        // ── Step 3: Commerce mutations + place order (no sheet timeout here) ──
        // Errors here are logged only; the sheet is already dismissed.
        // Note: setShippingMethod was already called in Step 0 (before payment).
        // We call setShipping again here for data consistency during order finalization.
        try {
          if (isGuest) await setGuestEmail(walletEmail, cartId);
          await setBilling(billingAddress, cartId);
          await setShipping(shippingAddress, cartId);
          // setShippingMethod is idempotent and was already applied in Step 0 before payment

          const orderData = await placeOrderWithPayment(
            cartId,
            'adyen_applepay',
            result.pspReference,
            result.donationToken,
          );
          redirectToConfirmation(orderData);
        } catch (err) {
          console.debug(
            '[applepay-express] order placement error after payment authorised:',
            err,
          );
          showExpressError(
            container,
            'Payment was authorised but order placement failed. Please contact support.',
          );
        }
      },

      onPaymentFailed: () => showExpressError(container, 'Payment failed. Please try again.'),
      onError: (err) => showExpressError(container, err.message || 'An error occurred.'),
    });

    // ── 7. Check availability and mount ──
    // Awaiting isAvailable() keeps initExpressCheckout pending until the button
    // is either mounted or hidden — this lets product-details.js remove the
    // skeleton only after the availability check completes.
    try {
      await applePayComponent.isAvailable();
    } catch {
      block.style.display = 'none';
      return;
    }
    applePayComponent.mount(container);
  } catch (err) {
    console.debug('[applepay-express] init error:', err);
    block.style.display = 'none';
  } finally {
    hideExpressLoading(block);
  }
}

/**
 * Block entry point — returns a Promise that resolves once isAvailable() has
 * settled (button mounted or block hidden). product-details.js awaits this so
 * the skeleton is only removed after all wallet availability checks complete.
 *
 * @param {HTMLElement} block
 * @returns {Promise<void>}
 */
export default function decorate(block) {
  console.debug('[applepay-express] Block decorator starting...');

  // Hide on unsupported browsers (Chrome, Firefox, Edge, etc.)
  if (!isApplePaySupported()) {
    console.debug('[applepay-express] Not supported on this browser, hiding block');
    block.style.display = 'none';
    return Promise.resolve();
  }

  console.debug('[applepay-express] Browser supported, proceeding with initialization');

  const container = document.createElement('div');
  container.className = 'applepay-express-container';
  block.appendChild(container);

  showExpressLoading(block);

  // Return the promise so product-details.js can await it and remove the
  // skeleton only after isAvailable() + mount (or hide) completes.
  return initExpressCheckout(block, container);
}
