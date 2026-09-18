/**
 * Adyen Google Pay Express Checkout Block
 *
 * Google Pay is only available on Chrome, Edge, and Android browsers.
 * On Safari and Firefox, the block is hidden to avoid confusion.
 *
 * Renders a Google Pay button on Cart and PDP pages, driving a full express
 * checkout flow: resolve/create cart → SDK init → shipping estimation →
 * address + shipping method → POST /payments → place order → redirect.
 *
 * PDP usage: add `data-sku` attribute on the block element so the block can
 * add the product before starting the flow.
 *
 * Architecture — onAuthorized + actions.resolve(result):
 *
 * We use onAuthorized (not onSubmit) because only onAuthorized provides the full
 * Google Pay PaymentData object (authorizedEvent) containing email, billing address,
 * and full shipping address with street — none of which are surfaced in state.data
 * when onSubmit is used.
 *
 * Flow:
 *   onPaymentDataChanged (INITIALIZE / SHIPPING_ADDRESS) → estimateShipping
 *     → return shipping options
 *   onPaymentDataChanged (SHIPPING_OPTION) → update transactionInfo with selected method cost
 *   onAuthorized → (PDP: addToCart) → POST /payments → actions.resolve(result) → Commerce mutations
 *
 * Shipping is shown inside the Google Pay sheet via onPaymentDataChanged, which fires
 * for INITIALIZE (on sheet open), SHIPPING_ADDRESS (when shopper changes address), and
 * SHIPPING_OPTION (when shopper selects a method). This keeps estimateShipping off the
 * critical path of actions.resolve() — eliminating the ~6-minute hang that occurred
 * when Commerce was slow to respond inside the onAuthorized handler.
 *
 * callbackIntents: ['SHIPPING_ADDRESS', 'SHIPPING_OPTION'] trigger onPaymentDataChanged
 * only (NOT onpaymentmethodchange), so the Adyen SDK does NOT fire its internal
 * makePaymentsCall prematurely. The 'PAYMENT_METHOD' intent would trigger
 * onpaymentmethodchange and cause the SDK to call makePaymentsCall — we do NOT use it.
 *
 * Passing the payment result to actions.resolve(result) is critical. Without it the
 * SDK treats the resolve as "payment data collected, now make the call" and fires its
 * internal makePaymentsCall, which fails (IMPLEMENTATION_ERROR / token already consumed)
 * and causes Google Pay's native sheet to show a "Payment failed" overlay. With the
 * result passed in, the SDK short-circuits makePaymentsCall and cleanly dismisses the
 * sheet.
 *
 * The paymentSucceeded guard flag provides an additional safety net: if the SDK still
 * fires onPaymentFailed or onError despite the result being passed, the guard ensures
 * we do not show a false error modal to the user.
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
  googlePayAddressToCommerce,
  commerceToGooglePayShippingOptions,
  setGuestEmail,
  setBilling,
  setShipping,
  placeOrderWithPayment,
  redirectToConfirmation,
  getLoggedInCustomerEmail,
} from '../adyen-payment-express/index.js';

/**
 * Detects if the current browser supports Google Pay
 * Google Pay is available on Chrome, Edge, and Android browsers,
 * but NOT on Safari or Firefox
 * @returns {boolean} true if running on a browser that supports Google Pay
 */
function isGooglePaySupported() {
  const ua = window.navigator.userAgent;
  // eslint-disable-next-line no-console
  console.log('[Google Pay] Browser UA:', ua);
  // Safari: contains "Safari" but not "Chrome", "Firefox", "Edge"
  const isSafari = /Safari/.test(ua) && !/Chrome|Firefox|Edge|OPR/.test(ua);
  // Firefox
  const isFirefox = /Firefox/.test(ua);

  const result = !isSafari && !isFirefox;
  // eslint-disable-next-line no-console
  console.log('[Google Pay] isGooglePaySupported() - isSafari:', isSafari, 'isFirefox:', isFirefox, 'result:', result);
  return result;
}

/**
 * Lazy-load helper — defer cart resolution until authenticated event has fired.
 * Polls for window.__ADYEN_AUTH_STATE__ with extended timeout to ensure the
 * auth dropin has completed its initialization before resolveCart() is called.
 *
 * @param {number} maxWaitMs Maximum milliseconds to wait for auth state
 * @returns {Promise<boolean>} true if authenticated, false if guest or timeout
 */

/**
 * Async initializer — all heavy work (network calls, SDK load) runs here.
 * Separated from decorate() so decorate() can return immediately without
 * blocking the AEM loadSection/loadBlock pipeline and delaying first paint.
 *
 * @param {HTMLElement} block
 * @param {HTMLElement} container
 */
