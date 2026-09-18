/* eslint-disable import/no-unresolved */
/* eslint-disable no-unused-vars */

// Dropin Tools
import { events } from '@dropins/tools/event-bus.js';
import { initReCaptcha } from '@dropins/tools/recaptcha.js';

// Order Dropin Modules
import * as orderApi from '@dropins/storefront-order/api.js';
import * as checkoutApi from '@dropins/storefront-checkout/api.js';

// Check out Dropin Libraries
import {
  createScopedSelector,
  isVirtualCart,
  setMetaTags,
  validateForms,
} from '@dropins/storefront-checkout/lib/utils.js';

// Payment Services Dropin
import { PaymentMethodCode } from '@dropins/storefront-payment-services/api.js';

// Block Utilities
import {
  buildOrderDetailsUrl,
  displayOverlaySpinner,
  removeOverlaySpinner,
} from './utils.js';

// Fragment functions
import { createCheckoutFragment, selectors } from './fragments.js';

// Container functions
import {
  renderAddressForm,
  renderBillingAddressFormSkeleton,
  renderBillToShippingAddress,
  renderCartSummaryList,
  renderCheckoutHeader,
  renderCustomerBillingAddresses,
  renderCustomerShippingAddresses,
  renderGiftOptions,
  renderLoginForm,
  renderMergedCartBanner,
  renderOrderSummary,
  renderOutOfStock,
  renderPaymentMethods,
  renderPlaceOrder,
  renderServerError,
  renderShippingAddressFormSkeleton,
  renderShippingMethods,
  renderTermsAndConditions,
} from './containers.js';

// Constants
import {
  BILLING_ADDRESS_DATA_KEY,
  BILLING_FORM_NAME,
  LOGIN_FORM_NAME,
  PURCHASE_ORDER_FORM_NAME,
  SHIPPING_ADDRESS_DATA_KEY,
  SHIPPING_FORM_NAME,
  TERMS_AND_CONDITIONS_FORM_NAME,
} from './constants.js';

import { rootLink } from '../../scripts/commerce.js';

// Initializers
import '../../scripts/initializers/account.js';
import '../../scripts/initializers/checkout.js';
import '../../scripts/initializers/order.js';
import {
  getActiveComponent,
  setPendingOrderData,
  clearPendingOrderData,
  clearPaymentResult,
  fetchOrderResult,
  getPaymentResult,
  getPaymentResultSync,
  setPaymentResult,
  mountNative3DSComponent,
  fetchPreAuthPayment,
  getCartDataSnapshot,
  getCheckoutDataSnapshot,
  getScopeCode,
  recoverCart,
  setRecoveryStartCallback,
  setRedirectPaymentCode,
  clearRedirectPaymentCode,
  waitForOnSubmitResult,
  setHandlePlaceOrderActive,
} from '../adyen-payment/index.js';
import { isNative3DSAction, showError } from '../adyen-payment/utils.js';
import { STORAGE_KEYS } from '../adyen-payment/storage.js';

// Checkout success block import
import {
  renderCheckoutSuccess,
  preloadCheckoutSuccess,
} from '../commerce-checkout-success/commerce-checkout-success.js';

function redirectToCartIfEmpty(cartData) {
  const isOrderPlaced = events.lastPayload('order/placed') !== undefined;

  if (!isOrderPlaced && (cartData === null || cartData?.items?.length === 0)) {
    window.location.href = rootLink('/cart');
  }
}

