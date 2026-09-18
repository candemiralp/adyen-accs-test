/**
 * Adyen PayPal Express Checkout Block
 *
 * Renders a PayPal button on Cart and PDP pages, driving a full express
 * checkout flow: resolve/create cart → SDK init → PayPal popup → shopper
 * details → address + shipping method → POST /payments → place order → redirect.
 *
 * PayPal differences from Apple/Google Pay:
 *  - No onShippingContactSelected; shipping is handled via onShopperDetails
 *    which fires after the shopper logs into the PayPal popup.
 *  - PayPal provides shippingAddress but NOT billingAddress → billing = shipping.
 *  - userAction: 'continue' — forces PayPal review screen; prevents One Touch auto-approval;
 *    ensures onShippingAddressChange fires so email can be captured via order.get().
 *
 * PDP usage: add `data-sku` attribute on the block element so the block can
 * add the product before starting the flow.
 */

import {
  getStoreConfigCache,
  setEndpoint as setCheckoutEndpoint,
} from '@dropins/storefront-checkout/api.js';
import {
  getCartData,
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
  hasAddedToCart,
  estimateShipping,
  setShippingMethod,
  paypalSdkAddressToCommerce,
  adyenPaypalAddressToCommerce,
  setGuestEmail,
  setBilling,
  setShipping,
  placeOrderWithPayment,
  redirectToConfirmation,
  getLoggedInCustomerEmail,
  isCartVirtual,
} from '../adyen-payment-express/index.js';

/**
 * Async initializer — all heavy work (network calls, SDK load) runs here.
 * Separated from decorate() so decorate() can return immediately without
 * blocking the AEM loadSection/loadBlock pipeline and delaying first paint.
 *
 * @param {HTMLElement} block
 * @param {HTMLElement} container
 */