async function initExpressCheckout(block, container) {
  // eslint-disable-next-line no-console
  console.log('[Google Pay] initExpressCheckout() starting...');

  function showGPayClickLoader() {
    if (container.querySelector('.gpay-click-loader')) return;
    const loader = document.createElement('div');
    loader.className = 'gpay-click-loader';
    loader.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('div');
    spinner.className = 'gpay-click-loader__spinner';
    loader.appendChild(spinner);
    container.appendChild(loader);
  }

  function hideGPayClickLoader() {
    container.querySelector('.gpay-click-loader')?.remove();
  }

  try {
    // eslint-disable-next-line no-console
    console.log('[Google Pay] Wiring dropin GraphQL endpoints...');
    // ── 0. Wire dropin GraphQL endpoints ──
    // The cart and checkout dropins need to know the Commerce GraphQL URL before
    // any of their APIs can make network calls. CORE_FETCH_GRAPHQL is already
    // populated by initializeCommerce() which runs in loadEager before blocks run.
    setCartEndpoint(CORE_FETCH_GRAPHQL);
    setCheckoutEndpoint(CORE_FETCH_GRAPHQL);
    setOrderEndpoint(CORE_FETCH_GRAPHQL);
    // eslint-disable-next-line no-console
    console.log('[Google Pay] Endpoints wired');

    // ── 0.5. Wait for auth state to be set by authenticated event ──
    // The auth dropin fires the authenticated event asynchronously during its initialization.
    // We must wait for it before calling resolveCart(), which needs the correct isGuest value.
    // Extended timeout (15s) accommodates slower network conditions and dropin init.
    // eslint-disable-next-line no-console
    console.log('[Google Pay] Waiting for auth state before resolveCart()...');
    await waitForAuthState();
    // eslint-disable-next-line no-console
    console.log('[Google Pay] Auth state ready');

    // ── 1. Resolve the active cart ──
    const sku = block.dataset.sku || null;
    const { cartId, isGuest, isEmpty } = await resolveCart();
    console.debug('[googlepay-express] resolveCart() returned:', { cartId, isGuest, isEmpty });

    // Store CartID in sessionStorage so other blocks (and waitForCartId) can access it
    if (cartId) {
      sessionStorage.setItem('DROPINS_CART_ID', cartId);
    }

    // On the cart page (no sku), hide the block if the cart has no items.
    if (!sku && isEmpty) {
      block.style.display = 'none';
      return;
    }

    // ── 2. Parallel: initialize checkout dropin + fetch customer email + start backend URL ──
    // All three only need cartId (already available). Running them concurrently cuts
    // sequential latency by ~2 network round-trips before price resolution begins.
    const backendUrlPromise = resolveBackendUrl(cartId, isGuest);

    const [, customerEmail] = await Promise.all([
      // initializeCheckout sets the dropin's internal cartId so estimateShippingMethods works.
      initializeCheckout({ id: cartId }),
      // For authenticated shoppers use the Commerce account email (not wallet email) so the
      // backend's findCustomerByEmail lookup succeeds. Returns null for guests / on failure.
      isGuest ? Promise.resolve(null) : getLoggedInCustomerEmail(),
    ]);

    // ── 3. Determine initial price for payment sheet amounts ──
    // On PDP (sku present) the item is not yet in cart. Express blocks are loaded
    // by product-details.js after its Promise.all (which awaits dropin renders that
    // fire pdp/data), so lastPayload should already be populated. If not (prerendered
    // pages skip setMetaTags), fall back to the prerendered JSON-LD structured data.
    // Multiply unit price by the selected qty so the sheet shows the correct total.
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
            { method: 'GET', cache: 'no-cache' },
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

      // Price source 4: DOM text parsing.
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
            if (domPrice > 0) {
              unitPrice = domPrice;
            }
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
    // backendUrlPromise was started in step 2 (parallel with initializeCheckout).
    const backendUrl = await backendUrlPromise;
    if (!backendUrl) {
      throw new Error('Adyen backend URL unavailable');
    }

    // ── 4.5. Wait for cart/initialized event before fetching payment methods ──
    // This ensures CartID is available in sessionStorage for the backend call.
    // On PDP first load, the cart dropin may still be initializing when we reach
    // fetchPaymentMethods, so we defer the call until the cart/initialized event.
    console.debug('[GPay-express] Waiting for cart/initialized event before payment methods...');
    await waitForCartInitialized();
    console.debug('[GPay-express] cart/initialized event received, proceeding with fetchPaymentMethods');

    // ── 5. Parallel: fetch public config, then load SDK + payment methods concurrently ──
    const publicCfg = await fetchPublicConfiguration(backendUrl, scope, null, isGuest);
    const staticCfg = buildStaticConfig(publicCfg);
    let currency = cartCurrency || staticCfg.amount?.currency || 'USD';

    // loadAdyenWebSDK (CDN) and fetchPaymentMethods (App Builder) are independent —
    // run them in parallel to eliminate one sequential network round-trip.
    // Payment methods are now deferred until cart/initialized, so CartID is available.
    console.debug('[GPay-DEBUG] About to call fetchPaymentMethods with:', {
      isGuest,
      cartId,
      cartTotalValue,
      currency,
      customerEmail,
    });
    const [, paymentMethods] = await Promise.all([
      loadAdyenWebSDK(publicCfg.environment),
      fetchPaymentMethods(backendUrl, {
        countryCode: staticCfg.countryCode,
        amount: formatAmount(cartTotalValue, currency),
        shopperEmail: !isGuest && customerEmail ? customerEmail : '',
      }, null, isGuest),
    ]);

    // ── 7. Build AdyenCheckout instance ──
    // onSubmit is a true no-op (does NOT call actions.resolve/reject).
    // The Adyen SDK v6 registers its own onpaymentmethodchange handler internally
    // (regardless of whether we configure callbackIntents) and that handler always
    // calls makePaymentsCall, which requires onSubmit to exist. Without onSubmit the
    // SDK throws IMPLEMENTATION_ERROR, which it propagates back to the native Google
    // Pay sheet, causing the "Payment failed" overlay. Providing a no-op satisfies
    // the SDK's requirement without triggering a double-resolution: our actual payment
    // is handled in onAuthorized, which resolves via actions.resolve(result) before
    // onSubmit is ever called. The no-op simply returns undefined and the SDK's
    // internal makePaymentsCall chain resolves silently without error.
    const AdyenCheckoutFactory = getAdyenCheckoutFactory();
    const checkout = await AdyenCheckoutFactory({
      ...staticCfg,
      paymentMethodsResponse: paymentMethods,
      // eslint-disable-next-line no-unused-vars
      onSubmit: (_data, _actions) => {
        // Intentional no-op. Payment is handled in onAuthorized; this prevents
        // the SDK's internal makePaymentsCall from throwing IMPLEMENTATION_ERROR.
      },
    });

    // ── 8. Create Google Pay component ──

    // Guard flag: set to true as soon as onAuthorized begins so that the spurious
    // onPaymentFailed callback — which the SDK fires from the .catch() of its own
    // internal makePaymentsCall after actions.resolve() — does not show a false
    // error modal. See architecture note at top of file for full explanation.
    let paymentSucceeded = false;

    // lastShippingMethods holds the most-recently-estimated shipping options from
    // onPaymentDataChanged. onAuthorized reads this closure variable to determine
    // the selected method and cost without making any async calls on the critical
    // actions.resolve() path — eliminating the ~6-minute hang when Commerce is slow.
    let lastShippingMethods = [];

    // Declared as `let` so onClick can call googlePayComponent.update() before the
    // sheet opens — needed when cartTotalValue is 0 at init time (product price only
    // available from the cart mutation, e.g. products absent from Catalog Service pricing).
    const googlePayComponent = new window.AdyenWeb.GooglePay(checkout, {
      showPayButton: true,
      isExpress: true,
      // Collect shipping address and email from the Google Pay sheet.
      shippingAddressRequired: true,
      shippingAddressParameters: { phoneNumberRequired: false },
      shippingOptionRequired: true,
      emailRequired: true,
      // callbackIntents: 'SHIPPING_ADDRESS' and 'SHIPPING_OPTION' trigger
      // onPaymentDataChanged (NOT onpaymentmethodchange), so the Adyen SDK does NOT
      // fire its internal makePaymentsCall prematurely. The 'PAYMENT_METHOD' intent
      // would trigger onpaymentmethodchange and cause a spurious "Payment failed"
      // overlay — we intentionally omit it.
      callbackIntents: ['SHIPPING_ADDRESS', 'SHIPPING_OPTION'],
      transactionInfo: {
        totalPriceStatus: 'ESTIMATED',
        totalPrice: cartTotalValue.toFixed(2),
        currencyCode: currency,
        countryCode: staticCfg.countryCode || 'US',
      },

      // Called when: (a) the sheet opens (INITIALIZE trigger), (b) the shopper
      // changes their shipping address (SHIPPING_ADDRESS trigger), or (c) the shopper
      // selects a shipping method (SHIPPING_OPTION trigger).
      //
      // This is the safe place to call estimateShipping — it runs BEFORE authorization
      // so it does NOT block the actions.resolve() critical path. When Commerce is slow,
      // the sheet stays open during address selection (expected UX) instead of hanging
      // for minutes after the shopper taps "Pay".
      //
      // Must return a Promise resolving to a PaymentDataRequestUpdate object.
      // Returning an error stops the sheet; returning an empty object leaves the sheet unchanged.
      // NOTE: Adyen SDK v6 requires this inside `paymentDataCallbacks`, not as a top-level prop.
      paymentDataCallbacks: {
        onPaymentDataChanged: async (intermediatePaymentData) => {
          const { callbackTrigger, shippingAddress, shippingOptionData } = intermediatePaymentData;

          // Sheet is now visible — dismiss the click-to-sheet loader.
          if (callbackTrigger === 'INITIALIZE') hideGPayClickLoader();

          // On SHIPPING_OPTION: shopper picked a different method — no re-estimation needed,
          // just update the displayed total with the chosen method's cost.
          if (callbackTrigger === 'SHIPPING_OPTION') {
            const selectedId = shippingOptionData?.id;
            const selected = lastShippingMethods.find(
              (m) => m.code === selectedId,
            );

            // cartTotalValue is grand_total (already includes current shipping).
            // Don't add shipping again; just use the grand_total directly.
            const displayTotal = cartTotalValue;

            console.debug('[googlepay-express] onPaymentDataChanged SHIPPING_OPTION', {
              callbackTrigger,
              isGuest,
              selectedId,
              selectedMethod: selected ? {
                code: selected.code,
                title: selected.title,
                carrier: selected.carrier?.title,
              } : null,
              cartTotalValue,
              displayTotal,
              note: 'Using grand_total directly; shipping already included from cart',
            });

            return {
              newTransactionInfo: {
                totalPriceStatus: 'ESTIMATED',
                totalPrice: displayTotal.toFixed(2),
                currencyCode: currency,
                countryCode: staticCfg.countryCode || 'US',
              },
            };
          }

          // On INITIALIZE or SHIPPING_ADDRESS: estimate shipping for the (new) address.
          // For guests, extract the address from Google Pay, set it on the cart,
          // and fetch real shipping methods. This ensures Adobe Commerce has the
          // address and shipping cost upfront, so totals match payment amount.
          // Race against an 8s timeout — if Commerce is slow the sheet must still
          // resolve (an unresolved Promise causes the Google Pay sheet to spin
          // indefinitely).
          try {
            const addressToUse = shippingAddress;

            // For guests, set the Google Pay address on the cart first.
            // This ensures Adobe Commerce has the shipping address when calculating totals.
            // NOTE: For guests, address but NOT email yet (email comes in onAuthorized).
            // For logged-in shoppers, we use customerEmail for name extraction.
            if (isGuest && shippingAddress) {
              const commerceAddress = googlePayAddressToCommerce(
                shippingAddress,
                customerEmail || '',
              );
              const getNameSource = () => {
                if (!isGuest) return 'logged-in customer email';
                if (customerEmail) return 'guest will update in onAuthorized';
                return 'placeholder';
              };
              console.debug(
                '[googlepay-express] Before setShipping - Google Pay address converted',
                {
                  googlePayAddress: shippingAddress,
                  commerceAddress,
                  cartId,
                  hasEmail: !!customerEmail,
                  nameSource: getNameSource(),
                },
              );
              try {
                const setShippingStart = Date.now();
                await setShipping(commerceAddress, cartId);
                const setShippingDuration = Date.now() - setShippingStart;
                console.debug(
                  '[googlepay-express] After setShipping - address set successfully',
                  {
                    duration: `${setShippingDuration}ms`,
                    cartId,
                    address: commerceAddress,
                  },
                );
              } catch (addressError) {
                console.error(
                  '[googlepay-express] Failed to set guest shipping address',
                  {
                    error: addressError.message,
                    stack: addressError.stack,
                    cartId,
                    address: commerceAddress,
                  },
                );
                // Continue with estimation anyway — address setting is optional
              }
            }

            const estimatePromise = estimateShipping({
              countryCode: addressToUse?.countryCode,
              region: addressToUse?.administrativeArea,
              postcode: addressToUse?.postalCode,
            });
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error('estimateShipping timeout')),
                8000,
              );
            });
            const estimateStart = Date.now();
            const methods = await Promise.race([
              estimatePromise,
              timeoutPromise,
            ]);
            const estimateDuration = Date.now() - estimateStart;
            lastShippingMethods = methods ?? [];
            console.debug('[googlepay-express] After estimateShipping - results', {
              duration: `${estimateDuration}ms`,
              numMethods: lastShippingMethods.length,
              methods: lastShippingMethods.map((m) => ({
                code: m.code,
                title: m.title,
                carrier: m.carrier?.title,
                amount: m.amount?.value,
              })),
              address: {
                country: addressToUse?.countryCode,
                region: addressToUse?.administrativeArea,
                postcode: addressToUse?.postalCode,
              },
            });
          } catch (_e) {
            console.debug('[googlepay-express] estimateShipping failed', { error: _e.message });
            lastShippingMethods = [];
          }

          // For logged-in users, require shipping methods. For guests, if empty,
          // still proceed (will fall back to checkout-time shipping calculation).
          if (!lastShippingMethods.length && !isGuest) {
            return {
              error: {
                reason: 'SHIPPING_ADDRESS_UNSERVICEABLE',
                message: 'No shipping methods available for this address.',
                intent: 'SHIPPING_ADDRESS',
              },
            };
          }

          const cheapestCost = lastShippingMethods[0]?.amount?.value ?? 0;
          // PDP: cartTotalValue is product price only (no shipping on empty cart yet)
          // Cart: cartTotalValue is grand_total (already includes shipping)
          const displayTotal = sku ? (cartTotalValue + cheapestCost) : cartTotalValue;

          console.debug('[googlepay-express] onPaymentDataChanged INITIALIZE/SHIPPING_ADDRESS', {
            callbackTrigger,
            isGuest,
            cartTotalValue,
            cheapestCost,
            displayTotal,
            numMethods: lastShippingMethods.length,
            shippingAddressCountry: shippingAddress?.countryCode,
          });

          // Use real shipping methods if available, or create a placeholder.
          let shippingMethods = lastShippingMethods;
          if (!lastShippingMethods.length) {
            shippingMethods = [
              {
                code: 'standard',
                title: 'Standard Shipping',
                carrier: { title: 'Standard' },
                amount: { value: 0, currency },
              },
            ];
            console.debug('[googlepay-express] Using placeholder shipping (no methods available)', {
              method: shippingMethods[0],
            });
          }

          // Returns { shippingOptionParameters, transactionInfo } — destructure the wrapper.
          // Google Pay expects newShippingOptionParameters = { shippingOptions: [...] }
          const gpOptions = commerceToGooglePayShippingOptions(
            shippingMethods,
            { value: cartTotalValue, currency },
          );

          return {
            newShippingOptionParameters: gpOptions.shippingOptionParameters,
            newTransactionInfo: {
              totalPriceStatus: 'ESTIMATED',
              totalPrice: displayTotal.toFixed(2),
              currencyCode: currency,
              countryCode: staticCfg.countryCode || 'US',
            },
          };
        },
      }, // end paymentDataCallbacks

      // Called after shopper authorizes payment in the Google Pay sheet.
      // The SDK passes (data, actions) — must call actions.resolve() or actions.reject().
      // data.authorizedEvent is the raw Google Pay PaymentData object — the only place
      // where email, billing address, and full shipping address are available.
      //
      // IMPORTANT: Google Pay's sheet has a strict timeout (~10s total). We MUST call
      // actions.resolve() or actions.reject() as fast as possible.
      //
      // Strategy: shipping was already estimated in onPaymentDataChanged, so this handler
      // only needs to: (PDP) addToCart → POST /payments → actions.resolve().
      // No estimateShipping call here — that's what eliminated the ~6-minute hang.
      onAuthorized: async (data, actions) => {
        const { authorizedEvent } = data;

        // ── Guard: mark payment as in-progress immediately ──
        // The SDK always fires onPaymentFailed after actions.resolve() because its
        // internal makePaymentsCall (which runs after resolve) fails — the Google Pay
        // token was already consumed by our own /payments POST. Setting this flag here
        // before any await ensures onPaymentFailed is suppressed for the entire duration
        // of the authorized flow. Reset to false only on explicit actions.reject() paths.
        paymentSucceeded = true;
        hideGPayClickLoader();

        // Extract addresses and email synchronously from the authorized event.
        // authorizedEvent is the raw Google Pay PaymentData object — the only source
        // for the shopper's email, full shipping address (with street), and billing address.
        console.debug('[googlepay-express] onAuthorized handler START', {
          isGuest,
          cartTotalValue,
          timestamp: new Date().toISOString(),
        });

        const shippingAddress = googlePayAddressToCommerce(
          authorizedEvent.shippingAddress,
          authorizedEvent?.email || '',
        );
        console.debug('[googlepay-express] authorizedEvent.shippingAddress RAW:', {
          rawAddress: authorizedEvent.shippingAddress,
          keys: Object.keys(authorizedEvent.shippingAddress || {}),
        });
        const billingAddress = authorizedEvent.paymentMethodData?.info
          ?.billingAddress
          ? googlePayAddressToCommerce(
            authorizedEvent.paymentMethodData.info.billingAddress,
            authorizedEvent?.email || '',
          )
          : shippingAddress;

        // authorizedEvent.email is provided by Google Pay when emailRequired: true.
        const shopperEmail = authorizedEvent?.email || '';

        // Use the Commerce account email for logged-in shoppers so the backend's
        // findCustomerByEmail lookup succeeds. For guests, use the wallet email.
        const paymentShopperEmail = !isGuest && customerEmail ? customerEmail : shopperEmail;

        // ── Determine selected shipping method from onPaymentDataChanged state ──
        // lastShippingMethods was populated during address selection in onPaymentDataChanged —
        // no async call needed here. shippingOptionData.id matches the method code.
        const selectedId = authorizedEvent.shippingOptionData?.id;
        const selectedMethod = selectedId
          ? (lastShippingMethods.find((m) => m.code === selectedId)
             ?? lastShippingMethods[0])
          : lastShippingMethods[0];
        const selectedShippingMethod = selectedMethod
          ? {
            carrierCode:
                 selectedMethod.carrier?.code
                 || selectedMethod.code.split('_')[0]
                 || selectedMethod.code,
            methodCode: selectedMethod.code,
          }
          : null;
        const shippingCost = selectedMethod?.amount?.value ?? 0;

        // ── Note: Shipping already set in onPaymentDataChanged ──
        // In onPaymentDataChanged, we called setShipping() with a placeholder street
        // to estimate shipping methods. The shipping address is already persisted on
        // the backend cart with the postal code (which is all Commerce needs to calculate
        // the correct shipping cost). The real street from authorizedEvent is available
        // but not needed for payment validation — it will be set again in Step 4 during
        // order placement (line 977: await setShipping(shippingAddress, cartId)).
        //
        // Calling setShipping() again here is redundant and may interfere with the
        // cart state that refreshCartTotals() is about to query.
        console.debug('[googlepay-express] Shipping address already set in onPaymentDataChanged', {
          isGuest,
          cartId,
          selectedMethod: selectedMethod?.code,
          shippingCost,
          note: 'Real street will be set during order placement (Step 4)',
        });

        // ── Step 1: addToCart (PDP only) ──
        if (sku) {
          // addToCart is deferred to here so page loads do not silently accumulate
          // cart items. The idempotency guard in cart.js makes this a no-op if the
          // overlay-intercept path already ran addToCart for this SKU.
          const qty = parseInt(
            document.querySelector(
              '.pdp-product__quantity input, [name="quantity"]',
            )?.value || '1',
            10,
          ) || 1;
          let addStartTime;
          try {
            addStartTime = performance.now();
            console.debug('[googlepay-express] Starting addToCart', {
              sku,
              qty,
              currentTotal: cartTotalValue,
              timestamp: new Date().toISOString(),
            });

            await addToCart(sku, qty);
            console.debug('[googlepay-express] addToCart completed', {
              elapsedMs: Math.round(performance.now() - addStartTime),
            });
          } catch (err) {
            console.error('[googlepay-express] addToCart FAILED:', {
              error: err.message,
              stack: err.stack,
              elapsedMs: Math.round(performance.now() - addStartTime),
            });
            paymentSucceeded = false;
            actions.reject('Failed to add product to cart. Please try again.');
            return;
          }
        }

        // ── Step 2: Apply shipping method ──
        // Must happen before refreshCartTotals so backend cart includes shipping cost
        const currentCartId = sessionStorage.getItem('DROPINS_CART_ID') || cartId;
        if (selectedShippingMethod && currentCartId) {
          console.debug('[googlepay-express] Applying shipping method', {
            carrierCode: selectedShippingMethod.carrierCode,
            methodCode: selectedShippingMethod.methodCode,
            shippingCost,
            cartId: currentCartId,
            timestamp: new Date().toISOString(),
          });
          try {
            await setShippingMethod(selectedShippingMethod, currentCartId);
            console.debug('[googlepay-express] Shipping method applied successfully', {
              cartId: currentCartId,
              methodCode: selectedShippingMethod.methodCode,
            });
          } catch (shippingMethodError) {
            console.error('[googlepay-express] Failed to apply shipping method', {
              error: shippingMethodError.message,
              selectedShippingMethod,
              cartId: currentCartId,
            });
            // Continue — shipping was at least estimated
          }
        }

        // ── Step 3: Single refreshCartTotals after addToCart + applyShippingMethod ──
        // Both PDP and cart flows: refresh once to get true grand_total
        let totalWithShipping = cartTotalValue;
        try {
          const refreshStartTime = performance.now();
          console.debug('[googlepay-express] Starting refreshCartTotals', {
            timestamp: new Date().toISOString(),
          });

          const refreshedTotal = await refreshCartTotals();
          console.debug('[googlepay-express] refreshCartTotals completed', {
            elapsedMs: Math.round(performance.now() - refreshStartTime),
            refreshedTotal,
          });

          if (refreshedTotal?.value !== undefined) {
            totalWithShipping = refreshedTotal.value;
            console.debug('[googlepay-express] Cart totals refreshed', {
              isGuest,
              refreshedTotal: totalWithShipping,
              note: 'Using grand_total (includes shipping if applied)',
            });
          } else {
            console.warn('[googlepay-express] refreshCartTotals returned null - using cart value', {
              cartTotalValue,
            });
          }
        } catch (err) {
          console.error('[googlepay-express] refreshCartTotals FAILED:', {
            error: err.message,
            stack: err.stack,
          });
          paymentSucceeded = false;
          actions.reject('Failed to refresh cart totals. Please try again.');
          return;
        }

        // ── Step 4: POST /payments with final cart total (includes shipping) ──
        let result;
        try {
          const paymentAmount = formatAmount(totalWithShipping, currency);
          console.debug('[googlepay-express] Preparing payment request', {
            isGuest,
            totalWithShipping,
            currency,
            formattedAmount: paymentAmount,
            cartId,
            sku,
            timestamp: new Date().toISOString(),
          });

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
                  amount: paymentAmount,
                  paymentMethod: {
                    type: 'googlepay',
                    googlePayToken:
                      authorizedEvent?.paymentMethodData?.tokenizationData?.token,
                  },
                  origin: window.location.origin,
                  reference: cartId,
                  shopperEmail: paymentShopperEmail,
                  shopperName: {
                    firstName: shippingAddress.firstName,
                    lastName: shippingAddress.lastName,
                  },
                },
              }),
            },
            { backendUrl, cartId, isGuest },
          );

          result = await res.json();
          console.debug('[googlepay-express] Payment response received', {
            resultCode: result.resultCode,
            hasError: !!result.error,
            statusCode: res.status,
            fullResponse: result,
          });

          // Log any error details from backend
          if (result.error) {
            console.error('[googlepay-express] Backend error in payment response', {
              error: result.error,
              resultCode: result.resultCode,
              refusalReason: result.refusalReason,
              additionalData: result.additionalData,
              amountUsed: paymentAmount,
              cartTotal: cartTotalValue,
              shippingCost,
            });
          }

          // Adyen may return 'Authorised', 'Pending', or 'Received' for wallet payments.
          // Anything else (Refused, Cancelled, Error) is a genuine failure.
          const SUCCESS_CODES = ['Authorised', 'Pending', 'Received'];
          if (!SUCCESS_CODES.includes(result.resultCode)) {
            console.error(
              '[googlepay-express] payment not authorised:',
              result,
            );
            paymentSucceeded = false;
            actions.reject('Payment was not authorised. Please try again.');
            return;
          }
        } catch (err) {
          console.error('[googlepay-express] onAuthorized payment error:', {
            error: err.message,
            stack: err.stack,
          });
          paymentSucceeded = false;
          actions.reject('An error occurred while processing your payment.');
          return;
        }

        // ── Step 3: Resolve immediately — dismisses the Google Pay sheet ──
        // Pass the payment result so the SDK can use it directly instead of
        // attempting its internal makePaymentsCall (which would fail because the
        // Google Pay token is already consumed by our /payments POST above).
        actions.resolve(result);

        // ── Step 4: Commerce mutations + place order (no sheet timeout here) ──
        // Errors here are logged only; the sheet is already closed.
        try {
          if (isGuest) await setGuestEmail(shopperEmail, cartId);
          await setBilling(billingAddress, cartId);
          await setShipping(shippingAddress, cartId);
          // setShippingMethod already called in Step 2 (before payment submission) to ensure
          // backend cart includes shipping in grandTotal during payment validation. Calling here
          // is idempotent but unnecessary.

          const orderData = await placeOrderWithPayment(
            cartId,
            'adyen_googlepay',
            result.pspReference,
            result.donationToken,
          );
          redirectToConfirmation(orderData);
        } catch (err) {
          console.debug(
            '[googlepay-express] order placement error after payment authorised:',
            err,
          );
          showExpressError(
            container,
            'Payment was authorised but order placement failed. Please contact support.',
          );
        }
      },

      onPaymentFailed: () => {
        // Suppress the failure modal when payment was already authorised by us.
        // The SDK fires onPaymentFailed because its internal makePaymentsCall fails
        // after actions.resolve() — the token was already consumed. This is not a
        // real payment failure. See architecture note at top of file.
        hideGPayClickLoader();
        if (paymentSucceeded) return;
        showExpressError(container, 'Payment failed. Please try again.');
      },
      onError: (err) => {
        // Suppress errors triggered by the SDK's internal makePaymentsCall after
        // actions.resolve() — the token is already consumed, so the SDK always
        // errors here. This is not a real payment error. See architecture note.
        hideGPayClickLoader();
        if (paymentSucceeded) return;
        showExpressError(container, err.message || 'An error occurred.');
      },
    });

    // ── 9. Check availability and mount ──
    // Awaiting isAvailable() keeps initExpressCheckout pending until the button
    // is either mounted or hidden — this lets product-details.js remove the
    // skeleton only after the availability check completes.
    try {
      await googlePayComponent.isAvailable();
    } catch {
      block.style.display = 'none';
      return;
    }

    googlePayComponent.mount(container);

    // Show the click-to-sheet loader on every click on the rendered button.
    // Using a DOM listener (capture phase) instead of the Adyen onClick callback
    // because: (a) onClick is not called when submit() is invoked programmatically,
    // and (b) capture: true ensures we fire before any stopPropagation in Google's
    // internal button handlers.
    container.addEventListener('click', showGPayClickLoader, { capture: true });

    // Overlay intercept: if price was 0 at init (product absent from CS /
    // JSON-LD / DOM — e.g. B2B catalog restrictions or Commerce-only pricing),
    // we cannot open the Google Pay sheet with a $0 amount. Instead, mount a
    // transparent overlay that catches the first click, adds the product to cart
    // (the only way to resolve the price for these products), waits for the
    // cart/data event to get the real price, updates the component's
    // transactionInfo, then programmatically submits — all within Chrome's ~5s
    // user-activation window so the sheet opens without browser restriction.
    if (sku && !(cartTotalValue > 0)) {
      container.style.position = 'relative';
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;z-index:10;cursor:pointer;';
      container.appendChild(overlay);

      overlay.addEventListener(
        'click',
        async () => {
          // Show the loader immediately — the overlay intercept calls
          // googlePayComponent.submit() programmatically, which does NOT
          // trigger the container click listener, so we show it here.
          showGPayClickLoader();
          // Remove overlay immediately so subsequent clicks reach the real button.
          overlay.remove();
          try {
            const qty = parseInt(
              document.querySelector(
                '.pdp-product__quantity input, [name="quantity"]',
              )?.value || '1',
              10,
            ) || 1;

            // Subscribe to cart/data BEFORE addToCart so we don't miss the event.
            // cart/data.prices is undefined in the dropin payload; find the specific
            // SKU item so pre-existing cart items don't inflate the price.
            const pricePromise = new Promise((resolve) => {
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
                resolve(
                  itemTotal > 0
                    ? { value: itemTotal, currency: itemCurrency }
                    : null,
                );
              });
            });

            await addToCart(sku, qty);

            // Wait for cart/data (up to 4s — within Chrome's ~5s activation window).
            const priceResult = await Promise.race([
              pricePromise,
              new Promise((_, reject) => {
                setTimeout(() => reject(new Error('price timeout')), 4000);
              }),
            ]);

            if (priceResult?.value > 0) {
              cartTotalValue = priceResult.value;
              currency = priceResult.currency ?? currency;
              googlePayComponent.update({
                transactionInfo: {
                  totalPriceStatus: 'ESTIMATED',
                  totalPrice: cartTotalValue.toFixed(2),
                  currencyCode: currency,
                  countryCode: staticCfg.countryCode || 'US',
                },
              });
            }

            // Trigger the Google Pay sheet programmatically within the activation window.
            googlePayComponent.submit();
          } catch (err) {
            console.debug('[googlepay-express] overlay click error:', err);
            // Overlay already removed; user can click the real GP button.
          }
        },
        { once: true },
      );
    }
  } catch (err) {
    console.debug('[googlepay-express] init error:', err);
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
  // eslint-disable-next-line no-console
  console.log('[Google Pay] Block decorator starting...');

  // Hide on unsupported browsers (Safari, Firefox)
  if (!isGooglePaySupported()) {
    // eslint-disable-next-line no-console
    console.log('[Google Pay] Not supported on this browser, hiding block');
    block.style.display = 'none';
    return Promise.resolve();
  }

  // eslint-disable-next-line no-console
  console.log('[Google Pay] Browser supported, proceeding with initialization');

  const container = document.createElement('div');
  container.className = 'googlepay-express-container';
  block.appendChild(container);

  showExpressLoading(block);
  // eslint-disable-next-line no-console
  console.log('[Google Pay] Showing loading state, starting initExpressCheckout()');

  // Return the promise so product-details.js can await it and remove the
  // skeleton only after isAvailable() + mount (or hide) completes.
  return initExpressCheckout(block, container);
}