export default async function decorate(block) {
  setMetaTags('Checkout');
  document.title = 'Checkout';

  // Capture whether this page load is a payment-failure recovery redirect.
  // The failure handler writes PAYMENT_ERROR to sessionStorage before
  // navigating here. Two things depend on this flag:
  //  - we must not reload on 'authenticated' — doing so would destroy the
  //    error banner injection before .checkout-payment-methods__content
  //    renders.
  //  - the recovery cart is a freshly-provisioned cart whose item
  //    restoration is best-effort and can legitimately come back empty
  //    (see recover-cart). redirectToCartIfEmpty must not treat that as a
  //    "customer browsed to checkout with nothing in their cart" and bounce
  //    them to /cart — that races with (and reliably wins against) the
  //    decline banner ever being shown.
  let isPaymentErrorRecovery = false;
  try {
    isPaymentErrorRecovery = !!sessionStorage.getItem(
      STORAGE_KEYS.PAYMENT_ERROR,
    );
  } catch {
    /* ignore */
  }

  const cartData = events.lastPayload('cart/initialized');
  if (!isPaymentErrorRecovery) {
    redirectToCartIfEmpty(cartData);
  }

  // Track whether the first 'authenticated' event has been received.
  // The auth dropin always emits 'authenticated' once on init (true for a
  // logged-in customer, false for a guest).  We must not reload on that
  // initial event — only on a transition from false→true that happens
  // after page load (i.e. the customer signs in mid-checkout).
  let firstAuthEventReceived = false;

  // Container and component references
  let shippingForm;
  let billingForm;
  let shippingAddresses;
  let billingAddresses;

  // Track the payment method code used when placing an order
  // Used to determine if pending order data should be stored for Adyen payments
  let lastPlacedOrderPaymentCode = null;

  // Store the cartId before placeOrder is called and cart/reset clears sessionStorage.
  // This allows fetchOrderResult to have the cartId even after the cart has been reset.
  let lastPlacedOrderCartId = null;

  // Preload the checkout-success block once the customer initiates checkout.
  // Called inside handlePlaceOrder, so it fires while the order is processing,
  // giving the browser time to fetch the CSS before it is necessary.
  let successPreloaded = false;
  const ensureSuccessPreloaded = () => {
    if (!successPreloaded) {
      successPreloaded = true;
      preloadCheckoutSuccess();
    }
  };

  // Guest email to restore after a payment failure redirect.
  // Set by restoreGuestFields() and consumed in handleCheckoutUpdated() once
  // checkout/initialized fires and the dropin has a valid cartId.
  let pendingGuestEmailRestore = null;

  const shippingFormRef = { current: null };
  const billingFormRef = { current: null };
  const creditCardFormRef = { current: null };
  const loaderRef = { current: null };
  // Set to true from the moment Place Order is clicked until the spinner is
  // legitimately handed off or removed.  Prevents checkout/updated (fired by
  // cart/reset after placeOrder) from calling removeOverlaySpinner and causing
  // the spinner to flicker off between placeOrder resolving and handleOrderPlaced
  // mounting the 3DS2 modal.
  let placingOrder = false;

  events.on('order/placed', () => {
    setMetaTags('Order Confirmation');
    document.title = 'Order Confirmation';
  });

  // Create the checkout layout using fragments
  const checkoutFragment = createCheckoutFragment();

  // Create a scoped selector for the checkout fragment
  const getElement = createScopedSelector(checkoutFragment);

  // Get all checkout elements using centralized selectors
  const $content = getElement(selectors.checkout.content);
  const $loader = getElement(selectors.checkout.loader);
  const $mergedCartBanner = getElement(selectors.checkout.mergedCartBanner);
  const $heading = getElement(selectors.checkout.heading);
  const $serverError = getElement(selectors.checkout.serverError);
  const $outOfStock = getElement(selectors.checkout.outOfStock);
  const $login = getElement(selectors.checkout.login);
  const $shippingForm = getElement(selectors.checkout.shippingForm);
  const $billToShipping = getElement(selectors.checkout.billToShipping);
  const $delivery = getElement(selectors.checkout.delivery);
  const $paymentMethods = getElement(selectors.checkout.paymentMethods);
  const $billingForm = getElement(selectors.checkout.billingForm);
  const $orderSummary = getElement(selectors.checkout.orderSummary);
  const $cartSummary = getElement(selectors.checkout.cartSummary);
  const $placeOrder = getElement(selectors.checkout.placeOrder);
  const $giftOptions = getElement(selectors.checkout.giftOptions);
  const $termsAndConditions = getElement(selectors.checkout.termsAndConditions);

  block.appendChild(checkoutFragment);

  // Fill the guest email input via the native setter, so Preact's controlled
  // component picks up the change.  Used both in restoreGuestFields (initial
  // DOM fill) and in handleCheckoutUpdated (re-fill after checkout/initialized
  // resets the Preact state to "").
  function fillGuestEmailInput(loginContainer, email) {
    if (!email) return;
    const emailInput = loginContainer.querySelector(
      'input[name="customer-email"]',
    );
    if (!emailInput) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(emailInput, email);
    } else {
      emailInput.value = email; // eslint-disable-line no-param-reassign
    }
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const handleValidation = () => {
    let success = validateForms([
      { name: LOGIN_FORM_NAME },
      { name: SHIPPING_FORM_NAME, ref: shippingFormRef },
      { name: BILLING_FORM_NAME, ref: billingFormRef },
      { name: PURCHASE_ORDER_FORM_NAME },
      { name: TERMS_AND_CONDITIONS_FORM_NAME },
    ]);

    const selectedRadio = $paymentMethods.querySelector(
      'input[type="radio"][name="payment-method"]:checked',
    );
    if (selectedRadio) {
      const isAdyenPayment = selectedRadio.value?.startsWith('adyen_');
      if (isAdyenPayment) {
        const component = getActiveComponent();
        if (component) {
          if (!component.isValid) {
            success = false;
            component.showValidation();
            $paymentMethods.scrollTo();
          }
        }
      }
    }
    return success;
  };

  // Reset order placement state variables
  const resetPlacingOrderState = () => {
    lastPlacedOrderPaymentCode = null;
    // Don't clear lastPlacedOrderCartId here - it's needed by the order success
    // page for donation component initialization. Instead, keep it in sessionStorage for
    // the order success page to access, and clear it only after rendering is complete.
    // lastPlacedOrderCartId = null;
    // window.__adyenCheckoutLastCartId = null;
  };

  const handlePlaceOrder = async ({ cartId, code }) => {
    console.info('[handlePlaceOrder] CALLED - Starting order placement:', {
      cartId,
      code,
      placingOrder,
      timestamp: new Date().toISOString(),
    });
    console.info('[handlePlaceOrder] Stack trace:');
    console.debug('Stack trace');

    ensureSuccessPreloaded();
    placingOrder = true;
    // Store the cartId before placeOrder is called, since cart/reset will clear sessionStorage
    lastPlacedOrderCartId = cartId;
    window.__adyenCheckoutLastCartId = cartId;
    await displayOverlaySpinner(loaderRef, $loader);
    // Clear any stale pendingOrderData from a previous redirect flow.
    // If left in localStorage it can bleed into the pre-auth 3DS path:
    // onAdditionalDetails falls through to the server-side branch, finds the
    // stale order, emits order/placed, and handleOrderPlaced replaces the
    // pre-auth overlay (which has __onComplete) with one that has __onComplete=null.
    clearPendingOrderData();
    try {
      // Payment Services credit card
      if (code === PaymentMethodCode.CREDIT_CARD) {
        console.info('[handlePlaceOrder] Payment Services credit card path');
        if (!creditCardFormRef.current) {
          console.error('Credit card form not rendered.');
          placingOrder = false;
          removeOverlaySpinner(loaderRef, $loader);
          return;
        }
        if (!creditCardFormRef.current.validate()) {
          // Credit card form is invalid; abort order placement
          console.info('[handlePlaceOrder] Credit card form invalid, aborting');
          placingOrder = false;
          removeOverlaySpinner(loaderRef, $loader);
          return;
        }
        // Submit a Payment Services credit card form
        console.info('[handlePlaceOrder] Submitting credit card form');
        await creditCardFormRef.current.submit();
      } else if (code.startsWith('adyen_')) {
        // Adyen payment method
        console.info('[handlePlaceOrder] Adyen payment method:', code);
        const component = getActiveComponent();
        if (!component) {
          console.debug('Adyen payment component not found.');
          placingOrder = false;
          removeOverlaySpinner(loaderRef, $loader);
          return;
        }
        lastPlacedOrderPaymentCode = code;
        if (code === 'adyen_affirm' || code.startsWith('adyen_klarna')) {
          displayOverlaySpinner(loaderRef, $loader);
          // Store the Commerce payment method code before the redirect so that
          // redirect.js can use it directly on return. The Adyen SDK's
          // paymentMethod.type (e.g. 'klarna') lacks regional suffixes (e.g.
          // '_US') and may not match Commerce's available_payment_methods list.
          setRedirectPaymentCode(code);
          console.info('[handlePlaceOrder] Redirect payment method, calling component.submit()');
          component.submit();
          return;
        }
        // Signal to createDefaultOnSubmit that handlePlaceOrder owns order placement.
        // This causes createDefaultOnSubmit to resolve with 'Backend' instead of
        // 'Authorised', preventing onPaymentCompleted from also calling placeOrder.
        // Apple Pay and PayPal do NOT go through this path (no Place Order button),
        // so their onPaymentCompleted → placeOrder flow is unaffected.
        setHandlePlaceOrderActive(true);
        console.info('[handlePlaceOrder] Non-redirect Adyen method, proceeding with standard flow');
        // Set a payment method with a component state.
        // Capture the serialized state NOW before pre-auth mutates component.data
        // (the Adyen SDK adds details/paymentData to component.data after 3DS
        // completes, which Commerce would hoist to top-level additional_information
        // keys and cause the backend to take the details flow instead of initial).
        const componentStateJson = JSON.stringify(component.data);
        const preOrderAdditional = [
          { key: 'state', value: componentStateJson },
        ];
        // For payment methods whose Drop-in calls onSubmit (e.g. Google Pay, ACH),
        // the checkout-instance-level createDefaultOnSubmit POSTs to /payments
        // asynchronously in parallel with triggerPlaceOrder(). We must wait for
        // that call to complete so the pspReference it stores via setPaymentResult()
        // is available here as preOrderPspReference.
        //
        // Without this wait, preOrderPspReference is always null for Google Pay:
        //   1. SDK fires component onSubmit → triggerPlaceOrder() (sync) → handlePlaceOrder starts
        //   2. SDK fires instance onSubmit (createDefaultOnSubmit) → async POST /payments
        //   3. handlePlaceOrder reads getPaymentResultSync() → null (POST not done yet)
        //   4. process-order-payment gets no preOrderPspReference → calls /payments again
        //   5. Adyen 422 "token already used" → resultCode: Error → spurious cart recovery
        //
        // For redirect methods (klarna, affirm) and adyen_scheme (pre-auth), onSubmit
        // is handled differently and does not store a preOrderPspReference, so we skip
        // the wait. The 8 s timeout in waitForOnSubmitResult() ensures we are never
        // blocked indefinitely if the SDK does not fire the instance-level onSubmit.
        const isRedirectMethod = code === 'adyen_affirm' || code.startsWith('adyen_klarna');
        const isPreAuthScheme = code === 'adyen_scheme';
        if (!isRedirectMethod && !isPreAuthScheme) {
          await waitForOnSubmitResult(8000);
        }
        // For payment methods whose Drop-in calls onSubmit (e.g. ACH), the frontend
        // already submitted a /payments request before placeOrder runs. That pre-order
        // call uses cartId as the Adyen reference, so the AUTHORISATION webhook arrives
        // with a pspReference that process-order-payment has no record of.
        // Forward that pspReference so the backend can register a second order-lookup
        // entry, allowing events-consumer to correlate the webhook to the order.
        const preOrderResult = getPaymentResultSync();
        console.info('[handlePlaceOrder] Checking for pre-order payment result:', {
          hasPreOrderResult: !!preOrderResult,
          preOrderResult: preOrderResult ? {
            pspReference: preOrderResult.pspReference,
            resultCode: preOrderResult.resultCode,
            merchantReference: preOrderResult.merchantReference,
          } : null,
        });
        if (preOrderResult?.pspReference) {
          console.info('[handlePlaceOrder] Pre-order pspReference found:', preOrderResult.pspReference);
          preOrderAdditional.push({
            key: 'preOrderPspReference',
            value: preOrderResult.pspReference,
          });
        } else {
          console.info('[handlePlaceOrder] No pre-order pspReference available - will use backend payment flow');
        }
        console.info('[handlePlaceOrder] Setting payment method via setPaymentMethod API');
        await checkoutApi.setPaymentMethod({
          code,
          additional_data: preOrderAdditional,
        });

        // Pre-auth: authenticate shopper via 3DS2 BEFORE creating the order.
        // Skip for stored cards (storedPaymentMethodId) — they are already
        // tokenized contracts; authenticationOnly is not supported for them.
        if (
          code === 'adyen_scheme'
          && !component.data?.paymentMethod?.storedPaymentMethodId
        ) {
          const cartSnapshot = getCartDataSnapshot();
          const checkoutSnapshot = getCheckoutDataSnapshot();
          if (!cartSnapshot?.id) {
            throw new Error(
              'Cart is no longer available. Please refresh the page and try again.',
            );
          }
          console.debug('[FRONTEND-TRACE] Pre-auth payment about to be called', {
            cartId: cartSnapshot?.id,
            cartTotal: cartSnapshot?.total,
            cartData: cartSnapshot,
            checkoutEmail: checkoutSnapshot?.email,
            checkoutIsGuest: checkoutSnapshot?.isGuest,
            checkoutData: checkoutSnapshot,
            scope: getScopeCode(),
          });
          const preAuthResult = await fetchPreAuthPayment(
            component.data,
            cartSnapshot,
            checkoutSnapshot,
            getScopeCode(),
          );

          // Store the pre-auth result so it can be retrieved by getPaymentResultSync()
          // at line 349 when handling the actual order placement.
          // This ensures the preOrderPspReference gets passed to the backend's /payments action.
          if (preAuthResult) {
            console.info('[handlePlaceOrder] Storing pre-auth result:', {
              pspReference: preAuthResult.pspReference,
              resultCode: preAuthResult.resultCode,
              merchantReference: preAuthResult.merchantReference,
            });
            setPaymentResult(preAuthResult);
          }

          if (preAuthResult?.action?.type === 'threeDS2') {
            // 3DS2 required — complete auth in the modal before placing the order
            const preAuthCompletion = await new Promise((resolve, reject) => {
              mountNative3DSComponent(preAuthResult.action, null, {
                onComplete: (result) => {
                  resolve(result);
                },
                onDismiss: () => reject(new Error('3DS2 cancelled by user')),
              });
            });
            // Guard: if the bank refused the challenge, stop here.
            // onPaymentFailed resolves the Promise with the refused resultCode
            // instead of rejecting so we can show a user-friendly message.
            const { resultCode } = preAuthCompletion;
            if (
              resultCode !== 'Authorised'
              && resultCode !== 'AuthenticationFinished'
            ) {
              throw new Error(
                `3DS2 authentication was not completed successfully (${resultCode || 'Refused'}). Please try again or use a different payment method.`,
              );
            }
            // Pre-auth succeeded (3DS challenge completed, resultCode = AuthenticationFinished).
            // The Drop-in internally called /payments/details and fully consumed the
            // details.threeDSResult + paymentData token pair. Re-submitting those to
            // /payments/details again (Fix #2) causes a 422 "already processed" from Adyen.
            //
            // Correct approach (Adyen standalone authentication docs):
            // After AuthenticationFinished the response body contains threeDS2Result objects
            // with the SCA outcome (authenticationValue, eci, dsTransID, transStatus, etc.).
            // The backend must make a NEW /payments call with mpiData populated from those
            // values — it must NOT call /payments/details again.
            //
            // preAuthCompletion is formed in handlers.js via cb({ ...result, ... }) where
            // the result is the full /payments/details response body, so threeDS2Result is at
            // preAuthCompletion.threeDS2Result.
            //
            // We also continue passing 'state' (pre-captured before pre-auth) so the backend
            // can build the full /payments request (paymentMethod, browserInfo, addresses, etc.).
            // See: https://docs.adyen.com/online-payments/3d-secure/other-3ds-flows/authentication-only/
            const preAuthAdditional = [
              { key: 'state', value: componentStateJson },
            ];
            if (preAuthCompletion.threeDS2Result) {
              // Pass the authentication result object so the backend can authorize via a new
              // /payments call with mpiData (authenticationValue, eci, dsTransID, transStatus).
              preAuthAdditional.push({
                key: 'threeDS2Result',
                value: JSON.stringify(preAuthCompletion.threeDS2Result),
              });
            }
            await checkoutApi.setPaymentMethod({
              code,
              additional_data: preAuthAdditional,
            });
            // Fall through to placeOrder — authentication complete
          } else if (
            preAuthResult?.resultCode === 'AuthenticationNotRequired'
          ) {
            // AuthenticationNotRequired: no 3DS2 validation needed.
            // Send a direct authorization request to Adyen — the backend must
            // make a new /payments call (not /payments/details) using the card
            // state. There are no threeDS2Result or threeDSPaymentData tokens to
            // forward because no authentication challenge was performed.
            // See: https://docs.adyen.com/online-payments/3d-secure/other-3ds-flows/authentication-only/
            await checkoutApi.setPaymentMethod({
              code,
              additional_data: [
                { key: 'state', value: componentStateJson },
                { key: 'authenticationNotRequired', value: 'true' },
              ],
            });
            // Fall through to placeOrder — no 3DS required, authorize directly
          } else if (
            preAuthResult?.resultCode !== 'Authorised'
            && preAuthResult?.resultCode !== 'AuthenticationFinished'
            && preAuthResult?.resultCode !== 'Pending'
          ) {
            // Pre-auth refused or errored
            throw new Error(`Pre-auth failed: ${preAuthResult?.resultCode}`);
          } else {
            // Frictionless pre-auth (Authorized / Pending):
            // Use the pre-captured componentStateJson so the backend can build
            // the full /payments request.
            await checkoutApi.setPaymentMethod({
              code,
              additional_data: [{ key: 'state', value: componentStateJson }],
            });
          }
        }
      }
      // Place order — only reached after successful auth (or non-scheme methods)
      // eslint-disable-next-line no-console
      console.info(`[placeOrder] Starting placeOrder for cartId: ${cartId}`);
      // eslint-disable-next-line no-console
      console.info(`[placeOrder] Payment method code: ${code}`);
      const placeOrderStartTime = Date.now();
      try {
        await orderApi.placeOrder(cartId);
        const placeOrderDuration = Date.now() - placeOrderStartTime;
        // eslint-disable-next-line no-console
        console.info(
          `[placeOrder] SUCCESS after ${placeOrderDuration}ms for cartId: ${cartId}`,
        );
      } catch (placeOrderError) {
        const placeOrderDuration = Date.now() - placeOrderStartTime;
        // eslint-disable-next-line no-console
        console.error(
          `[placeOrder] FAILED after ${placeOrderDuration}ms for cartId: ${cartId}`,
          placeOrderError,
        );
        throw placeOrderError;
      } finally {
        // Clear the flag so onPaymentCompleted is not permanently disabled.
        setHandlePlaceOrderActive(false);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[handlePlaceOrder] Caught error:', error);
      if (error.message === '3DS2 cancelled by user') {
        // User dismissed the pre-auth modal — reset silently, no order created
        // eslint-disable-next-line no-console
        console.info('[handlePlaceOrder] 3DS2 cancelled by user');
        setHandlePlaceOrderActive(false);
        resetPlacingOrderState();
        placingOrder = false;
        removeOverlaySpinner(loaderRef, $loader);
        return;
      }
      if (
        error.message?.startsWith(
          '3DS2 authentication was not completed successfully',
        )
      ) {
        // Bank refused the pre-auth challenge — no order was created, cart is intact.
        // Show a user-friendly decline message instead of the generic dropin error.
        // eslint-disable-next-line no-console
        console.info('[handlePlaceOrder] 3DS2 authentication failed');
        setHandlePlaceOrderActive(false);
        resetPlacingOrderState();
        placingOrder = false;
        removeOverlaySpinner(loaderRef, $loader);
        showError(
          document.body,
          'We\'re sorry, your payment was declined. Please try again or use a different payment method.',
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[handlePlaceOrder] Unhandled error:', error);
      setHandlePlaceOrderActive(false);
      placingOrder = false;
      removeOverlaySpinner(loaderRef, $loader);
      throw error;
    }
    // For non-Adyen payments the spinner is removed here (synchronously after
    // placeOrder resolves, before handleOrderPlaced fires via BroadcastChannel).
    // For Adyen payments handleOrderPlaced owns the spinner from this point —
    // removing it here would cause a visible flash because BroadcastChannel
    // delivers order/placed asynchronously (after this line runs).
    if (!code.startsWith('adyen_')) {
      placingOrder = false;
      removeOverlaySpinner(loaderRef, $loader);
    }
  };

  // First, render the place order component
  await renderPlaceOrder($placeOrder, { handleValidation, handlePlaceOrder });

  // Render the remaining containers
  const [
    _mergedCartBanner,
    _header,
    _serverError,
    _outOfStock,
    _loginForm,
    shippingFormSkeleton,
    _billToShipping,
    _shippingMethods,
    _paymentMethods,
    billingFormSkeleton,
    _orderSummary,
    _cartSummary,
    _termsAndConditions,
    _giftOptions,
  ] = await Promise.all([
    renderMergedCartBanner($mergedCartBanner),

    renderCheckoutHeader($heading, 'Checkout'),

    renderServerError($serverError, $content),

    renderOutOfStock($outOfStock),

    renderLoginForm($login),

    renderShippingAddressFormSkeleton($shippingForm),

    renderBillToShippingAddress($billToShipping),

    renderShippingMethods($delivery),

    renderPaymentMethods($paymentMethods, creditCardFormRef),

    renderBillingAddressFormSkeleton($billingForm),

    renderOrderSummary($orderSummary),

    renderCartSummaryList($cartSummary),

    renderTermsAndConditions($termsAndConditions),

    renderGiftOptions($giftOptions),
  ]);

  async function initializeCheckout(data) {
    await initReCaptcha(0);
    if (data.isGuest) await displayGuestAddressForms(data);
    else {
      // Do not remove the spinner if a place-order flow is in progress —
      // cart/reset (emitted by placeOrder) triggers checkout/updated which
      // calls here, but the spinner must stay up until the 3DS2 modal appears
      // (or until handleOrderPlaced takes over and removes it via onMounted).
      if (!placingOrder) removeOverlaySpinner(loaderRef, $loader);
      await displayCustomerAddressForms(data);
    }
  }

  async function displayGuestAddressForms(data) {
    if (isVirtualCart(data)) {
      shippingForm?.remove();
      shippingForm = null;
      $shippingForm.innerHTML = '';
    } else if (!shippingForm) {
      shippingFormSkeleton.remove();

      shippingForm = await renderAddressForm(
        $shippingForm,
        shippingFormRef,
        data,
        'shipping',
      );
    }

    if (!billingForm) {
      billingFormSkeleton.remove();

      billingForm = await renderAddressForm(
        $billingForm,
        billingFormRef,
        data,
        'billing',
      );
    }
  }

  async function displayCustomerAddressForms(data) {
    if (isVirtualCart(data)) {
      shippingAddresses?.remove();
      shippingAddresses = null;
      $shippingForm.innerHTML = '';
    } else if (!shippingAddresses) {
      shippingForm?.remove();
      shippingForm = null;
      shippingFormRef.current = null;

      shippingAddresses = await renderCustomerShippingAddresses(
        $shippingForm,
        shippingFormRef,
        data,
      );
    }

    if (!billingAddresses) {
      billingForm?.remove();
      billingForm = null;
      billingFormRef.current = null;

      billingAddresses = await renderCustomerBillingAddresses(
        $billingForm,
        billingFormRef,
        data,
      );
    }
  }

  async function handleCheckoutUpdated(data) {
    if (!data) return;

    // If a guest email was saved before a payment-failure redirect, set it on
    // the new cart now that the dropin has initialized (cartId is valid).
    // checkout/initialized fires with email:"" on the freshly recovered cart;
    // the LoginForm's internal listener resets the Preact state to "" at that
    // point.  We call setGuestEmailOnCart here so the subsequent checkout/updated
    // (triggered by the mutation) carries email:guestEmail and the LoginForm
    // corrects its state automatically.  We also re-fill the DOM input immediately,
    // so the field is not visibly blank in the window between checkout/initialized
    // clearing it and checkout/updated restoring it.
    if (pendingGuestEmailRestore && data.isGuest) {
      const emailToRestore = pendingGuestEmailRestore;
      pendingGuestEmailRestore = null; // consume once
      checkoutApi.setGuestEmailOnCart(emailToRestore).catch((err) => {
        console.warn('handleCheckoutUpdated: setGuestEmailOnCart failed:', err);
      });
      // Re-fill the DOM input immediately — checkout/initialized has already
      // reset the controlled Preact input to "".
      fillGuestEmailInput($login, emailToRestore);
    }

    await initializeCheckout(data);
  }

  function handleAuthenticated(authenticated) {
    // The first event is always the initial auth state on page load — skip it.
    if (!firstAuthEventReceived) {
      firstAuthEventReceived = true;
      return;
    }

    if (!authenticated) return;

    // When a customer creates an account on the checkout success page and then
    // signs in, they will be redirected to the order details page with the order
    // number as orderRef, allowing the order details to be displayed
    const orderData = events.lastPayload('order/placed');
    if (orderData) {
      const url = buildOrderDetailsUrl(orderData);
      window.history.pushState({}, '', url);
    }

    // Only reload when the user signs in *during* the current page session.
    // If this page load is a 3DS2 payment failure recovery redirect (indicated
    // by PAYMENT_ERROR in sessionStorage), a reload is destructive: it fires
    // before the payment-methods dropin renders, preventing the decline error
    // banner from being displayed to the customer.
    if (!isPaymentErrorRecovery) {
      window.location.reload();
    }
  }

  function handleCheckoutValues(payload) {
    const { isBillToShipping } = payload;
    $billingForm.style.display = isBillToShipping ? 'none' : 'block';
  }

  async function handleOrderPlaced(orderData) {
    console.info('[handleOrderPlaced] Called with orderData:', {
      number: orderData?.number,
      email: orderData?.email,
      id: orderData?.id,
      token: orderData?.token,
    });

    // lastPlacedOrderPaymentCode is set when the storefront Place Order button is
    // clicked (server-side card flow, Google Pay). For wallet payments that bypass
    // the Place Order button (Apple Pay), it remains null — fall back to the stored
    // payment result which is always written before order/placed is emitted.
    const isAdyenPayment = lastPlacedOrderPaymentCode?.startsWith('adyen_')
      || getPaymentResultSync()?.paymentMethod?.type != null;

    console.info('[handleOrderPlaced] isAdyenPayment:', isAdyenPayment);
    console.info('[handleOrderPlaced] lastPlacedOrderPaymentCode:', lastPlacedOrderPaymentCode);
    console.info('[handleOrderPlaced] paymentResultSync:', getPaymentResultSync());

    if (isAdyenPayment) {
      console.info('[handleOrderPlaced] Adyen payment - displaying spinner and fetching result');
      await displayOverlaySpinner(loaderRef, $loader);

      // If the frontend already has a success result from a prior /payments call
      // (e.g. Google Pay's createDefaultOnSubmit got 'Authorised' before order/placed fired),
      // skip fetchOrderResult — the frontend result is authoritative and querying the backend
      // at this point would race against process-order-payment which hasn't stored its result yet.
      const SUCCESS_RESULT_CODES_IMMEDIATE = ['Authorised', 'Pending', 'Received'];
      const existingResult = getPaymentResultSync();
      const hasImmediateSuccess = existingResult?.resultCode
        && SUCCESS_RESULT_CODES_IMMEDIATE.includes(existingResult.resultCode)
        && !existingResult.action; // No 3DS action pending

      if (hasImmediateSuccess) {
        console.info('[handleOrderPlaced] Immediate success result available, skipping fetchOrderResult:', {
          resultCode: existingResult.resultCode,
          pspReference: existingResult.pspReference,
        });
      } else {
        // Start fetching the payment result from the backend, then await it
        // Pass the stored cartId so it's available even after cart/reset has cleared sessionStorage
        console.info('[handleOrderPlaced] Fetching order result for:', {
          orderNumber: orderData.number,
          email: orderData.email,
          cartId: lastPlacedOrderCartId,
          hasOrderToken: !!orderData.token,
        });
        // orderData.token is the Commerce order token for this specific order — the same anchor
        // already sent to recover-cart. Guest orders carry it; authenticated orders do not, and
        // the backend binds those to the account instead.
        fetchOrderResult(
          orderData.number,
          orderData.email,
          lastPlacedOrderCartId,
          orderData.token,
        );
      }
      const result = hasImmediateSuccess ? existingResult : await getPaymentResult();

      console.info('[handleOrderPlaced] Payment result received:', {
        resultCode: result?.resultCode,
        pspReference: result?.pspReference,
        newCartId: result?.newCartId,
        action: result?.action ? 'has 3DS action' : 'no action',
        keys: result ? Object.keys(result) : [],
      });

      // Cart recovery: if payment failed and no cart was yet created,
      // call the backend recover-cart action to create a new cart so the
      // customer can retry checkout.
      const FAILURE_RESULT_CODES = ['Refused', 'Error', 'Cancelled'];
      console.info('[handleOrderPlaced] Checking recovery conditions:', {
        hasResultCode: !!result?.resultCode,
        isFailure: result?.resultCode && FAILURE_RESULT_CODES.includes(result.resultCode),
        hasNewCartId: !!result?.newCartId,
        shouldRecover:
        result?.resultCode
        && FAILURE_RESULT_CODES.includes(result.resultCode)
        && !result.newCartId,
      });

      if (
        result?.resultCode
        && FAILURE_RESULT_CODES.includes(result.resultCode)
        && !result.newCartId
      ) {
        console.info('[handleOrderPlaced] TRIGGERING RECOVERY - calling recoverCart');
        // Remove loader before recovery — we will redirect back to checkout
        removeOverlaySpinner(loaderRef, $loader);
        await recoverCart(
          orderData.number,
          orderData.email,
          result.resultCode,
          {
            orderToken: orderData.token,
            orderId: orderData.id,
            comment: `Payment declined by Adyen: ${result.resultCode}`,
          },
        );
        console.info('[handleOrderPlaced] Recovery completed, redirecting to /checkout');
        // After recovery, redirect to /checkout for retry.
        // Persist the error message so it survives the page reload and is
        // displayed to the customer on the /checkout page.
        const declineMessage = "We're sorry, your payment was declined. Please try again or use a different payment method.";
        try {
          sessionStorage.setItem(STORAGE_KEYS.PAYMENT_ERROR, declineMessage);
          // Persist guest email and name so they can be pre-filled after redirect.
          // Use orderData directly instead of getCheckoutDataSnapshot() to avoid a
          // race condition: by the time this code runs, cart/reset (emitted by
          // placeOrder alongside order/placed) has caused checkout/initialized to
          // fire with the new empty cart, overwriting checkoutData with email:"".
          // orderData is the immutable placed-order payload and always carries the
          // correct guest email and billing address.
          if (orderData.email) {
            sessionStorage.setItem(STORAGE_KEYS.GUEST_EMAIL, orderData.email);
          }
          const billingAddr = orderData.billingAddress;
          if (billingAddr?.firstName) {
            sessionStorage.setItem(
              STORAGE_KEYS.GUEST_FIRSTNAME,
              billingAddr.firstName,
            );
          }
          if (billingAddr?.lastName) {
            sessionStorage.setItem(
              STORAGE_KEYS.GUEST_LASTNAME,
              billingAddr.lastName,
            );
          }
        } catch {
          /* ignore */
        }
        placingOrder = false;
        resetPlacingOrderState();
        window.location.href = '/checkout';
        return;
      }

      // If the backend already recovered the cart and returned a newCartId directly
      // in the /order-result response, the block above was skipped (condition requires
      // !result.newCartId). We still need to persist guest fields and redirect for retry.
      if (
        result?.resultCode
        && FAILURE_RESULT_CODES.includes(result.resultCode)
        && result.newCartId
      ) {
        // Remove loader before redirecting back to checkout on error
        removeOverlaySpinner(loaderRef, $loader);
        const declineMessage = "We're sorry, your payment was declined. Please try again or use a different payment method.";
        try {
          sessionStorage.setItem(STORAGE_KEYS.PAYMENT_ERROR, declineMessage);
          if (orderData.email) {
            sessionStorage.setItem(STORAGE_KEYS.GUEST_EMAIL, orderData.email);
          }
          const billingAddrRecovered = orderData.billingAddress;
          if (billingAddrRecovered?.firstName) {
            sessionStorage.setItem(
              STORAGE_KEYS.GUEST_FIRSTNAME,
              billingAddrRecovered.firstName,
            );
          }
          if (billingAddrRecovered?.lastName) {
            sessionStorage.setItem(
              STORAGE_KEYS.GUEST_LASTNAME,
              billingAddrRecovered.lastName,
            );
          }
        } catch {
          /* ignore */
        }
        placingOrder = false;
        resetPlacingOrderState();
        window.location.href = '/checkout';
        return;
      }

      if (result?.action && isNative3DSAction(result.action)) {
        console.info('[handleOrderPlaced] 3DS action detected - mounting modal');
        // Native 3DS: mount the 3DS component in a modal overlay and wait for it to complete.
        // mountNative3DSComponent returns a teardown function to remove the modal.
        // The onAdditionalDetails handler (createDefaultOnAdditionalDetails in handlers.js)
        // will call payments-details. The order is already placed at this point, so we store
        // orderData as pendingOrderData so onAdditionalDetails takes the server-side branch
        // (finds storedPendingOrder → emits order/placed directly, no second placeOrder call).
        // That second order/placed fires the subscription below which tears down the modal.
        // NOTE: the spinner is removed inside mountNative3DSComponent right after the modal
        // is appended to the DOM, so the transition is seamless (no bare-page flash).
        resetPlacingOrderState();
        setPendingOrderData(orderData);

        // Register the success listener BEFORE mounting to avoid a race condition where
        // 3DS completes (and order/placed fires) before the listener is registered.
        // teardownRef holds a reference updated as soon as mountNative3DSComponent
        // resolves — even if order/placed fires first, the subscription checks teardownRef
        // again after mount so the teardown is never missed.
        let subscriptionDone = false;
        const teardownRef = { current: null };
        const subscription = events.on('order/placed', () => {
          console.info('[handleOrderPlaced] 3DS subscription fired - second order/placed event');
          if (subscriptionDone) return;
          subscriptionDone = true;
          subscription.off();
          if (typeof teardownRef.current === 'function') {
            console.debug('[handleOrderPlaced] Calling teardown to remove 3DS modal');
            teardownRef.current();
          }
          // Clear the action so renderCheckoutSuccess does not call renderAction
          // (which would trigger a redirect). The second order/placed invocation of
          // handleOrderPlaced will call getPaymentResult() — by the time it does,
          // the action field will already be gone from the in-memory cache.
          const currentResult = result;
          if (currentResult) {
            const { action: _action, ...resultWithoutAction } = currentResult;
            setPaymentResult(resultWithoutAction);
          }
        });

        try {
          console.debug('[handleOrderPlaced] Calling mountNative3DSComponent...');
          teardownRef.current = await mountNative3DSComponent(
            result.action,
            orderData,
            {
              onMounted: () => {
                console.info('[handleOrderPlaced] 3DS Modal onMounted - setting placingOrder=false, keeping loader visible');
                placingOrder = false;
                // Keep loader visible during 3DS modal — it will be removed only
                // if there's an error, or stay visible during redirect to success.
                // Do NOT call removeOverlaySpinner here.
              },
              onDismiss: () => {
                console.info('[handleOrderPlaced] 3DS Modal onDismiss - user closed or error occurred');
                if (!subscriptionDone) {
                  subscriptionDone = true;
                  subscription.off();
                }
                clearPendingOrderData();
                resetPlacingOrderState();
                // Keep loader visible when modal closes — page will redirect to
                // success or display error on next order/placed event.
                // Do NOT call removeOverlaySpinner here.
              },
            },
          );
          console.info('[handleOrderPlaced] mountNative3DSComponent completed');
          // If order/placed already fired while mountNative3DSComponent was awaiting
          // (e.g., silent fingerprint completed before mount resolved), subscriptionDone
          // will be true, but teardownRef.current was not yet set — tear down now.
          if (subscriptionDone && typeof teardownRef.current === 'function') {
            console.debug('[handleOrderPlaced] Teardown not yet called, calling now');
            teardownRef.current();
          }
        } catch (err) {
          console.error('[handleOrderPlaced] Error mounting 3DS component:', err);
          if (!subscriptionDone) {
            subscriptionDone = true;
            subscription.off();
          }
          throw err;
        }

        return;
      }
    }

    // Clear the tracked payment code after use (but NOT cartId - see)
    // NOTE: resetPlacingOrderState() now only clears payment code, not cartId
    lastPlacedOrderPaymentCode = null;

    // For success path: keep spinner visible during redirect to success page.
    // Do NOT remove loader — it stays up until page navigation completes.
    // This provides visual continuity from modal close through success page load.
    console.info('[handleOrderPlaced] SUCCESS PATH - rendering checkout success page');
    console.info('[handleOrderPlaced] LOADER STATUS - keeping spinner visible for success redirect', {
      loaderRefExists: !!loaderRef.current,
      placingOrder,
      loaderHTML: $loader?.innerHTML?.substring(0, 100),
    });
    placingOrder = false;
    // Keep loaderRef.current intact — page redirect will navigate away,
    // and the spinner provides visual feedback during the transition.
    // Do NOT call removeOverlaySpinner here.

    // LIFECYCLE MONITORING: Track loader visibility during success page render
    // and page navigation to identify when/why it disappears
    const loaderMonitorStartTime = Date.now();
    const loaderMonitorInterval = setInterval(() => {
      const elapsed = Date.now() - loaderMonitorStartTime;
      const loaderStyle = window.getComputedStyle($loader);
      const spinnerElement = $loader.querySelector('[class*="progress-spinner"]')
        || $loader.querySelector('[class*="ProgressSpinner"]')
        || $loader.firstChild;
      const spinnerStyle = spinnerElement ? window.getComputedStyle(spinnerElement) : null;

      console.debug(`[handleOrderPlaced] LOADER MONITOR +${elapsed}ms`, {
        loaderDisplay: loaderStyle.display,
        loaderVisibility: loaderStyle.visibility,
        loaderOpacity: loaderStyle.opacity,
        loaderChildren: $loader.children.length,
        spinnerFound: !!spinnerElement,
        spinnerDisplay: spinnerStyle?.display,
        spinnerOpacity: spinnerStyle?.opacity,
        spinnerHTML: spinnerElement?.innerHTML?.substring(0, 50),
      });

      if (elapsed > 5000) {
        clearInterval(loaderMonitorInterval);
        console.info('[handleOrderPlaced] LOADER MONITOR stopped after 5s');
      }
    }, 500);

    // Store interval ref to clear if needed
    loaderRef.monitorInterval = loaderMonitorInterval;

    // Clear address form data
    sessionStorage.removeItem(SHIPPING_ADDRESS_DATA_KEY);
    sessionStorage.removeItem(BILLING_ADDRESS_DATA_KEY);

    const url = buildOrderDetailsUrl(orderData);

    window.history.pushState({}, '', url);

    // CRITICAL: Before calling renderCheckoutSuccess, which will call container.replaceChildren(),
    // we MUST save and restore the loader so it doesn't get removed from the DOM.
    // The success page render clears all children of the block, including the loader.
    // However, on second order/placed event, the parent may have already been replaced.
    // Only save/restore if this is the first time through (loaderRef.current should exist).
    let savedLoader = null;
    let savedLoaderParent = null;
    let savedLoaderNextSibling = null;

    if (loaderRef.current && $loader.parentElement) {
      savedLoader = $loader.cloneNode(true);
      savedLoaderParent = $loader.parentElement;
      savedLoaderNextSibling = $loader.nextElementSibling;

      console.info('[handleOrderPlaced] SUCCESS PAGE RENDER START - saved loader before replaceChildren', {
        loaderParentClass: savedLoaderParent?.className,
        loaderNextSiblingClass: savedLoaderNextSibling?.className,
        savedLoaderHTML: savedLoader.innerHTML.substring(0, 50),
      });
    } else {
      console.info('[handleOrderPlaced] SUCCESS PAGE RENDER START - skipping save (loader not in DOM or no loaderRef)', {
        loaderRefExists: !!loaderRef.current,
        loaderInDOM: !!$loader.parentElement,
      });
    }

    await renderCheckoutSuccess(block, { orderData });

    console.info('[handleOrderPlaced] SUCCESS PAGE RENDER COMPLETE - cleaning up loader', {
      loaderExists: !!$loader,
      loaderParentStillExists: !!savedLoaderParent,
      currentBlockChildren: block.children.length,
      hasSavedLoader: !!savedLoader,
    });

    // Remove the loader from DOM after success page is rendered
    // The loader's job is done - it kept the user informed during async operations
    // Now we need to show the success page content without obstruction
    if ($loader && $loader.parentElement) {
      try {
        $loader.remove();
        console.info('[handleOrderPlaced] Loader removed from DOM to show success page');
      } catch (err) {
        console.error('[handleOrderPlaced] Error removing loader:', err.message);
      }
    }

    // Clear cartId AFTER order success page has been rendered,
    // since donation component initialization needs it
    lastPlacedOrderCartId = null;
    window.__adyenCheckoutLastCartId = null;
  }

  // Show a test mode warning banner for payment methods
  async function showPaymentMethodsTestModeWarning() {
    try {
      // Dynamically import Adyen configuration
      const { getAdyenConfiguration } = await import(
        '../adyen-payment/index.js'
      );
      const config = await getAdyenConfiguration();

      if (config?.environment?.toLowerCase() === 'test') {
        // Find the payment methods content container
        const paymentMethodsContent = $paymentMethods.querySelector(
          '.checkout-payment-methods__content',
        );

        if (paymentMethodsContent) {
          // Check if a warning already exists
          const existingWarning = paymentMethodsContent.querySelector(
            '.checkout-payment-methods-test-warning',
          );
          if (existingWarning) return;

          // Create a warning banner
          const warningBanner = document.createElement('div');
          warningBanner.className = 'checkout-payment-methods-test-warning';
          warningBanner.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 20h20L12 2z" fill="#ffc107"/>
              <path d="M11 10h2v5h-2v-5zm0 6h2v2h-2v-2z" fill="#000"/>
            </svg>
            <span><strong>TEST MODE</strong> - Payments are in test mode</span>
          `;

          // Insert at the beginning of payment methods content
          paymentMethodsContent.insertBefore(
            warningBanner,
            paymentMethodsContent.firstChild,
          );
        }
      }
    } catch (error) {
      console.debug('Failed to check Adyen test mode:', error);
    }
  }

  // Set up an observer to watch for payment methods content being rendered
  function setupPaymentMethodsTestModeWatcher() {
    const observer = new MutationObserver(() => {
      const paymentMethodsContent = $paymentMethods.querySelector(
        '.checkout-payment-methods__content',
      );
      if (paymentMethodsContent) {
        showPaymentMethodsTestModeWarning();
      }
    });

    observer.observe($paymentMethods, {
      childList: true,
      subtree: true,
    });

    // Also, check immediately in case it's already rendered
    showPaymentMethodsTestModeWarning();
  }

  setupPaymentMethodsTestModeWatcher();

  // If a 3DS2 payment failure caused a redirect back to this page, the error
  // message was saved to sessionStorage before the redirect. Display it now
  // so it survives Preact re-renders of the payment-methods dropin.
  //
  // Strategy: inject the banner directly into $paymentMethods as a sibling
  // *before* the Preact-managed content.  Preact only reconciles the nodes it
  // created (tracked by its internal fiber tree); later re-renders
  //  leave foreign nodes prepended to the container untouched.  This avoids
  // the previous approach of waiting for .checkout-payment-methods__content
  // and inserting inside it, which was unreliable because every
  // checkout/updated re-render wiped the manually injected banner.
  (function showPersistedPaymentError() {
    let errorMessage;
    try {
      errorMessage = sessionStorage.getItem(STORAGE_KEYS.PAYMENT_ERROR);
    } catch {
      /* ignore */
    }
    if (!errorMessage) return;

    try {
      sessionStorage.removeItem(STORAGE_KEYS.PAYMENT_ERROR);
    } catch {
      /* ignore */
    }

    // Build the banner the same way showError() does, but insert it as the
    // first child of $paymentMethods instead of inside the Preact subtree.
    const errorBanner = document.createElement('div');
    errorBanner.className = 'checkout-payment-methods-error';
    errorBanner.id = 'adyen-persisted-payment-error';
    errorBanner.setAttribute('role', 'alert');
    errorBanner.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" fill="#dc3545"/>
        <path d="M12 7v6M12 17h.01" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span>${errorMessage}</span>
    `;
    $paymentMethods.insertBefore(errorBanner, $paymentMethods.firstChild);
  }());

  // After a payment failure redirect, restore the guest email and name fields
  // so the customer does not have to re-type them.
  (function restoreGuestFields() {
    let guestEmail;
    let guestFirstname;
    let guestLastname;
    try {
      guestEmail = sessionStorage.getItem(STORAGE_KEYS.GUEST_EMAIL);
      guestFirstname = sessionStorage.getItem(STORAGE_KEYS.GUEST_FIRSTNAME);
      guestLastname = sessionStorage.getItem(STORAGE_KEYS.GUEST_LASTNAME);
    } catch {
      /* ignore */
    }
    if (!guestEmail && !guestFirstname && !guestLastname) return;

    // Remove from sessionStorage immediately — single-use.
    try {
      if (guestEmail) sessionStorage.removeItem(STORAGE_KEYS.GUEST_EMAIL);
      if (guestFirstname) sessionStorage.removeItem(STORAGE_KEYS.GUEST_FIRSTNAME);
      if (guestLastname) sessionStorage.removeItem(STORAGE_KEYS.GUEST_LASTNAME);
    } catch {
      /* ignore */
    }

    // Store the email for handleCheckoutUpdated to set on the Magento cart once
    // checkout/initialized fires and the dropin has a valid cartId.  We cannot
    // call setGuestEmailOnCart here because the dropin has not yet initialized
    // the new cart (m.cartId is empty / stale), so the mutation would fail or
    // operate on the wrong cart.
    if (guestEmail) {
      pendingGuestEmailRestore = guestEmail;
    }

    // Do an initial DOM fill in case the LoginForm input is already rendered.
    // If not, observe for it.  This gives immediate visual feedback before the
    // async setGuestEmailOnCart path takes over.
    function tryFill() {
      const emailInput = $login.querySelector('input[name="customer-email"]');
      if (!emailInput) return false;
      if (guestEmail) fillGuestEmailInput($login, guestEmail);
      return true;
    }

    // The LoginForm dropin may have already rendered by the time this runs
    // (because renderLoginForm is awaited above in Promise.all). Check first;
    // if the input is not yet present, observe for it.
    if (tryFill()) return;

    const observer = new MutationObserver(() => {
      if (tryFill()) observer.disconnect();
    });

    observer.observe($login, { childList: true, subtree: true });

    // Disconnect after 10 s to avoid memory leaks if the form never appears.
    setTimeout(() => observer.disconnect(), 10000);
  }());

  // Show the overlay spinner while cart recovery is in flight after a 3DS2
  // payment failure. The spinner stays up until the page navigates to /checkout.
  setRecoveryStartCallback(() => displayOverlaySpinner(loaderRef, $loader));

  events.on('authenticated', handleAuthenticated);
  events.on('checkout/initialized', handleCheckoutUpdated, { eager: true });
  events.on('checkout/updated', handleCheckoutUpdated);
  events.on('checkout/values', handleCheckoutValues);

  console.info('[commerce-checkout] Registering order/placed event listener for handleOrderPlaced');
  events.on('order/placed', (payload) => {
    console.info('[commerce-checkout] order/placed event fired:', {
      timestamp: new Date().toISOString(),
      hasPayload: !!payload,
    });
    handleOrderPlaced(payload);
  });

  // Clear stale payment results when a new cart is initialized.
  // This prevents preOrderPspReference from a previous checkout from being
  // reused in a new checkout session (guest checkout vulnerability).
  // The payment result should only be valid for the checkout session that created it.
  // Only clear if the cart ID has actually changed (new checkout session).
  events.on('cart/initialized', (newCartData) => {
    // Only clear payment result if this is a different cart (new checkout)
    if (newCartData?.id && newCartData.id !== lastPlacedOrderCartId) {
      clearPaymentResult();
      console.debug('[Commerce Checkout] Cleared stale payment result for new cart', {
        previousCartId: lastPlacedOrderCartId,
        newCartId: newCartData?.id,
      });
    }
    if (!isPaymentErrorRecovery) {
      redirectToCartIfEmpty(newCartData);
    }
  }, { eager: true });
  events.on('cart/data', (newCartData) => {
    if (!isPaymentErrorRecovery) {
      redirectToCartIfEmpty(newCartData);
    }
  });
}

// Export getter for lastPlacedOrderCartId so other components can access it
// Cart ID is needed by order success page for donation component
// initialization. It's cleared only after success page rendering is complete.
export function getLastPlacedOrderCartId() {
  const cartId = window.__adyenCheckoutLastCartId || null;
  if (!cartId) {
    console.debug('[Commerce Checkout] getLastPlacedOrderCartId: no cart ID available for donation component');
  }
  return cartId;
}