async function initExpressCheckout(block, container) {
  const LOG = '[paypal-express]';
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
    await waitForAuthState();

    // ── 1. Resolve the active cart ──
    const sku = block.dataset.sku || null;
    console.debug(`${LOG} resolving cart (sku=${sku ?? 'none'})…`);
    const { cartId, isGuest, isEmpty } = await resolveCart();
    console.debug(
      `${LOG} cart resolved — cartId=${cartId} isGuest=${isGuest} isEmpty=${isEmpty}`,
    );

    // On the cart page (no sku), hide the block if the cart has no items.
    if (!sku && isEmpty) {
      console.debug(`${LOG} cart is empty — hiding block`);
      block.style.display = 'none';
      return;
    }

    // ── 2. Fetch the logged-in customer's Commerce email ──
    // For authenticated shoppers we must use the Commerce account email (not the
    // wallet email) so the backend's findCustomerByEmail lookup succeeds.
    // CORE_FETCH_GRAPHQL already has the Authorization bearer token set by the
    // auth initializer, so this works without any dropin internal auth state.
    // Returns null for guests or on failure; we fall back to the wallet email below.
    let customerEmail = null;
    if (!isGuest) {
      customerEmail = await getLoggedInCustomerEmail();
      if (customerEmail) {
        console.debug(`${LOG} authenticated shopper email resolved`);
      } else {
        console.warn(
          `${LOG} authenticated shopper detected but getLoggedInCustomerEmail() returned null — wallet email will be used as fallback`,
        );
      }
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
      const pdpData = events.lastPayload('pdp/data');
      const pdpFinal = pdpData?.prices?.final;
      const pdpRegular = pdpData?.prices?.regular;
      const pdpPrice = pdpFinal?.amount ?? pdpFinal?.minimumAmount ?? pdpRegular?.amount;
      if (pdpPrice > 0) {
        unitPrice = pdpPrice;
        unitCurrency = pdpFinal?.currency ?? pdpRegular?.currency ?? 'USD';
        console.debug(
          `${LOG} price resolved from pdp/data event — ${unitPrice} ${unitCurrency}`,
        );
      } else {
        console.debug(
          `${LOG} pdp/data price unavailable (pdpData=${JSON.stringify(pdpData?.prices ?? null)}), trying JSON-LD…`,
        );
      }

      // Price source 2: prerendered JSON-LD structured data.
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
              console.debug(
                `${LOG} price resolved from JSON-LD — ${unitPrice} ${unitCurrency}`,
              );
            } else {
              console.debug(
                `${LOG} JSON-LD present but no valid price (offer=${JSON.stringify(offer ?? null)})`,
              );
            }
          } else {
            console.debug(`${LOG} no JSON-LD <script> found on page`);
          }
        } catch (_e) {
          console.debug(`${LOG} JSON-LD parse error:`, _e);
        }
      }

      // Price source 3: Catalog Service GraphQL direct query.
      if (!(unitPrice > 0)) {
        try {
          // Also query priceRange on SimpleProductView — some products
          // (tier-priced, group-priced, or not fully indexed) return price: null
          // but still have a valid priceRange. This avoids the unitPrice=0 fallback
          // that causes the PayPal amount to be 0 and /payments to fail.
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
            console.debug(
              `${LOG} price resolved from Catalog Service GraphQL — ${unitPrice} ${unitCurrency}`,
            );
          } else {
            console.warn(
              `${LOG} Catalog Service GraphQL returned no price for sku=${sku} (product=${JSON.stringify(csProduct ?? null)})`,
            );
          }
        } catch (_e) {
          console.warn(
            `${LOG} Catalog Service GraphQL price query failed:`,
            _e,
          );
        }
      }

      // Price source 4: DOM text parsing (last resort).
      if (!(unitPrice > 0)) {
        const priceEl = document.querySelector('.pdp-price-range');
        if (priceEl) {
          const text = priceEl.textContent?.trim() ?? '';
          const match = text.match(/\d[\d,.]*\d|\d/);
          if (match) {
            const domPrice = parseFloat(match[0].replace(/,(?=\d{3}\b)/g, ''));
            if (domPrice > 0) {
              unitPrice = domPrice;
              console.debug(
                `${LOG} price resolved from DOM (.pdp-price-range) — ${unitPrice}`,
              );
            }
          } else {
            console.warn(
              `${LOG} .pdp-price-range found but no numeric price in text: "${text}"`,
            );
          }
        } else {
          console.warn(
            `${LOG} all price sources exhausted — .pdp-price-range not found; proceeding with unitPrice=0`,
          );
        }
      }

      cartTotalValue = unitPrice * qty;
      cartCurrency = unitCurrency;
      console.debug(
        `${LOG} PDP total — ${cartTotalValue} ${cartCurrency} (qty=${qty})`,
      );
    } else {
      const cartCache = getCartDataFromCache();
      const cartTotal = cartCache?.prices?.grand_total
        ?? cartCache?.total?.includingTax
        ?? null;
      cartTotalValue = cartTotal?.value ?? 0;
      cartCurrency = cartTotal?.currency ?? 'USD';
      console.debug(`${LOG} cart total — ${cartTotalValue} ${cartCurrency}`);
      if (!cartTotal) {
        console.warn(
          `${LOG} cart grand_total not found in cache (cartCache.prices=${JSON.stringify(cartCache?.prices ?? null)})`,
        );
      }
    }

    // ── 3. Resolve scope + backend URL ──
    const storeConfig = getStoreConfigCache();
    const scope = storeConfig?.code
      || (await getConfigValue('headers.cs.Magento-Store-View-Code'));
    console.debug(`${LOG} scope=${scope ?? '(none)'}`);

    console.debug(`${LOG} resolving backend URL…`);
    const backendUrl = await resolveBackendUrl(cartId, isGuest);
    if (!backendUrl) throw new Error('Adyen backend URL unavailable');
    console.debug(`${LOG} backendUrl=${backendUrl}`);

    // ── 4. Load SDK + public config ──
    const publicCfg = await fetchPublicConfiguration(
      backendUrl,
      scope,
      null,
      isGuest,
    );
    await loadAdyenWebSDK(publicCfg.environment);
    console.debug(`${LOG} Adyen Web SDK loaded`);

    const staticCfg = buildStaticConfig(publicCfg);
    console.debug(
      `${LOG} staticCfg — environment=${staticCfg.environment} countryCode=${staticCfg.countryCode} locale=${staticCfg.locale}`,
    );
    let currency = cartCurrency || staticCfg.amount?.currency || 'USD';

    // ── 5. Fetch payment methods with real cart amount ──
    // Adyen omits PayPal from the /paymentMethods response when
    // amount.value === 0. On PDP the real price isn't known until after the
    // shopper clicks the button and addToCart fires. Use a sentinel of 1
    // (1 minor unit = $0.01) so PayPal is included in the response. The real
    // amount is set on the checkout instance and updated via paypalComponent.update()
    // inside onShopperDetails once cart/data resolves the actual price.
    const pmAmount = sku && cartTotalValue === 0
      ? { value: 1, currency }
      : formatAmount(cartTotalValue, currency);
    console.debug(
      `${LOG} fetching payment methods (countryCode=${staticCfg.countryCode} amount=${JSON.stringify(pmAmount)})…`,
    );
    const paymentMethods = await fetchPaymentMethods(
      backendUrl,
      {
        countryCode: staticCfg.countryCode,
        amount: formatAmount(cartTotalValue, currency),
        shopperEmail: !isGuest && customerEmail ? customerEmail : '',
      },
      null,
      isGuest,
    );

    // ── 5. Build AdyenCheckout instance ──
    // Pass `amount` on the checkout instance so the Adyen SDK can
    // create a valid PayPal order. When cartTotalValue is 0 (price unavailable
    // at mount time on PDP) use the same sentinel of 1 minor unit. The actual
    // amount is updated via paypalComponent.update() inside onShopperDetails
    // once the real price is resolved from cart/data.
    const initialAmount = sku && cartTotalValue === 0
      ? { value: 1, currency }
      : formatAmount(cartTotalValue, currency);
    console.debug(
      `${LOG} creating AdyenCheckout instance (initialAmount=${JSON.stringify(initialAmount)})…`,
    );
    const AdyenCheckoutFactory = getAdyenCheckoutFactory();
    const checkout = await AdyenCheckoutFactory({
      ...staticCfg,
      amount: initialAmount,
      paymentMethodsResponse: paymentMethods,
    });
    console.debug(`${LOG} AdyenCheckout instance created`);

    // Tracks the shipping address from onShippingAddressChange for use in onSubmit.
    // The Adyen SDK populates state.data.deliveryAddress after onApprove, but we
    // also cache the partial address here so onSubmit can fall back to it.
    let cachedShippingAddress = null;
    // Tracks the selected shipping method across onShippingOptionsChange → onSubmit.
    // selectedShippingMethodCode is the combined "carrier_code_method_code" reference
    // used as the PayPal deliveryMethods[].reference value.
    // selectedShippingCarrierCode stores the carrier part separately to avoid fragile
    // split('_') logic on codes like "flat_rate".
    let selectedShippingMethodCode = null;
    let selectedShippingCarrierCode = null;
    // Caches the PayPal account email from onAuthorized (payer.email_address).
    // state.data.shopperEmail is not populated by the PayPal SDK for express/order
    // flows, so we extract it here from the full PayPal order object.
    let cachedShopperEmail = null;
    // Caches the PayPal orderID from createOrder so onSubmit can pass it to the
    // backend for server-side payer email lookup.
    let cachedOrderID = null;
    // Caches the /payments result (pspReference, donationToken) so onAuthorized
    // can use it to place the order after the PayPal popup approves.
    let cachedPaymentResult = null;
    // Guards against double order placement: the BA- (Billing Agreement) flow
    // returns Authorised directly in onSubmit (no action), then onAuthorized also
    // fires. We must place the order exactly once.
    let orderPlaced = false;
    // Set to true at Buttons() intercept time when the SDK config contains
    // createBillingAgreement but no createOrder — i.e. vault/BA- flow.
    // Used in wrapOnApprove to skip originalOnApprove without relying on
    // data.token (which is undefined in this flow).
    let isBillingAgreementFlow = false;

    // ── Intercept window.paypal to patch Buttons.onApprove ──
    // The PayPal JS SDK is loaded asynchronously by the Adyen SDK inside mount().
    // Adyen immediately calls window.paypal.Buttons(config) to render the button.
    //
    // Strategy: install a permanent getter/setter on window.paypal so every
    // assignment (PayPal SDK may write window.paypal multiple times during its own
    // initialisation) is intercepted. We do NOT restore to a plain property — that
    // was the prior bug: a second write from PayPal SDK would bypass the interceptor.
    //
    // Similarly, Buttons is kept as a permanent getter/setter on paypalObj so any
    // internal reassignment by the PayPal SDK is also re-wrapped.
    //
    // For the BA- (Billing Agreement) flow, onApprove skips originalOnApprove and
    // manually calls /payments/details. The payer email is sourced from
    // actions.order.get() (payer.email_address) before /payments/details is called,
    // because the Adyen vault flow returns resultCode=Received (no additionalData.paypalEmail).
    //

    // Wraps config.onApprove; for BA- flow, handles /payments/details + order placement.
    const wrapOnApprove = (originalOnApprove) => async (data, actions) => {
      console.info(
        `${LOG} onApprove wrapper FIRED — orderID=${data?.orderID} isBillingAgreementFlow=${isBillingAgreementFlow}`,
      );
      // In the BA- (intent=tokenize / Billing Agreement) flow the Adyen SDK's
      // internal onApprove handler calls actions.order.get() via its own internal
      // proxy, which is undefined in the BA- flow — causing a crash regardless of
      // what `actions` we pass. data.token is also undefined at this point (the
      // BA- token only appears later in /payments response sdkData.token), so we
      // cannot detect the flow from data alone.
      //
      // Solution: use the isBillingAgreementFlow flag captured at Buttons() intercept
      // time (set when config has createBillingAgreement and no createOrder).
      // We skip originalOnApprove to avoid the crash, then manually call
      // /payments/details (which the Adyen SDK would have called internally) to
      // finalise the payment, then do Commerce mutations + place order.
      // onAuthorized will NOT fire in this path (Adyen only calls it after its own
      // /payments/details call which we've bypassed).
      if (isBillingAgreementFlow) {
        console.info(
          `${LOG} onApprove — BA flow, skipping originalOnApprove; calling /payments/details manually`,
        );
        // Call backend /payments/details with the paymentData from the /payments action
        // and empty details (BA- flow requires no extra challenge data).
        try {
          // BA- (vault) flow is only available to authenticated shoppers.
          // resolveCart() may return isGuest=true if the auth_dropin_user_token
          // cookie is not yet set when the PDP block initialises. Override it:
          // if we reached the BA- branch the shopper is definitionally logged in.
          //
          const baIsGuest = isGuest; // BA- flow is not exclusive to logged-in shoppers
          // Fire paypal-payer-info now so its round-trip overlaps with
          // actions.order.get() and /payments/details. Without pspReference the
          // backend skips AIO State polling and goes straight to merchant-OAuth
          // Orders v2 (~1-2 s). Awaited below only if email is still missing.
          const baToken = data?.billingToken || cachedPaymentResult?.billingToken;
          const payerInfoPromise = baIsGuest && baToken
            ? adyenFetch(
              `${backendUrl}paypal-payer-info`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  billingToken: baToken,
                  cartId,
                }),
              },
              { backendUrl, cartId, isGuest },
            ).catch(() => null)
            : null;

          // The paypal-payer-info action now uses stored PayPal Client ID
          // and Secret credentials to authenticate with PayPal OAuth and get a token
          // with full scope to query the PayPal Orders API. This bypasses the limitation
          // of the facilitatorAccessToken which only has payment-facilitation scope.
          if (data?.orderID) {
            try {
              const orderDetails = await actions?.order?.get?.();
              const sdkEmail = orderDetails?.payer?.email_address;
              if (sdkEmail && !cachedShopperEmail) cachedShopperEmail = sdkEmail;
              // Also cache shipping address from the order's purchase unit shipping
              // address if not already set. Avoids needing data.billingAddress or
              // a Commerce customer address lookup.
              const sdkShipping = orderDetails?.purchase_units?.[0]?.shipping;
              if (sdkShipping && !cachedShippingAddress) {
                const addr = sdkShipping.address || {};
                const fullName = sdkShipping.name?.full_name
                  || cachedShopperEmail?.split('@')[0]
                  || 'PayPal User';
                const nameParts = fullName.split(' ');
                cachedShippingAddress = {
                  firstName: nameParts[0] || 'PayPal',
                  lastName: nameParts.slice(1).join(' ') || 'User',
                  street:
                    [addr.address_line_1, addr.address_line_2]
                      .filter(Boolean)
                      .join(' ') || 'N/A',
                  city: addr.admin_area_2 || addr.admin_area_1 || 'N/A',
                  countryCode: addr.country_code || '',
                  postcode: addr.postal_code || '',
                  region: addr.admin_area_1 || '',
                  telephone: '0000000000',
                };
              }
            } catch (orderGetErr) {
              console.warn(
                `${LOG} onApprove BA- — actions.order.get() failed: ${orderGetErr}`,
              );
            }
          }

          const pdRes = await adyenFetch(
            `${backendUrl}payments-details`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cartId,
                isGuestCart: String(isGuest === true),
                scope,
                paymentData: cachedPaymentResult?.paymentData,
                // Adyen requires the BA- billing agreement token in details.billingToken
                // for the /payments/details call in the vault flow.
                details: { billingToken: cachedPaymentResult?.billingToken },
              }),
            },
            { backendUrl, cartId, isGuest },
          );

          // Validate HTTP response status
          if (!pdRes.ok) {
            const errMsg = `Payment details request failed: ${pdRes.status}`;
            console.error(`${LOG} onApprove BA- /payments/details error: ${errMsg}`, {
              status: pdRes.status,
              statusText: pdRes.statusText,
            });
            showExpressError(
              container,
              'Payment processing error. Please try again.',
            );
            return undefined;
          }

          const pdRawText = await pdRes.text();
          let pdResult;
          try {
            pdResult = JSON.parse(pdRawText);
          } catch (parseErr) {
            console.error(
              `${LOG} onApprove BA- /payments/details: JSON parse error: ${parseErr.message}`,
              { rawText: pdRawText },
            );
            pdResult = {};
          }

          // Validate response has required resultCode field
          if (!pdResult?.resultCode) {
            console.error(
              `${LOG} onApprove BA- /payments/details: Missing resultCode in response`,
              { response: pdResult },
            );
            showExpressError(
              container,
              'Invalid payment response. Please try again.',
            );
            return undefined;
          }

          console.info(
            `${LOG} onApprove BA- /payments/details: resultCode=${pdResult?.resultCode} pspReference=${pdResult?.pspReference}`,
          );

          const SUCCESS_CODES = ['Authorised', 'Received'];
          if (!SUCCESS_CODES.includes(pdResult?.resultCode)) {
            console.warn(
              `${LOG} onApprove BA- — payment not authorised: ${pdResult?.resultCode}`,
            );
            showExpressError(
              container,
              'Payment was not authorised. Please try again.',
            );
            return undefined;
          }

          // Validate pspReference is present before using it
          if (!pdResult?.pspReference) {
            console.error(
              `${LOG} onApprove BA- /payments/details: Missing pspReference in authorised response`,
              { resultCode: pdResult.resultCode },
            );
            showExpressError(
              container,
              'Payment processed but reference unavailable.',
            );
            return undefined;
          }

          // Extract payer email from Adyen /payments/details additionalData.
          // In BA- flow cachedShopperEmail is null at onSubmit time (onAuthorized
          // never fires), so paypalEmail from the Authorised response is the only
          // reliable source for guest order placement.
          const paypalEmail = pdResult?.additionalData?.paypalEmail || '';
          if (paypalEmail && !cachedShopperEmail) cachedShopperEmail = paypalEmail;

          // BA- flow: onShippingAddressChange never fires, so addToCart is never
          // called before onApprove. Add the item now if it hasn't been added yet.
          //
          if (sku && !hasAddedToCart(sku)) {
            const qty = parseInt(
              document.querySelector(
                '.pdp-product__quantity input, [name="quantity"]',
              )?.value || '1',
              10,
            ) || 1;
            await addToCart(sku, qty);
          }

          // BA- flow: onShippingAddressChange never fires, so cachedShippingAddress
          // is null. Resolution order:
          //   1. data.billingAddress from the onApprove callback (PayPal SDK provides
          //      the shopper's selected billing address here in the BA- vault flow)
          //   2. Minimal stub built from paypalPayerResidenceCountry as last resort
          // NOTE: Do NOT fall back to Commerce customer's saved address, as it may be
          // in a different country than the PayPal-selected address, causing
          // region_id validation errors. Always use PayPal's address or a stub,
          // never the customer's pre-existing address.
          // Some countries (CA, US, AU, etc.) require a non-empty region/state
          // and postcode. Provide per-country placeholder defaults to satisfy
          // Commerce address validation when the real value is unavailable.
          const DEFAULT_REGION_BY_COUNTRY = {
            CA: 'AB',
            US: 'NY',
            AU: 'NSW',
            IN: 'DL',
          };
          const DEFAULT_POSTCODE_BY_COUNTRY = {
            CA: 'A1A 1A1',
            US: '00000',
            AU: '2000',
            IN: '110001',
          };

          if (!cachedShippingAddress) {
            // Priority 1: use the billing address supplied by the PayPal SDK in data.
            // PayPal SDK shape: { city, state, countryCode, postalCode,
            //                     line1, line2, recipientName }
            // We need: firstName, lastName, street, city, countryCode, postcode,
            //          region, telephone
            if (data?.billingAddress?.countryCode) {
              const ba = data.billingAddress;
              const recipientFallback = cachedShopperEmail?.split('@')[0] || 'PayPal User';
              const nameParts = (ba.recipientName || recipientFallback).split(
                ' ',
              );
              const baFirstName = nameParts[0] || 'PayPal';
              const baLastName = nameParts.slice(1).join(' ') || 'User';
              const baCountry = ba.countryCode;
              cachedShippingAddress = {
                firstName: baFirstName,
                lastName: baLastName,
                street: [ba.line1 || 'PayPal Express', ba.line2].filter(
                  Boolean,
                ),
                city: ba.city || 'Unknown',
                countryCode: baCountry,
                postcode:
                   ba.postalCode
                   || DEFAULT_POSTCODE_BY_COUNTRY[baCountry]
                   || '00000',
                region: ba.state || DEFAULT_REGION_BY_COUNTRY[baCountry] || '',
                telephone: '',
              };
              console.info(
                `${LOG} onApprove BA- — shipping address from data.billingAddress: ${baCountry}`,
              );
            }
            // Priority 2: minimal stub from PayPal payer residence country.
            // Applies to all users (guests and logged-in with no default address).
            if (!cachedShippingAddress) {
              const residenceCountry = pdResult?.additionalData?.paypalPayerResidenceCountry
                || cachedPaymentResult?.additionalData
                  ?.paypalPayerResidenceCountry
                || '';
              const payerFirstName = (cachedShopperEmail || '').split('@')[0] || 'PayPal';
              const fallbackRegion = DEFAULT_REGION_BY_COUNTRY[residenceCountry] || '';
              const fallbackPostcode = DEFAULT_POSTCODE_BY_COUNTRY[residenceCountry] || '00000';
              if (residenceCountry) {
                cachedShippingAddress = {
                  firstName: payerFirstName,
                  lastName: 'User',
                  street: ['PayPal Express'],
                  city: 'Unknown',
                  countryCode: residenceCountry,
                  postcode: fallbackPostcode,
                  region: fallbackRegion,
                  telephone: '',
                };
                console.info(
                  `${LOG} onApprove BA- — shipping address stub from paypalPayerResidenceCountry: ${residenceCountry}`,
                );
              } else {
                console.warn(
                  `${LOG} onApprove BA- — no address source found; will skip address mutations`,
                );
              }
            }
          }

          // For guest BA- flow, cachedShopperEmail may still be null
          // if /payments/details returned resultCode=Received (async) with no
          // additionalData.paypalEmail. Use the PayPal billing agreements API via
          // facilitatorAccessToken (provided by the PayPal JS SDK in onApprove
          // data) to retrieve the payer email before calling setGuestEmailOnCart.
          if (baIsGuest && !cachedShopperEmail) {
            // Await the paypal-payer-info Promise fired in parallel earlier.
            // facilitatorAccessToken / baToken are declared above.
            if (payerInfoPromise) {
              try {
                const payerInfoRes = await payerInfoPromise;
                if (payerInfoRes?.ok) {
                  const payerInfoData = await payerInfoRes.json();
                  if (payerInfoData?.email) {
                    cachedShopperEmail = payerInfoData.email;
                    console.info(
                      `${LOG} onApprove BA- — guest email resolved via paypal-payer-info`,
                    );
                  } else {
                    console.warn(
                      `${LOG} onApprove BA- — paypal-payer-info returned no email`,
                    );
                  }
                  // If the Orders v2 path also returned a shipping address and we
                  // don't already have one, convert it to the Commerce shape.
                  if (payerInfoData?.shipping && !cachedShippingAddress) {
                    const s = payerInfoData.shipping;
                    const fullName = s?.name?.full_name || '';
                    const nameParts = fullName.trim().split(/\s+/);
                    cachedShippingAddress = {
                      firstName: nameParts[0] || 'PayPal',
                      lastName: nameParts.slice(1).join(' ') || 'User',
                      street: [
                        s?.address?.address_line_1 || 'PayPal Express',
                        s?.address?.address_line_2,
                      ].filter(Boolean),
                      city: s?.address?.admin_area_2 || '',
                      countryCode: s?.address?.country_code || '',
                      postcode: s?.address?.postal_code || '',
                      region: s?.address?.admin_area_1 || '',
                    };
                    console.info(
                      `${LOG} onApprove BA- — shipping address resolved via paypal-payer-info`,
                    );
                  }
                } else if (payerInfoRes) {
                  let payerInfoErrBody = '';
                  try {
                    payerInfoErrBody = await payerInfoRes.text();
                  } catch (_) {
                    /* ignore */
                  }
                  console.warn(
                    `${LOG} onApprove BA- — paypal-payer-info HTTP ${payerInfoRes.status}: ${payerInfoErrBody}`,
                  );
                }
              } catch (payerInfoErr) {
                console.warn(
                  `${LOG} onApprove BA- — paypal-payer-info failed: ${payerInfoErr}`,
                );
              }
            }
            // If email is still unavailable after all attempts, abort with a
            // user-friendly message rather than calling setGuestEmailOnCart with
            // an empty string (which throws "Required parameter email is missing").
            //
            if (!cachedShopperEmail) {
              showExpressError(
                container,
                "We couldn't retrieve your email from PayPal. Please complete your order on the checkout page.",
              );
              return undefined;
            }
          }

          // Commerce mutations + place order (mirrors onAuthorized logic).
          const finalEmail = cachedShopperEmail || '';
          const emptyAddress = {
            firstName: '',
            lastName: '',
            street: [''],
            city: '',
            countryCode: '',
            postcode: '',
            region: '',
            telephone: '',
          };
          const shippingAddress = cachedShippingAddress || emptyAddress;
          const billingAddress = shippingAddress;
          const hasAddress = !!(
            shippingAddress.countryCode || shippingAddress.city
          );
          const pspRef = pdResult?.pspReference || cachedPaymentResult?.pspReference;
          const donToken = pdResult?.donationToken || cachedPaymentResult?.donationToken;
          if (baIsGuest) await setGuestEmail(finalEmail, cartId);

          // Virtual carts have no shippable items — skip all shipping mutations.
          // We fetch is_virtual directly because dropin state is not populated
          // in the express-checkout flow.
          const virtualCart = await isCartVirtual(cartId);
          console.warn(`${LOG} onApprove BA- — isVirtual=${virtualCart}`);

          if (!virtualCart) {
            if (hasAddress) {
              await setBilling(billingAddress, cartId);
              await setShipping(shippingAddress, cartId);
            }
            if (selectedShippingMethodCode) {
              // Use selectedShippingCarrierCode (tracked separately) to correctly split
              // codes like "flat_rate_flatrate" where the carrier itself contains "_".
              const sCarrier = selectedShippingCarrierCode || selectedShippingMethodCode;
              const sMethodSuffix = selectedShippingCarrierCode
                ? selectedShippingMethodCode.slice(
                  selectedShippingCarrierCode.length + 1,
                )
                : '';
              const sMethod = sMethodSuffix || selectedShippingMethodCode;
              await setShippingMethod(
                { carrierCode: sCarrier, methodCode: sMethod },
                cartId,
              );
            } else if (hasAddress) {
              // BA- flow: no shipping method was selected via onShippingAddressChange.
              // Estimate available methods and auto-select the first one.
              // If the stub country (e.g. CA) returns no methods, retry with US as a
              // fallback — the stub address is fictional so any valid country works.
              // Also update cachedShippingAddress so setBilling/setShipping above used
              // the right country.
              let shippingCountry = shippingAddress.countryCode;
              let methods = await estimateShipping(
                {
                  countryCode: shippingCountry,
                  region: shippingAddress.region || '',
                  postcode: shippingAddress.postcode || '',
                },
                cartId,
              );
              if (!methods.length && shippingCountry !== 'US') {
                console.warn(
                  `${LOG} onApprove BA- — no shipping for ${shippingCountry}, retrying with US`,
                );
                shippingCountry = 'US';
                methods = await estimateShipping(
                  {
                    countryCode: 'US',
                    region: DEFAULT_REGION_BY_COUNTRY.US,
                    postcode: DEFAULT_POSTCODE_BY_COUNTRY.US,
                  },
                  cartId,
                );
                if (methods.length) {
                  // Update the address to US so setBilling/setShipping succeed with
                  // the same country as the shipping method.
                  cachedShippingAddress = {
                    ...shippingAddress,
                    countryCode: 'US',
                    region: DEFAULT_REGION_BY_COUNTRY.US,
                    postcode: DEFAULT_POSTCODE_BY_COUNTRY.US,
                  };
                  await setBilling(cachedShippingAddress, cartId);
                  await setShipping(cachedShippingAddress, cartId);
                }
              }
              if (methods.length) {
                const firstMethod = methods[0];
                // Use the normalised carrier object from estimateShipping to avoid
                // mis-splitting codes like "flat_rate" that contain underscores.
                const carrierCode = firstMethod.carrier?.code || firstMethod.code;
                const methodCode = firstMethod.carrier?.code
                  ? firstMethod.code.slice(
                    firstMethod.carrier.code.length + 1,
                  ) || firstMethod.code
                  : firstMethod.code;
                await setShippingMethod({ carrierCode, methodCode }, cartId);
                console.warn(
                  `${LOG} onApprove BA- — auto-selected shipping: carrierCode=${carrierCode} methodCode=${methodCode}`,
                );
              } else {
                // No shipping methods returned (e.g. ACO sandbox sync delay).
                // Fall back to free shipping so the order can still be placed.
                // If freeshipping is also unavailable Commerce will reject the
                // setShippingMethod mutation with a clear error.
                console.warn(
                  `${LOG} onApprove BA- — no shipping methods returned, falling back to freeshipping`,
                );
                await setShippingMethod(
                  { carrierCode: 'freeshipping', methodCode: 'freeshipping' },
                  cartId,
                );
              }
            }
          }

          orderPlaced = true;
          const orderData = await placeOrderWithPayment(
            cartId,
            'adyen_paypal',
            pspRef,
            donToken,
          );
          redirectToConfirmation(orderData);
        } catch (err) {
          console.error(`${LOG} onApprove BA- — order placement failed:`, err);
          showExpressError(
            container,
            'Payment was authorised but order placement failed. Please contact support.',
          );
        }
        return undefined;
      }

      return originalOnApprove(data, actions);
    };

    // Install a permanent getter/setter on paypalObj.Buttons so any (re-)assignment
    // by the PayPal SDK is transparently wrapped. The raw function is stored in
    // _rawButtons; the getter returns a wrapper that intercepts config.onApprove.
    const installButtonsSetter = (paypalObj) => {
      if (paypalObj.__adyen_buttons_hooked__) return;
      let _rawButtons;
      try {
        _rawButtons = paypalObj.Buttons; // may be undefined at first call
        Object.defineProperty(paypalObj, 'Buttons', {
          configurable: true,
          enumerable: true,
          // eslint-disable-next-line object-shorthand, func-names
          get: function () {
            return (config) => {
              console.warn(
                `${LOG} Buttons() called — config keys=${Object.keys(config || {}).join(',')}`,
              );
              if (config?.onApprove) {
                console.warn(`${LOG} Buttons() — onApprove found, wrapping`);
                // eslint-disable-next-line no-param-reassign
                config.onApprove = wrapOnApprove(config.onApprove);
              } else {
                console.warn(`${LOG} Buttons() — no onApprove in config`);
              }
              // Wrap createOrder to capture the PayPal orderID as soon as the
              // order is created (on button click, before popup opens). We store
              // it in cachedOrderID so onSubmit can pass it to the backend for
              // a server-side payer email lookup.
              if (config?.createOrder) {
                const originalCreateOrder = config.createOrder;
                // eslint-disable-next-line no-param-reassign
                config.createOrder = async (...args) => {
                  const orderID = await originalCreateOrder(...args);
                  cachedOrderID = orderID;
                  console.warn(
                    `${LOG} createOrder wrapper FIRED — orderID=${orderID}`,
                  );
                  return orderID;
                };
              } else {
                console.warn(`${LOG} Buttons() — no createOrder in config`);
              }
              // Detect BA- / vault flow: config has createBillingAgreement but no
              // createOrder. Set module-level flag so wrapOnApprove can skip
              // originalOnApprove safely.
              if (config?.createBillingAgreement && !config?.createOrder) {
                isBillingAgreementFlow = true;
                console.warn(
                  `${LOG} Buttons() — BA flow detected, isBillingAgreementFlow=true`,
                );
              }
              return _rawButtons.call(paypalObj, config);
            };
          },
          // eslint-disable-next-line object-shorthand, func-names
          set: function (fn) {
            _rawButtons = fn;
            console.warn(
              `${LOG} wrapPaypalButtons — Buttons (re-)assigned, onApprove hook active`,
            );
          },
        });
        // eslint-disable-next-line no-param-reassign
        paypalObj.__adyen_buttons_hooked__ = true;
        if (_rawButtons) {
          console.warn(
            `${LOG} wrapPaypalButtons — Buttons.onApprove patched (existing)`,
          );
        } else {
          console.warn(
            `${LOG} wrapPaypalButtons — Buttons getter/setter installed (pending assignment)`,
          );
        }
      } catch (_e) {
        /* defineProperty failed — non-extensible object */
      }
    };

    // Install a permanent getter/setter on window.paypal so every (re-)assignment
    // of window.paypal is intercepted. We do NOT restore to a plain property.
    const installWindowPaypalSetter = () => {
      let _rawPaypal = window.paypal; // snapshot current value (may be undefined)
      try {
        Object.defineProperty(window, 'paypal', {
          configurable: true,
          enumerable: true,
          // eslint-disable-next-line object-shorthand, func-names
          get: function () {
            return _rawPaypal;
          },
          // eslint-disable-next-line object-shorthand, func-names
          set: function (val) {
            _rawPaypal = val;
            if (val && typeof val === 'object') {
              installButtonsSetter(val);
            }
          },
        });
      } catch (_e) {
        /* already non-configurable — unlikely */
      }
    };

    if (window.paypal) {
      // PayPal SDK already loaded — patch immediately and install setter for
      // any subsequent re-assignments.
      installButtonsSetter(window.paypal);
      installWindowPaypalSetter();
    } else {
      installWindowPaypalSetter();
    }

    // ── 6. Create PayPal component ──
    // Declared as `let` so onShippingAddressChange can call paypalComponent.update()
    // to set the real amount after cart/data resolves on PDP.
    // eslint-disable-next-line prefer-const
    let paypalComponent = new window.AdyenWeb.PayPal(checkout, {
      showPayButton: true,
      // isExpress=true enables the PayPal express checkout flow —
      // shipping address and method selection happen inside the PayPal popup via
      // onShippingAddressChange / onShippingOptionsChange, and onAuthorized fires
      // after the shopper approves.
      //
      // The Adyen merchant account has Billing Agreements / Reference Transactions
      // enabled, so Adyen's backend always creates BA- (Billing Agreement) tokens
      // for PayPal regardless of what the frontend requests. This is accepted:
      //   - storePaymentMethod: false ensures the token is NOT stored for future use
      //   - intent: 'tokenize' is set explicitly in configuration below so the PayPal
      //     JS SDK script loads with &intent=tokenize, matching the BA- token type.
      isExpress: true,
      userAction: 'continue', // force PayPal review screen — prevents One Touch auto-approval
      // Explicitly pass amount so formatProps receives a non-zero value even on PDP
      // where cartTotalValue=0. A zero amount causes formatProps to force intent='tokenize'
      // and vault=true on zero-amount flows. The sentinel matches initialAmount: 1 minor
      // unit ($0.01). The actual amount is updated via component.updatePaymentData() in
      // onShippingAddressChange once cart/data resolves.
      amount: initialAmount,
      configuration: {
        // intent=tokenize is required for the Billing Agreement (BA-) flow.
        // The Adyen Web SDK PayPal component (formatProps in class Oh) builds the PayPal
        // script URL from configuration.intent. Our explicit `configuration` object here
        // overrides any configuration from paymentMethodsResponse (SDK merges props with
        // our options taking priority). Setting intent='tokenize' here ensures the PayPal
        // JS SDK script is loaded with &intent=tokenize so Buttons() can create a BA-
        // token without throwing:
        //   smart_button_validation_error_billing_without_purchase_intent_tokenize_not_passed
        // Root-cause analysis confirmed via Adyen Web SDK v6.23.0 source.
        intent: 'tokenize',
        // merchantId must match the payee on the Adyen-created PayPal order.
        // Without this, PayPal SDK loads with the wrong client-id merchant and
        // throws smart_button_validation_error_derived_payee_transaction_mismatch.
        // Value sourced from admin configuration (paypalMerchantId field).
        merchantId: publicCfg.paypalMerchantId || '',
      },

      // ── onShippingAddressChange ──
      // Fires in Adyen Web SDK v6 when the PayPal lightbox opens and when the
      // shopper changes their shipping address. Required by isExpress: true flow.
      // data.shippingAddress uses PayPal JS SDK snake_case fields:
      //   country_code, postal_code, admin_area_1 (state), admin_area_2 (city)
      //
      // Per Adyen docs, we must:
      //   1. Estimate shipping methods for the new address.
      //   2. POST /paypal/updateOrder with the current amount + available delivery methods.
      //   3. Call component.updatePaymentData() with the new paymentData from the response.
      //   4. Call actions.resolve() so the lightbox proceeds.
      onShippingAddressChange: async (data, actions, component) => {
        const rawAddr = data?.shippingAddress ?? {};
        console.warn(
          `${LOG} onShippingAddressChange fired — country=${rawAddr.country_code} postal=${rawAddr.postal_code} orderID=${data?.orderID}`,
        );

        try {
          // ── Step 0: Add product to cart (PDP only) ──
          if (sku) {
            const qty = parseInt(
              document.querySelector(
                '.pdp-product__quantity input, [name="quantity"]',
              )?.value || '1',
              10,
            ) || 1;
            if (!hasAddedToCart(sku)) {
              await addToCart(sku, qty);
              // The cart drop-in is not mounted on PDP pages, so the cart/data
              // event never fires here. Use getCartData() directly (same approach
              // as onSubmit) to read the live server-side cart total after the
              // item is added.
              try {
                const liveCart = await getCartData();
                const cartItems = liveCart?.items ?? [];
                const matched = cartItems.find(
                  (item) => item.sku === sku
                    || item.product?.sku === sku
                    || item.configurableProduct?.sku === sku,
                );
                const itemTotal = matched?.rowTotal?.value ?? matched?.price?.value ?? null;
                const itemCurrency = matched?.rowTotal?.currency
                  ?? matched?.price?.currency
                  ?? null;
                if (itemTotal > 0) {
                  cartTotalValue = itemTotal;
                  currency = itemCurrency ?? currency;
                  console.warn(
                    `${LOG} onShippingAddressChange — resolved cartTotalValue=${cartTotalValue} ${currency} from cart API`,
                  );
                } else {
                  // Fall back to cart grand total if line-item total is unavailable.
                  const grandTotal = liveCart?.prices?.grand_total?.value
                    ?? liveCart?.total?.includingTax?.value
                    ?? null;
                  if (grandTotal > 0) {
                    cartTotalValue = grandTotal;
                    currency = liveCart?.prices?.grand_total?.currency
                      ?? liveCart?.total?.includingTax?.currency
                      ?? currency;
                    console.warn(
                      `${LOG} onShippingAddressChange — resolved cartTotalValue=${cartTotalValue} ${currency} from cart grand total`,
                    );
                  } else {
                    console.warn(
                      `${LOG} onShippingAddressChange — could not resolve price from cart API; proceeding with cartTotalValue=${cartTotalValue}`,
                    );
                  }
                }
              } catch (cartErr) {
                console.warn(
                  `${LOG} onShippingAddressChange — getCartData() failed; proceeding with cartTotalValue=${cartTotalValue}`,
                  cartErr,
                );
              }
            }
          }

          // Cache the partial shipping address for onAuthorized fallback.
          cachedShippingAddress = paypalSdkAddressToCommerce(rawAddr);

          const methods = await estimateShipping(
            {
              countryCode: rawAddr.country_code || rawAddr.countryCode || '',
              region: rawAddr.admin_area_1 || rawAddr.region || '',
              postcode: rawAddr.postal_code || rawAddr.postalCode || '',
            },
            cartId,
          );
          console.debug(
            `${LOG} onShippingAddressChange — estimateShipping returned ${methods.length} method(s)`,
          );

          if (!methods.length) {
            console.warn(
              `${LOG} onShippingAddressChange — no shipping methods for country=${rawAddr.country_code}`,
            );
            actions.reject();
            return;
          }

          // Pre-select the first method so onAuthorized has a fallback even if
          // onShippingOptionsChange never fires.
          selectedShippingMethodCode = methods[0].code;
          selectedShippingCarrierCode = methods[0].carrier?.code || null;

          // ── Step 1: Call /paypal/updateOrder (required by isExpress flow) ──
          // Build the deliveryMethods array for Adyen.
          // Per Adyen docs, deliveryMethods[].amount is the SHIPPING FEE for that
          // method (not the cart total). The top-level amount is the full order total
          // (cart subtotal + selected shipping fee).
          const defaultShippingFee = methods[0]?.amount?.value ?? 0;
          const defaultShippingCurrency = methods[0]?.amount?.currency || currency;
          const totalWithShipping = cartTotalValue + defaultShippingFee;

          const deliveryMethods = methods.map((m, i) => ({
            reference: m.code,
            description: m.label || m.carrier?.title || m.code,
            type: 'Shipping',
            // Shipping fee for this method only (not the cart total).
            amount: formatAmount(
              m.amount?.value ?? 0,
              m.amount?.currency || currency,
            ),
            selected: i === 0,
          }));

          // component.paymentData may be undefined on the first onShippingAddressChange
          // call (before the Adyen SDK has stored the paymentData from the /payments
          // action internally). Fall back to the paymentData we cached from the
          // /payments response action object.
          const currentPaymentData = component.paymentData ?? cachedPaymentResult?.paymentData;
          console.debug(
            `${LOG} onShippingAddressChange — calling /paypal/updateOrder totalWithShipping=${totalWithShipping} ${defaultShippingCurrency} deliveryMethods=${deliveryMethods.length} hasPaymentData=${!!currentPaymentData}`,
          );

          const updateRes = await adyenFetch(
            `${backendUrl}paypal-update-order`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                paymentData: currentPaymentData,
                pspReference: cachedPaymentResult?.pspReference,
                // Full order total including the default (first) shipping method fee.
                amount: formatAmount(
                  totalWithShipping,
                  defaultShippingCurrency,
                ),
                deliveryMethods,
              }),
            },
            { backendUrl, cartId, isGuest },
          );
          const updateBody = await updateRes.json();
          console.warn(
            `${LOG} onShippingAddressChange — /paypal/updateOrder response: status=${updateBody?.status}`,
          );

          if (updateBody?.paymentData) {
            component.updatePaymentData(updateBody.paymentData);
          } else {
            console.warn(
              `${LOG} onShippingAddressChange — no paymentData in updateOrder response`,
              updateBody,
            );
          }

          actions.resolve();
        } catch (err) {
          console.error(
            `${LOG} onShippingAddressChange — unexpected error:`,
            err,
          );
          actions.reject();
        }
      },

      // ── onShippingOptionsChange ──
      // Fires when the shopper selects a different delivery method in the PayPal lightbox.
      // Per Adyen docs, we must call /paypal/updateOrder with the new selected method
      // and updated amount, then call component.updatePaymentData().
      onShippingOptionsChange: async (data, actions, component) => {
        const method = data?.selectedShippingOption;
        console.debug(
          `${LOG} onShippingOptionsChange fired — id=${method?.id} label=${method?.label}`,
        );
        if (method?.id) selectedShippingMethodCode = method.id;

        try {
          // Re-estimate to get the full methods list so we can mark the selected one.
          // If cachedShippingAddress is available, use it; otherwise fall back to
          // the address in data (not always present in onShippingOptionsChange).
          const addr = cachedShippingAddress ?? {};
          const methods = await estimateShipping(
            {
              countryCode: addr.countryCode || '',
              region: addr.region || '',
              postcode: addr.postcode || '',
            },
            cartId,
          );

          // Per Adyen docs, deliveryMethods[].amount is the SHIPPING FEE for that
          // method. The top-level amount is cart subtotal + selected method fee.
          const selectedMethod = methods.find((m) => m.code === selectedShippingMethodCode)
            ?? methods[0];
          if (selectedMethod) selectedShippingCarrierCode = selectedMethod.carrier?.code || null;
          const selectedShippingFee = selectedMethod?.amount?.value ?? 0;
          const selectedShippingCurrency = selectedMethod?.amount?.currency || currency;
          const totalWithShipping = cartTotalValue + selectedShippingFee;

          const deliveryMethods = methods.map((m) => ({
            reference: m.code,
            description: m.label || m.carrier?.title || m.code,
            type: 'Shipping',
            // Shipping fee for this method only (not the cart total).
            amount: formatAmount(
              m.amount?.value ?? 0,
              m.amount?.currency || currency,
            ),
            selected: m.code === selectedShippingMethodCode,
          }));

          // component.paymentData may be undefined if the Adyen SDK has not yet
          // stored the updated paymentData internally. Fall back to the last value
          // returned by /paypal/updateOrder (via component.updatePaymentData) or
          // the original paymentData from the /payments response action.
          const currentPaymentData = component.paymentData ?? cachedPaymentResult?.paymentData;
          console.debug(
            `${LOG} onShippingOptionsChange — calling /paypal/updateOrder selected=${selectedShippingMethodCode} totalWithShipping=${totalWithShipping} ${selectedShippingCurrency} hasPaymentData=${!!currentPaymentData}`,
          );

          const updateRes = await adyenFetch(
            `${backendUrl}paypal-update-order`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                paymentData: currentPaymentData,
                pspReference: cachedPaymentResult?.pspReference,
                // Full order total including the selected shipping method fee.
                amount: formatAmount(
                  totalWithShipping,
                  selectedShippingCurrency,
                ),
                deliveryMethods,
              }),
            },
            { backendUrl, cartId, isGuest },
          );
          const updateBody = await updateRes.json();
          console.warn(
            `${LOG} onShippingOptionsChange — /paypal/updateOrder response: status=${updateBody?.status}`,
          );

          if (updateBody?.paymentData) {
            component.updatePaymentData(updateBody.paymentData);
          }

          actions.resolve();
        } catch (err) {
          console.error(
            `${LOG} onShippingOptionsChange — unexpected error:`,
            err,
          );
          actions.reject();
        }
      },

      // ── onAuthorized ──
      // Fires after the shopper approves the PayPal popup and the Adyen SDK
      // completes the /payments/details call. At this point payer.email_address
      // is available and cachedPaymentResult holds the final pspReference.
      // This is where we do all Commerce mutations and place the order.
      onAuthorized: async (data, actions) => {
        console.warn(
          `${LOG} onAuthorized fired — authorizedEvent keys=${Object.keys(data?.authorizedEvent ?? {}).join(',')}`,
        );
        console.warn(
          `${LOG} onAuthorized payer=${JSON.stringify(data?.authorizedEvent?.payer)}`,
        );

        // BA- direct-auth flow: onSubmit already placed the order (Authorised, no action).
        // Guard prevents a second placeOrder call.
        if (orderPlaced) {
          console.warn(
            `${LOG} onAuthorized — order already placed (BA- direct-auth path), skipping`,
          );
          actions.resolve();
          return;
        }

        const email = data?.authorizedEvent?.payer?.email_address || '';
        if (email) cachedShopperEmail = email;
        console.warn(
          `${LOG} onAuthorized — cachedShopperEmail=${cachedShopperEmail} cachedPaymentResult=${JSON.stringify(cachedPaymentResult)}`,
        );

        // Resolve the PayPal popup so it closes normally.
        actions.resolve();

        // ── Commerce mutations + place order ──
        const emptyAddress = {
          firstName: '',
          lastName: '',
          street: [''],
          city: '',
          countryCode: '',
          postcode: '',
          region: '',
          telephone: '',
        };

        // Adyen populates deliveryAddress/billingAddress on state.data after the
        // full PayPal order resolves — but onAuthorized receives authorizedEvent,
        // not state. Use the address from authorizedEvent.shippingAddress if
        // present, falling back to the address cached in onShippingAddressChange.
        const rawShipping = data?.authorizedEvent?.shippingAddress ?? {};
        console.warn(
          `${LOG} onAuthorized — address sources:`,
          {
            hasRawShipping: !!Object.keys(rawShipping).length,
            rawShippingKeys: Object.keys(rawShipping),
            rawShipping,
            hasCachedShippingAddress: !!cachedShippingAddress,
            cachedShippingAddress,
            authorizedEventKeys: Object.keys(data?.authorizedEvent ?? {}),
          },
        );
        const authorizedShipping = Object.keys(rawShipping).length
          ? paypalSdkAddressToCommerce(rawShipping)
          : null;
        const shippingAddress = authorizedShipping || cachedShippingAddress || emptyAddress;
        let addressSource = 'emptyAddress';
        if (authorizedShipping) {
          addressSource = 'authorizedEvent';
        } else if (cachedShippingAddress) {
          addressSource = 'cachedShippingAddress';
        }
        console.warn(
          `${LOG} onAuthorized — selected shippingAddress:`,
          {
            source: addressSource,
            shippingAddress,
            isComplete: !!(
              shippingAddress.countryCode
              && shippingAddress.city
              && shippingAddress.street?.[0]
            ),
          },
        );
        const billingAddress = shippingAddress;

        const finalEmail = email || cachedShopperEmail || '';
        // The real pspReference comes from the /payments/details response, which
        // the Adyen SDK exposes on authorizedEvent. Fall back to cachedPaymentResult
        // for direct-authorisation flows where no action was needed.
        const pspReference = data?.authorizedEvent?.pspReference
          || cachedPaymentResult?.pspReference;
        const donationToken = data?.authorizedEvent?.donationToken
          || cachedPaymentResult?.donationToken;
        console.warn(
          `${LOG} onAuthorized — pspReference=${pspReference} finalEmail=${finalEmail}`,
        );

        try {
          if (isGuest) await setGuestEmail(finalEmail, cartId);
          await setBilling(billingAddress, cartId);
          await setShipping(shippingAddress, cartId);
          if (selectedShippingMethodCode) {
            const sCarrier = selectedShippingCarrierCode || selectedShippingMethodCode;
            const sMethodSuffix = selectedShippingCarrierCode
              ? selectedShippingMethodCode.slice(
                selectedShippingCarrierCode.length + 1,
              )
              : '';
            const sMethod = sMethodSuffix || selectedShippingMethodCode;
            await setShippingMethod(
              { carrierCode: sCarrier, methodCode: sMethod },
              cartId,
            );
          }

          orderPlaced = true;
          const orderData = await placeOrderWithPayment(
            cartId,
            'adyen_paypal',
            pspReference,
            donationToken,
          );
          redirectToConfirmation(orderData);
        } catch (err) {
          console.error(`${LOG} order placement error in onAuthorized:`, err);
          showExpressError(
            container,
            'Payment was authorised but order placement failed. Please contact support.',
          );
        }
      },

      // ── onSubmit ──
      // Called by the Adyen SDK when it is ready to POST /payments (triggered
      // from createOrder — before the PayPal popup opens). In the PayPal SDK
      // advanced flow this returns resultCode=Pending + action.type=sdk.
      // We call component.handleAction() to open the PayPal popup; the shopper
      // approves, onApprove fires, Adyen calls /payments/details, and finally
      // onAuthorized fires with the full payer object and final pspReference.
      // Commerce mutations and order placement happen in onAuthorized.
      onSubmit: async (state, component, actions) => {
        console.debug(
          `${LOG} onSubmit fired — hasDeliveryAddress=${!!state?.data?.deliveryAddress}`,
        );
        console.warn(
          `${LOG} onSubmit state.data=${JSON.stringify(state?.data)} cachedShopperEmail=${cachedShopperEmail}`,
        );

        // ── BA- flow PDP price resolution ──
        // In the BA- (Billing Agreement / intent=tokenize) flow onShippingAddressChange
        // never fires, so addToCart is never called before onSubmit and cartTotalValue
        // may still be 0 (e.g. bundle products whose dynamic price cannot be resolved
        // statically). Mirror the pattern from onShippingAddressChange: add to cart now,
        // wait for the cart/data event to get the real price, then proceed.
        // onApprove guards against double-add via hasAddedToCart().
        // ── PDP price resolution (all flows) ────────────────────────────────
        // For bundle/configurable products, static price sources (JSON-LD, pdp/data,
        // Catalog Service, DOM) return 0. In the regular express flow,
        // onShippingAddressChange adds to cart and the cart/data event updates
        // cartTotalValue — but that event is only emitted by the cart drop-in,
        // which is NOT mounted on PDP pages, so it never fires. In the BA-
        // (Billing Agreement) flow, onShippingAddressChange never fires at all.
        //
        // Fix: if cartTotalValue is still 0 at onSubmit time and we have a sku,
        // add to cart (if not already done) then call getCartData() directly to
        // read the live server-side cart total — no event bus dependency.
        // This covers BOTH the BA- flow and the regular express flow.
        if (sku && !(cartTotalValue > 0)) {
          const qty = parseInt(
            document.querySelector(
              '.pdp-product__quantity input, [name="quantity"]',
            )?.value || '1',
            10,
          ) || 1;
          console.warn(
            `${LOG} onSubmit — cartTotalValue=0 on PDP; resolving real price via cart API (sku=${sku} qty=${qty})`,
          );
          if (!hasAddedToCart(sku)) {
            await addToCart(sku, qty);
          }
          try {
            const liveCart = await getCartData();

            // For logged-in customers, ALWAYS use grand total (includes shipping, taxes, discounts)
            // For guests, use the item row total if available
            if (!isGuest) {
              // DEBUG: Log full cart structure and all top-level keys
              console.warn(
                `${LOG} onSubmit — DEBUG: Full liveCart object:`,
                liveCart,
              );
              console.warn(
                `${LOG} onSubmit — DEBUG: liveCart keys:`,
                Object.keys(liveCart || {}),
              );
              if (liveCart?.prices) {
                console.warn(
                  `${LOG} onSubmit — DEBUG: liveCart.prices keys:`,
                  Object.keys(liveCart.prices),
                );
              }
              if (liveCart?.total) {
                console.warn(
                  `${LOG} onSubmit — DEBUG: liveCart.total keys:`,
                  Object.keys(liveCart.total),
                );
              }

              // Try prices.grandTotal first, then total.includingTax (logged-in with shipping)
              const grandTotal = liveCart?.prices?.grandTotal?.value
                ?? liveCart?.total?.includingTax?.value
                ?? liveCart?.total?.value
                ?? null;
              const grandCurrency = liveCart?.prices?.grandTotal?.currency
                ?? liveCart?.total?.includingTax?.currency
                ?? liveCart?.total?.currency
                ?? null;
              if (grandTotal > 0) {
                cartTotalValue = grandTotal;
                if (grandCurrency) currency = grandCurrency;
                console.warn(
                  `${LOG} onSubmit — logged-in customer; using cart grand total: ${cartTotalValue} ${currency}`,
                );
              } else {
                console.warn(
                  `${LOG} onSubmit — could not resolve grand total from cart API; proceeding with cartTotalValue=${cartTotalValue}`,
                  liveCart,
                );
              }
            } else {
              // For guests, try to get item row total first
              console.warn(
                `${LOG} onSubmit — DEBUG: Guest checkout; full liveCart:`,
                liveCart,
              );
              const cartItems = liveCart?.items ?? [];
              console.warn(
                `${LOG} onSubmit — DEBUG: Cart items count: ${cartItems.length}`,
              );
              const matched = cartItems.find(
                (item) => item.sku === sku
                  || item.product?.sku === sku
                  || item.configurableProduct?.sku === sku,
              );
              console.warn(
                `${LOG} onSubmit — DEBUG: Matched item (sku=${sku}):`,
                matched,
              );
              const itemTotal = matched?.rowTotal?.value ?? matched?.price?.value ?? null;
              const itemCurrency = matched?.rowTotal?.currency ?? matched?.price?.currency ?? null;
              if (itemTotal > 0) {
                cartTotalValue = itemTotal;
                if (itemCurrency) currency = itemCurrency;
                console.warn(
                  `${LOG} onSubmit — resolved cartTotalValue from cart API: ${cartTotalValue} ${currency}`,
                );
              } else {
                // Fallback: use cart-level grand total
                const grandTotal = liveCart?.prices?.grandTotal?.value
                  ?? liveCart?.total?.includingTax?.value
                  ?? liveCart?.total?.value
                  ?? null;
                const grandCurrency = liveCart?.prices?.grandTotal?.currency
                  ?? liveCart?.total?.includingTax?.currency
                  ?? liveCart?.total?.currency
                  ?? null;
                if (grandTotal > 0) {
                  cartTotalValue = grandTotal;
                  if (grandCurrency) currency = grandCurrency;
                  console.warn(
                    `${LOG} onSubmit — resolved cartTotalValue from cart grand total: ${cartTotalValue} ${currency}`,
                  );
                } else {
                  console.warn(
                    `${LOG} onSubmit — could not resolve price from cart API; proceeding with cartTotalValue=${cartTotalValue}`,
                    liveCart,
                  );
                }
              }
            }
          } catch (cartErr) {
            console.warn(
              `${LOG} onSubmit — getCartData() failed; proceeding with cartTotalValue=${cartTotalValue}`,
              cartErr,
            );
          }
        }

        // ── Step 1: POST /payments ──
        let result;
        try {
          console.debug(
            `${LOG} onSubmit — POSTing to ${backendUrl}payments (cartId=${cartId} amount=${cartTotalValue} ${currency} cachedOrderID=${cachedOrderID})`,
          );
          const res = await adyenFetch(
            `${backendUrl}payments`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cartId,
                isGuest,
                scope,
                paymentRequest: {
                  ...state.data,
                  // Do NOT override paymentMethod.subtype here.
                  // The Adyen PayPal component with isExpress=true correctly sets
                  // subtype='express' in state.data, which signals Adyen's backend
                  // to use the Orders API (EC- token) flow. Overriding with an
                  // unrecognised value like 'sdk' causes Adyen to ignore the express
                  // signal and fall back to Billing Agreements (BA- token), which
                  // breaks the PayPal popup with billing_without_purchase_intent errors.
                  storePaymentMethod: false,
                  amount: formatAmount(cartTotalValue, currency),
                  origin: window.location.origin,
                  reference: cartId,
                  shopperEmail: !isGuest && customerEmail ? customerEmail : '',
                  shopperName: { firstName: '', lastName: '' },
                },
              }),
            },
            { backendUrl, cartId, isGuest },
          );

          result = await res.json();
          console.warn(
            `${LOG} onSubmit — /payments FULL response: ${JSON.stringify(result)}`,
          );
          console.warn(
            `${LOG} onSubmit — /payments response: resultCode=${result?.resultCode} pspReference=${result?.pspReference} action=${result?.action?.type}`,
          );
        } catch (err) {
          console.error(`${LOG} onSubmit payment error:`, err);
          showExpressError(
            container,
            'An error occurred while processing your payment.',
          );
          actions.reject(err.message || 'Payment failed');
          return;
        }

        // ── Step 2: Handle action (open PayPal popup) ──
        // resultCode=Pending + action.type=sdk means the shopper has not yet
        // approved in PayPal. We must call handleAction() to open the popup.
        // Commerce mutations happen later in onAuthorized.
        if (result?.action) {
          console.warn(
            `${LOG} onSubmit — action received (type=${result.action.type}), calling handleAction`,
          );
          // Cache pspReference/donationToken from the initial /payments response
          // (may be undefined here; onAuthorized may receive the final values).
          cachedPaymentResult = {
            pspReference: result.pspReference,
            donationToken: result.donationToken,
            // paymentData is needed by wrapOnApprove in the BA- flow to call
            // /payments/details manually (Adyen SDK skips that call when we
            // return early from onApprove).
            paymentData: result.action?.paymentData,
            // sdkData.token is the BA- billing agreement token (BA-...) that
            // Adyen requires as details.billingToken in /payments/details.
            //
            billingToken: result.action?.sdkData?.token,
          };
          try {
            component.handleAction(result.action);
          } catch (err) {
            console.error(`${LOG} onSubmit — handleAction failed:`, err);
            showExpressError(
              container,
              'Failed to open PayPal. Please try again.',
            );
            actions.reject('handleAction failed');
          }
          // Do NOT call actions.resolve() or actions.reject() here — the flow
          // continues asynchronously via onApprove → onAuthorized.
          return;
        }

        // ── Fallback: /payments returned Authorised directly (no action) ──
        // This can happen for returning PayPal users with saved credentials.
        const SUCCESS_CODES = ['Authorised', 'Received'];
        if (!SUCCESS_CODES.includes(result?.resultCode)) {
          console.warn(
            `${LOG} onSubmit — payment not authorised: resultCode=${result?.resultCode}`,
          );
          showExpressError(
            container,
            'Payment was not authorised. Please try again.',
          );
          actions.reject(result.resultCode);
          return;
        }

        actions.resolve({ resultCode: result.resultCode });

        // Immediate authorisation — do commerce mutations inline.
        // BA- (Billing Agreement) flow: onShippingAddressChange never fired, so
        // cachedShippingAddress and selectedShippingMethodCode will be null. We
        // still set the guest email and billing address (from Adyen's billingAddress
        // field on state.data if present) and attempt to place the order.
        const finalEmail = state?.data?.shopperEmail || cachedShopperEmail || '';
        const emptyAddress = {
          firstName: '',
          lastName: '',
          street: [''],
          city: '',
          countryCode: '',
          postcode: '',
          region: '',
          telephone: '',
        };
        const shippingAddress = adyenPaypalAddressToCommerce(state?.data?.deliveryAddress)
          || cachedShippingAddress
          || emptyAddress;
        const billingAddress = adyenPaypalAddressToCommerce(state?.data?.billingAddress)
          || shippingAddress;
        // hasAddress: only call setShipping/setBilling when we have a real address.
        // In the BA- flow deliveryAddress is absent and cachedShippingAddress is null —
        // calling setShipping with an empty address causes a Commerce validation error.
        const hasAddress = !!(
          shippingAddress.countryCode || shippingAddress.city
        );
        try {
          if (isGuest) await setGuestEmail(finalEmail, cartId);
          if (hasAddress) {
            await setBilling(billingAddress, cartId);
            await setShipping(shippingAddress, cartId);
          }
          if (selectedShippingMethodCode) {
            const sCarrier = selectedShippingCarrierCode || selectedShippingMethodCode;
            const sMethodSuffix = selectedShippingCarrierCode
              ? selectedShippingMethodCode.slice(
                selectedShippingCarrierCode.length + 1,
              )
              : '';
            const sMethod = sMethodSuffix || selectedShippingMethodCode;
            await setShippingMethod(
              { carrierCode: sCarrier, methodCode: sMethod },
              cartId,
            );
          }
          orderPlaced = true;
          const orderData = await placeOrderWithPayment(
            cartId,
            'adyen_paypal',
            result.pspReference,
            result.donationToken,
          );
          redirectToConfirmation(orderData);
        } catch (err) {
          console.error(
            `${LOG} order placement error after direct authorisation:`,
            err,
          );
          showExpressError(
            container,
            'Payment was authorised but order placement failed. Please contact support.',
          );
        }
      },

      onPaymentFailed: (error) => {
        console.warn(`${LOG} onPaymentFailed:`, error);
        showExpressError(container, 'Payment failed. Please try again.');
      },
      onError: (err) => {
        console.error(`${LOG} onError:`, err);
        showExpressError(container, err.message || 'An error occurred.');
      },
    });

    // ── 7. Check availability and mount ──
    // Awaiting isAvailable() keeps initExpressCheckout pending until the button
    // is either mounted or hidden — this lets product-details.js remove the
    // skeleton only after the availability check completes.
    try {
      console.debug(`${LOG} checking PayPal availability…`);
      await paypalComponent.isAvailable();
      console.debug(`${LOG} PayPal is available — mounting`);
    } catch (err) {
      console.warn(
        `${LOG} PayPal isAvailable() rejected — hiding block. Reason:`,
        err,
      );
      block.style.display = 'none';
      return;
    }
    paypalComponent.mount(container);
    console.debug(`${LOG} PayPal component mounted`);
  } catch (err) {
    console.error(`${LOG} init error:`, err);
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
  console.debug('[paypal-express] decorate() called');
  const container = document.createElement('div');
  container.className = 'paypal-express-container';
  block.appendChild(container);

  showExpressLoading(block);

  // Return the promise so product-details.js can await it and remove the
  // skeleton only after isAvailable() + mount (or hide) completes.
  return initExpressCheckout(block, container);
}
