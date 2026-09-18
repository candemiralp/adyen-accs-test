/**
 * Adyen Payment Handlers Module
 *
 * Default handlers for Adyen payment flow:
 * - onSubmit: Initial payment submission
 * - onAdditionalDetails: 3DS2 challenge, redirect return
 * - onPaymentCompleted: Final payment completion
 */

import { events } from '@dropins/tools/event-bus.js';
import {
  placeOrder,
  cancelOrder,
  requestGuestOrderCancel,
} from '@dropins/storefront-order/api.js';
import * as checkoutApi from '@dropins/storefront-checkout/api.js';

import {
  setPaymentResult,
  getPaymentResultSync,
  getPendingOrderData,
  clearPendingOrderData,
  getCheckoutAttemptId,
} from './state.js';

import { STORAGE_KEYS } from './storage.js';

import {
  commerceToAdyenBillingAddress,
  commerceToAdyenShippingAddress,
  formatAmount,
  isNative3DSAction,
  showError,
} from './utils.js';
import { adyenFetch } from '../../scripts/adyen-auth.js';

/**
 * Convert boolean isGuest to string for backend compatibility
 * Backend expects 'true' or 'false' as strings, not booleans
 * @param {boolean|undefined} isGuest
 * @returns {string} 'true' or 'false'
 */
function stringifyIsGuest(isGuest) {
  return String(isGuest === true);
}

// ============================================================================
// MANUAL SUBMIT (for card payments going through Commerce)
// ============================================================================

/**
 * Manual submit handler for Adyen payments.
 * Validates forms and submits payment data.
 *
 * @param {Object} state - Adyen component state
 * @param {Object} component - Adyen component instance
 * @param {Object} actions - Adyen actions (resolve/reject)
 */
export async function manualSubmit(state, component, actions) {
  try {
    // Comprehensive validation matching Place Order behavior
    const { forms } = document;
    const isFormVisible = (form) => form && form.offsetParent !== null;

    // 1. Check login form (email)
    const loginForm = forms['login-form'];
    if (isFormVisible(loginForm) && !loginForm.checkValidity()) {
      loginForm.reportValidity();
      actions.reject('Please fill in your email address');
      return;
    }

    // 2. Check shipping address form
    const shippingForm = forms['checkout-shipping-address-form'];
    if (isFormVisible(shippingForm) && !shippingForm.checkValidity()) {
      shippingForm.reportValidity();
      actions.reject('Please complete the shipping address');
      return;
    }

    // 3. Check billing address form
    const billingForm = forms['checkout-billing-address-form'];
    if (isFormVisible(billingForm) && !billingForm.checkValidity()) {
      billingForm.reportValidity();
      actions.reject('Please complete the billing address');
      return;
    }

    // 4. Check shipping method selection
    const shippingMethodsContainer = document.querySelector(
      '.checkout-shipping-methods__methods',
    );
    if (
      shippingMethodsContainer
      && shippingMethodsContainer.offsetParent !== null
    ) {
      const selectedShipping = shippingMethodsContainer.querySelector(
        'input[type="radio"]:checked',
      );
      if (!selectedShipping) {
        actions.reject('Please select a shipping method');
        return;
      }
    }

    // All validations passed - submit through Commerce
    await checkoutApi.setPaymentMethod({
      code: `adyen_${state.data.paymentMethod.type}`,
      additional_data: [{ key: 'state', value: JSON.stringify(state.data) }],
    });

    actions.resolve({
      resultCode: 'Backend',
    });
  } catch (error) {
    console.error('Manual submit error:', error);
    // const errorMessage = error.message || 'Validation failed. Please check your information.';
    if (component.props?.onError) {
      component.props.onError(error);
    }
    actions.reject();
  }
}

// ============================================================================
// DEFAULT ON SUBMIT (for client-side payments like PayPal, Google Pay)
// ============================================================================

/**
 * Flag indicating that handlePlaceOrder in commerce-checkout.js is currently
 * managing order placement for this payment. When true, createDefaultOnSubmit
 * resolves with 'Backend' so onPaymentCompleted does not also call placeOrder.
 *
 * This is needed for Google Pay (and similar methods) on the checkout page where:
 * - The component-level onSubmit calls triggerPlaceOrder() (which triggers handlePlaceOrder)
 * - The checkout-instance-level createDefaultOnSubmit also fires and POSTs /payments
 * - Without this flag, onPaymentCompleted('Authorised') would call placeOrder a second time
 *
 * Apple Pay and PayPal do NOT call triggerPlaceOrder — they rely on onPaymentCompleted
 * to place the order, so this flag must remain false for them.
 */
let handlePlaceOrderActive = false;

/**
 * Signal that handlePlaceOrder is now managing order placement.
 * Call before handlePlaceOrder begins; clear after placeOrder completes or errors.
 */
export function setHandlePlaceOrderActive(active) {
  handlePlaceOrderActive = active;
}

/**
 * Promise that resolves when createDefaultOnSubmit has stored a payment result
 * (i.e. called setPaymentResult). handlePlaceOrder awaits this so that the
 * preOrderPspReference is available before setPaymentMethod + placeOrder run.
 *
 * Scenario: Google Pay fires onSubmit on both the component (adyen-payment-googlepay.js,
 * which calls triggerPlaceOrder synchronously) and the checkout instance
 * (createDefaultOnSubmit, which POSTs /payments asynchronously). handlePlaceOrder
 * reads getPaymentResultSync() to get preOrderPspReference, but that value is only
 * populated after createDefaultOnSubmit's /payments call completes. Without waiting,
 * preOrderPspReference is null → process-order-payment calls /payments again with the
 * already-consumed Google Pay token → 422 → stored as resultCode: Error → spurious
 * cart recovery on the success page.
 */
let onSubmitResolve = null;
let onSubmitPromise = null;

function resetOnSubmitPromise() {
  onSubmitPromise = new Promise((resolve) => {
    onSubmitResolve = resolve;
  });
}

// Initialise once at module load so the promise is always available.
resetOnSubmitPromise();

/**
 * Wait for the current createDefaultOnSubmit invocation to complete (i.e. for
 * setPaymentResult to have been called). Resolves immediately if no submit is
 * currently in flight. Includes a safety timeout so handlePlaceOrder is never
 * blocked indefinitely (e.g. if the SDK fires onSubmit only on the component
 * and not on the instance).
 *
 * @param {number} [timeoutMs=8000] - Maximum ms to wait.
 * @returns {Promise<void>}
 */
export function waitForOnSubmitResult(timeoutMs = 8000) {
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
  return Promise.race([onSubmitPromise, timeout]);
}

/**
 * Create default onSubmit handler.
 * @param {string} baseUrl - Backend integration URL
 * @param {Function} getCartData - Function that returns current cart data
 * @param {Function} getCheckoutData - Function that returns current checkout data
 * @param {string} scope - Store scope
 * @returns {Function}
 */
export function createDefaultOnSubmit(
  baseUrl,
  getCartData,
  getCheckoutData,
  scope,
) {
  return async (state, component, actions) => {
    // Arm a fresh promise so handlePlaceOrder (triggered by triggerPlaceOrder inside
    // the component-level onSubmit) can await this invocation completing.
    resetOnSubmitPromise();

    // Show loader to indicate payment processing
    const paymentMethodsContainer = document.querySelector('.checkout-payment-methods');
    paymentMethodsContainer?.classList.add('loading');

    try {
      // Get current data at submission time
      const cartData = getCartData();
      const checkoutData = getCheckoutData();

      // COMPREHENSIVE LOGGING: Capture raw Adyen SDK state.data structure at submission time
      console.debug('[Adyen] RAW state.data from Adyen SDK at submission:', {
        stateDataKeys: state.data ? Object.keys(state.data) : [],
        stateData: JSON.parse(JSON.stringify(state.data)), // Deep clone to avoid circular refs
        paymentMethodField: state.data?.paymentMethod,
        paymentMethodKeys: state.data?.paymentMethod ? Object.keys(state.data.paymentMethod) : [],
        typeField: state.data?.type,
        stateDataFull: state.data,
      });

      console.debug('[Adyen] createDefaultOnSubmit: payment submission started', {
        hasCartData: !!cartData,
        cartDataId: cartData?.id || 'MISSING',
        cartDataKeys: cartData ? Object.keys(cartData) : [],
        hasCheckoutData: !!checkoutData,
      });

      if (!cartData?.id) {
        const errorMessage = 'Cart is no longer available. Please refresh the page and try again.';
        console.debug('createDefaultOnSubmit: cartData is null or missing id', {
          cartData,
        });
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      // Fix #2: Validate cart total
      if (!cartData.total?.includingTax?.value) {
        const errorMessage = 'Cart total is invalid. Please refresh the page and try again.';
        console.debug('createDefaultOnSubmit: cartData total is missing', {
          total: cartData.total,
        });
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      // Fix #2: Validate cart currency
      if (!cartData.total?.includingTax?.currency) {
        const errorMessage = 'Cart currency is invalid. Please refresh the page and try again.';
        console.debug('createDefaultOnSubmit: cartData currency is missing', {
          currency: cartData.total?.includingTax?.currency,
        });
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      // Fix #2: Validate cart has items (for non-virtual carts)
      if (!cartData.isVirtual && (!Array.isArray(cartData.items) || cartData.items.length === 0)) {
        const errorMessage = 'Cart is empty. Please add items before proceeding.';
        console.debug('createDefaultOnSubmit: cartData has no items', {
          items: cartData.items,
          isVirtual: cartData.isVirtual,
        });
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      console.debug('[Adyen] Cart validation passed', {
        cartId: cartData.id,
        total: cartData.total.includingTax.value,
        currency: cartData.total.includingTax.currency,
        itemCount: cartData.items?.length || 0,
      });

      const shippingAddress = checkoutData?.shippingAddresses?.[0] || null;

      // Build shopper data for the payment request
      const shopperData = {
        telephoneNumber: checkoutData.billingAddress.telephone,
        shopperEmail: checkoutData?.email,
        shopperReference: checkoutData?.shopperId || checkoutData?.email,
        shopperName: {
          firstName:
            shippingAddress?.firstName
            || checkoutData?.billingAddress?.firstName,
          lastName:
            shippingAddress?.lastName || checkoutData?.billingAddress?.lastName,
        },
        billingAddress: commerceToAdyenBillingAddress(
          checkoutData.billingAddress,
        ),
        countryCode: checkoutData.billingAddress.country.code,
        deliveryAddress: !cartData?.isVirtual
          ? commerceToAdyenShippingAddress(shippingAddress)
          : undefined,
      };

      const res = await adyenFetch(`${baseUrl}payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: cartData.id,
          isGuest: stringifyIsGuest(checkoutData?.isGuest),
          scope,
          paymentRequest: {
            ...state.data,
            ...shopperData,
            checkoutAttemptId: getCheckoutAttemptId(cartData?.id),
            amount: formatAmount(
              cartData.total?.includingTax?.value,
              cartData.total?.includingTax?.currency,
            ),
            origin: window.location.origin,
            reference: cartData.id,
            lineItems: cartData.items.map((item) => ({
              id: item.uid,
              description: item.name,
              quantity: item.quantity,
              amountIncludingTax: Math.round(item.total.value * 100),
            })),
          },
        }),
      }, { backendUrl: baseUrl, cartId: cartData.id, isGuest: checkoutData?.isGuest });

      // Check for HTTP errors
      if (!res.ok) {
        let errorMessage = 'Payment request failed';
        try {
          const errorData = await res.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch {
          if (res.status === 500) {
            errorMessage = 'Server error occurred. Please try again.';
          } else if (res.status === 404) {
            errorMessage = 'Payment service not found. Please contact support.';
          } else {
            errorMessage = `Payment request failed with status ${res.status}`;
          }
        }
        console.debug('Payment HTTP error:', res.status, errorMessage);
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      const result = await res.json();

      // COMPREHENSIVE LOGGING: Capture full backend /payments response
      console.debug('[Adyen] FULL /payments response from backend:', {
        resultCodeResponse: result.resultCode,
        resultKeys: result ? Object.keys(result) : [],
        pspReferenceResponse: result.pspReference,
        merchantReferenceResponse: result.merchantReference,
        donationTokenResponse: result.donationToken,
        actionResponse: result.action,
        resultFull: JSON.parse(JSON.stringify(result)), // Deep clone for logging
      });

      if (!result.resultCode) {
        const errorMessage = 'Invalid payment response';
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      if (result.resultCode === 'Refused') {
        const errorMessage = "We're sorry, your payment was declined";
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      console.debug('[Adyen] Payment successful, preparing to store result', {
        cartDataId: cartData?.id || 'MISSING',
        hasCartData: !!cartData,
        cartDataKeys: cartData ? Object.keys(cartData) : [],
        resultCode: result.resultCode,
        pspReference: result.pspReference,
        stateDataPaymentMethod: state.data?.paymentMethod,
        stateDataType: state.data?.type,
      });

      // Determine payment method - for wallet methods (PayPal, Apple Pay, etc.),
      // the type may not be available in state.data yet, so we capture the full
      // state for later extraction in onAdditionalDetails
      const paymentMethodForStorage = state.data?.paymentMethod || {
        type: state.data?.type || 'unknown',
      };

      console.debug('[Adyen] Payment method for storage:', {
        paymentMethodForStorage,
        stateDataPaymentMethod: state.data?.paymentMethod,
        stateDataType: state.data?.type,
        fallbackUsed: !state.data?.paymentMethod && state.data?.type,
      });

      setPaymentResult({
        pspReference: result.pspReference,
        merchantReference: result.merchantReference,
        paymentMethod: paymentMethodForStorage,
        donationToken: result.donationToken,
        action: result.action,
        resultCode: result.resultCode,
        cartId: cartData.id,
        // Store the full component state so that redirect return can pass `state`
        // alongside `details` to Commerce's setPaymentMethodOnCart. Commerce
        // validates payment method availability using the `state` key; passing
        // both `state` and `details` lets the backend use the details flow
        // (which takes priority) while satisfying Commerce's availability check.
        stateData: state.data,
      });

      // Signal handlePlaceOrder that the pspReference is now stored and available
      // as preOrderPspReference. This unblocks the waitForOnSubmitResult() call
      // in handlePlaceOrder so setPaymentMethod includes preOrderPspReference
      // and process-order-payment can skip the /payments call.
      if (onSubmitResolve) {
        onSubmitResolve();
        onSubmitResolve = null;
      }
      // If handlePlaceOrder (triggered by triggerPlaceOrder on the Place Order button)
      // is managing order placement, resolve with 'Backend' so onPaymentCompleted is
      // a no-op and does not call placeOrder a second time.
      // For Apple Pay / PayPal (no Place Order button), handlePlaceOrderActive is false
      // and the real resultCode is passed so onPaymentCompleted can place the order.
      const resolveResultCode = handlePlaceOrderActive ? 'Backend' : result.resultCode;
      actions.resolve({
        resultCode: resolveResultCode,
        ...(resolveResultCode !== 'Backend' && {
          action: result.action,
          order: result.order,
          donationToken: result.donationToken,
          pspReference: result.pspReference,
          paymentMethod: state.data?.paymentMethod,
        }),
      });
    } catch (error) {
      console.debug('Payment error:', error);
      const errorMessage = error.message || 'Payment failed. Please try again.';
      // Resolve the promise even on failure so handlePlaceOrder is not blocked.
      if (onSubmitResolve) {
        onSubmitResolve();
        onSubmitResolve = null;
      }
      if (component.props?.onError) {
        component.props.onError(error);
      }
      actions.reject(errorMessage);
    } finally {
      // Hide loader after submission completes or fails
      if (paymentMethodsContainer) {
        paymentMethodsContainer.classList.remove('loading');
      }
    }
  };
}

// ============================================================================
// DEFAULT ON ADDITIONAL DETAILS (3DS2 challenge, redirect return)
// ============================================================================

/**
 * Create default onAdditionalDetails handler.
 * @param {string} baseUrl - Backend integration URL
 * @param {Function} getCartData - Function that returns current cart data
 * @param {Function|null} [recoverCartFn=null] - Optional callback to recover the cart after a
 *   payment failure. Called as recoverCartFn(incrementId, email).
 *   If null, cart recovery is skipped.
 * @param {Object} [options={}] - Optional configuration
 * @param {Function} [options.onRecoveryStart] - Called immediately before awaiting cart recovery
 *   and redirecting to /checkout after a 3DS2 payment failure. Use to show a loading spinner.
 * @returns {Function}
 */
export function createDefaultOnAdditionalDetails(
  baseUrl,
  getCartData,
  recoverCartFn = null,
  options = {},
) {
  const { onRecoveryStart, getCheckoutData } = options;
  return async (state, component, actions) => {
    try {
      // Get current data at handler time
      const cartData = getCartData();
      const checkoutData = typeof getCheckoutData === 'function' ? getCheckoutData() : {};
      const res = await adyenFetch(`${baseUrl}payments-details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: cartData?.id,
          details: state.data.details,
          paymentData: state.data.paymentData,
        }),
      }, {
        backendUrl: baseUrl,
        cartId: cartData?.id,
        isGuest: checkoutData?.isGuest || false,
      });

      // Check for HTTP errors
      if (!res.ok) {
        let errorMessage = 'Payment details request failed';
        try {
          const errorData = await res.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch {
          if (res.status === 500) {
            errorMessage = 'Server error occurred. Please try again.';
          } else if (res.status === 404) {
            errorMessage = 'Payment service not found. Please contact support.';
          } else {
            errorMessage = `Payment details request failed with status ${res.status}`;
          }
        }
        console.debug('Payment details HTTP error:', res.status, errorMessage);
        // Tear down modal on HTTP errors (post-order flow).
        const httpErrOverlay = document.querySelector('.adyen-3ds-overlay');
        if (httpErrOverlay?.__teardown && !httpErrOverlay.__onComplete) {
          httpErrOverlay.__teardown();
        }
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      const result = await res.json();

      // COMPREHENSIVE LOGGING: Capture full /payments-details response
      console.debug('[Adyen] FULL /payments-details response from backend:', {
        resultCodeResponse: result.resultCode,
        resultKeys: result ? Object.keys(result) : [],
        pspReferenceResponse: result.pspReference,
        merchantReferenceResponse: result.merchantReference,
        donationTokenResponse: result.donationToken,
        actionResponse: result.action,
        actionKeys: result.action ? Object.keys(result.action) : [],
        resultFull: JSON.parse(JSON.stringify(result)), // Deep clone for logging
      });

      if (!result.resultCode) {
        const errorMessage = 'Invalid payment details response';
        // Tear down modal on invalid response (post-order flow).
        const invalidOverlay = document.querySelector('.adyen-3ds-overlay');
        if (invalidOverlay?.__teardown && !invalidOverlay.__onComplete) {
          invalidOverlay.__teardown();
        }
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        actions.reject(errorMessage);
        return;
      }

      // PRE-AUTH MODE: if the overlay has an __onComplete callback, this is a
      // pre-auth 3DS2 flow (no order placed yet).
      // Only tear down the modal and call the callback on TERMINAL result codes.
      // Intermediate steps (e.g. fingerprint → ChallengeShopper) must let the SDK
      // mount the next action inside the existing modal — don't consume __onComplete yet.
      const TERMINAL_RESULT_CODES = [
        'Authorised',
        'AuthenticationFinished',
        'Refused',
        'Error',
        'Cancelled',
      ];
      const overlay = document.querySelector('.adyen-3ds-overlay');
      if (overlay?.__onComplete) {
        if (TERMINAL_RESULT_CODES.includes(result.resultCode)) {
          // Terminal result — close modal and resolve the Promise in handlePlaceOrder.
          // Pass details + paymentData (the inputs to /payments/details) alongside the
          // result so handlePlaceOrder can update additional_information before placing
          // the order. This lets the Commerce webhook call /payments/details instead of
          // a fresh /payments, which would otherwise re-trigger 3DS2.
          const cb = overlay.__onComplete;
          overlay.__onComplete = null; // consume once
          if (overlay.__teardown) overlay.__teardown();
          // Tell the SDK the action is complete so it does not re-render or re-fire
          // onAdditionalDetails. Without this call the SDK component stays in a live
          // state and can re-insert its DOM nodes, leaving .adyen-3ds-modal visible.
          //
          // Use the 'Backend' sentinel so that createDefaultOnPaymentCompleted (which
          // fires next via the SDK's onPaymentCompleted) exits immediately without
          // treating AuthenticationFinished as a decline. The pre-auth challenge flow
          // is fully handled by handlePlaceOrder in commerce-checkout.js — there is
          // nothing for onPaymentCompleted to do here.
          actions.resolve({ resultCode: 'Backend' });
          cb({
            ...result,
            details: state.data.details,
            paymentData: state.data.paymentData,
          });
          return;
        }
        if (result.action && isNative3DSAction(result.action)) {
          // Intermediate chained step (e.g. ChallengeShopper with a new action)
          // Let the SDK mount the next step inside the existing modal.
          // Keep __onComplete for the terminal call.
          actions.resolve({
            resultCode: result.resultCode,
            action: result.action,
          });
          return;
        }
        // Pre-auth overlay is present, but we got a non-terminal, non-native result.
        // Do NOT fall through to the normal flow (which would emit order/placed and
        // replace the overlay). Reject to surface the unexpected state.
        console.warn(
          '[Adyen][onAdditionalDetails] pre-auth overlay present but unhandled result — rejecting',
          result.resultCode,
        );
        actions.reject(`Unexpected pre-auth result: ${result.resultCode}`);
        return;
      }

      // Check if payment was successful
      if (
        result.resultCode === 'Authorised'
        || result.resultCode === 'Pending'
        || result.resultCode === 'Received'
      ) {
        // Check if the order was already placed (server-side flow)
        const storedPendingOrder = getPendingOrderData();
        if (storedPendingOrder) {
          // SERVER-SIDE FLOW: Order already placed, just emit order/placed.
          // Do NOT include result.action in the payment result: the action has
          // already been handled by createFromAction, and storing it would cause
          // handleOrderPlaced (fired async via BroadcastChannel) to see an action
          // and call mountNative3DSComponent again, recreating the overlay.
          setPaymentResult({
            pspReference: result.pspReference,
            merchantReference: result.merchantReference,
            paymentMethod: result.paymentMethod, // ✅ Use backend response, not state.data
            donationToken: result.donationToken,
            resultCode: result.resultCode,
          });
          // Tear down the overlay synchronously before emitting order/placed.
          // Because the event bus (BroadcastChannel) delivers messages async,
          // the subscribers fire in a future task — but the overlay must be gone
          // immediately so there is no window where the empty shell is visible.
          const pendingOverlay = document.querySelector('.adyen-3ds-overlay');
          if (pendingOverlay?.__teardown) pendingOverlay.__teardown();
          clearPendingOrderData();
          events.emit('order/placed', storedPendingOrder);
          actions.resolve({ resultCode: result.resultCode });
          return;
        }

        // CLIENT-SIDE FLOW: Order NOT placed yet, place it now.
        // Include result.action here — handleOrderPlaced needs it to decide
        // whether to mount a 3DS component for the next step.
        // IMPORTANT: Store state.data (details/paymentData) from Adyen SDK so Commerce has
        // the payment state needed for setPaymentMethod and placeOrder validation.
        setPaymentResult({
          pspReference: result.pspReference,
          merchantReference: result.merchantReference,
          paymentMethod: result.paymentMethod, // ✅ Use backend response, not state.data
          donationToken: result.donationToken,
          action: result.action,
          resultCode: result.resultCode,
          // Store Adyen SDK state for wallet payments — this is what Commerce needs
          details: state.data.details,
          paymentData: state.data.paymentData,
        });
        const paymentResultData = getPaymentResultSync();

        // COMPREHENSIVE LOGGING: Capture all stored payment result data
        console.debug('[Adyen] STORED Payment result data (full):', {
          paymentResultDataKeys: paymentResultData ? Object.keys(paymentResultData) : [],
          paymentResultDataFull: JSON.parse(JSON.stringify(paymentResultData)),
          paymentMethod: paymentResultData?.paymentMethod,
          stateData: paymentResultData?.stateData,
          stateDataPaymentMethod: paymentResultData?.stateData?.paymentMethod,
          action: paymentResultData?.action,
          actionPaymentMethodType: paymentResultData?.action?.paymentMethodType,
        });

        // Extract payment method type from stored data or state data
        let paymentMethodType = paymentResultData?.paymentMethod?.type;
        console.debug('[Adyen] Payment method extraction - attempt 1 (paymentResultData.paymentMethod.type):', {
          result: paymentMethodType,
        });

        if (!paymentMethodType && paymentResultData?.stateData?.paymentMethod?.type) {
          paymentMethodType = paymentResultData.stateData.paymentMethod.type;
          console.debug('[Adyen] Payment method extraction - attempt 2 (stateData.paymentMethod.type):', {
            result: paymentMethodType,
          });
        }

        // For wallet methods (PayPal, Apple Pay, Google Pay), if type is still missing,
        // try to infer from action or component type
        if (!paymentMethodType && paymentResultData?.action?.paymentMethodType) {
          paymentMethodType = paymentResultData.action.paymentMethodType;
          console.debug('[Adyen] Payment method extraction - attempt 3 (action.paymentMethodType):', {
            result: paymentMethodType,
          });
        }

        const paymentMethodCode = paymentMethodType
          ? `adyen_${paymentMethodType}`
          : undefined;
        console.debug('[Adyen] Final payment method for setPaymentMethod call', {
          paymentMethodCode,
          paymentMethodType,
          isUndefined: paymentMethodCode === undefined,
          hasPaymentMethod: !!paymentResultData?.paymentMethod,
          hasStateData: !!paymentResultData?.stateData,
          hasAction: !!paymentResultData?.action,
        });
        // Build additional_data array, filtering out entries with undefined values
        // because GraphQL type validation requires all key-value pairs to have values
        const additionalDataForRequest = [];
        if (paymentResultData?.pspReference) {
          additionalDataForRequest.push({
            key: 'pspReference',
            value: paymentResultData.pspReference,
          });
        }
        if (paymentResultData?.donationToken) {
          additionalDataForRequest.push({
            key: 'donationToken',
            value: paymentResultData.donationToken,
          });
        }
        // For wallet payments (PayPal, Apple Pay, Google Pay) and any payment that has
        // details from Adyen SDK, include those in additional_data so Commerce has the
        // payment state needed for order placement validation.
        if (paymentResultData?.details) {
          additionalDataForRequest.push({
            key: 'details',
            value: JSON.stringify(paymentResultData.details),
          });
        }
        if (paymentResultData?.paymentData) {
          additionalDataForRequest.push({
            key: 'paymentData',
            value: paymentResultData.paymentData,
          });
        }
        console.debug('[Adyen] setPaymentMethod call - additional_data:', {
          keys: additionalDataForRequest.map((d) => d.key),
          hasDetails: !!additionalDataForRequest.find((d) => d.key === 'details'),
          hasPaymentData: !!additionalDataForRequest.find((d) => d.key === 'paymentData'),
          hasPspReference: !!additionalDataForRequest.find((d) => d.key === 'pspReference'),
        });
        await checkoutApi.setPaymentMethod({
          code: paymentMethodCode,
          additional_data: additionalDataForRequest,
        });

        if (!cartData?.id) {
          const errorMessage = 'Cart is no longer available. Please refresh the page and try again.';
          console.error(
            'createDefaultOnAdditionalDetails: cartData is null or missing id',
          );
          if (component.props?.onError) {
            component.props.onError(new Error(errorMessage));
          }
          actions.reject(errorMessage);
          return;
        }

        try {
          const orderData = await placeOrder(cartData.id);
          events.emit('order/placed', orderData);
          actions.resolve({ resultCode: result.resultCode });
        } catch (placeOrderError) {
          console.error(
            'Place order error after additional details:',
            placeOrderError,
          );
          // Try to refund/cancel the payment
          const refundPayload = {
            backendUrl: baseUrl,
            cartId: cartData.id,
            isGuest: checkoutData?.isGuest || false,
          };
          await adyenFetch(`${baseUrl}refund-or-cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cartId: cartData.id,
              pspReference: paymentResultData?.pspReference,
            }),
          }, refundPayload);
          const errorMessage = 'An error occurred while placing your order. Your payment has been refunded.';
          if (component.props?.onError) {
            component.props.onError(new Error(errorMessage));
          }
          actions.reject(errorMessage);
        }
      } else if (result.action && isNative3DSAction(result.action)) {
        // CHAINED 3DS ACTION: payments-details returned another threeDS2 action
        // (e.g., fingerprint step returned a challenge step).
        // Let the SDK process the next step — it will fire onAdditionalDetails again.
        actions.resolve({
          resultCode: result.resultCode,
          action: result.action,
        });
      } else {
        // Payment isn't authorized — close the 3DS modal (post-order flow has no
        // __onComplete; pre-auth flow already returned above at the terminal-code
        // branch, so this else is only reached in the post-order path).
        const refusedOverlay = document.querySelector('.adyen-3ds-overlay');
        if (refusedOverlay?.__teardown && !refusedOverlay.__onComplete) {
          refusedOverlay.__teardown();
        }

        // Read pending order data BEFORE clearing it so we can cancel the order.
        const pendingOrder = getPendingOrderData();

        // Clean up pending order so a retry attempt starts fresh.
        clearPendingOrderData();

        const errorMessage = `Payment not authorised: ${result.resultCode}`;
        console.warn(errorMessage);

        // Cancel the failed order in Magento so inventory is released.
        // Guest orders carry a long token (length > 20); authenticated orders
        // use the GraphQL ID stored in orderData.id.
        let recoveryPromise = Promise.resolve();
        if (pendingOrder) {
          const cancelReason = 'Payment declined by Adyen';
          const isGuest = pendingOrder.token && pendingOrder.token.length > 20;

          if (isGuest) {
            // Best-effort: ask Magento to cancel the order. The Adyen backend webhook
            // (REFUSED/CANCELLATION notification) may also cancel it server-side.
            requestGuestOrderCancel(
              pendingOrder.token,
              cancelReason,
              () => {},
              (_err) => {
                console.warn(
                  'Failed to cancel guest order after 3DS refusal:',
                  _err,
                );
              },
            );
          } else if (pendingOrder.id) {
            // Best-effort: ask Magento to cancel the order. Magento may reject this if
            // the order is still in the pending_payment state — the Adyen backend webhook
            // will cancel it server-side once Adyen sends the REFUSED notification.
            cancelOrder(
              pendingOrder.id,
              cancelReason,
              () => {},
              (_err) => {
                console.warn('Failed to cancel order after 3DS refusal:', _err);
              },
            );
          }

          // Only call the backend recover-cart action for genuine payment failure
          // codes (Refused, Error, Cancelled). Intermediate 3DS2 result codes such
          // as ChallengeShopper, IdentifyShopper, PresentToShopper, or
          // AuthenticationNotRequired are NOT terminal failures and must not trigger
          // cart recovery.
          const FAILURE_RESULT_CODES = ['Refused', 'Error', 'Cancelled'];
          if (
            typeof recoverCartFn === 'function'
            && pendingOrder.number
            && FAILURE_RESULT_CODES.includes(result.resultCode)
          ) {
            // Pass result.resultCode explicitly so the backend can trust the
            // frontend's authoritative result from /payments/details rather than
            // re-querying its own store (which may still show a stale intermediate
            // 3DS2 code like 'IdentifyShopper' before the Adyen webhook arrives).
            recoveryPromise = recoverCartFn(
              pendingOrder.number,
              pendingOrder.email,
              result.resultCode,
              {
                orderToken: pendingOrder.token,
                orderId: pendingOrder.id,
                comment: `Payment declined by Adyen: ${result.resultCode}`,
              },
            ).catch((_err) => {
              console.debug('recoverCart failed after 3DS refusal:', _err);
            });
          }
        }

        // Show the error in the checkout payment section (visible to the user).
        // Do NOT call component.props.onError here: that propagates to the card
        // block's onError, which calls showError on the card container (out of
        // view) and also triggers the SDK to fire onPaymentFailed, producing a
        // duplicate console error and a second showError call.
        const declineMessage = "We're sorry, your payment was declined. Please try again or use a different payment method.";
        showError(document.body, declineMessage);
        actions.reject(errorMessage);
        if (pendingOrder) {
          // Persist the error message so it survives the /checkout page reload.
          // sessionStorage is scoped to the tab and cleared when the tab closes,
          // which is the right lifetime for a transient payment error message.
          try {
            sessionStorage.setItem(STORAGE_KEYS.PAYMENT_ERROR, declineMessage);
            // Persist guest email and name so they can be pre-filled after redirect.
            const checkoutSnapshot = typeof getCheckoutData === 'function' ? getCheckoutData() : null;
            const emailToSave = checkoutSnapshot?.email || pendingOrder.email;
            if (emailToSave) {
              sessionStorage.setItem(STORAGE_KEYS.GUEST_EMAIL, emailToSave);
            }
            const billingAddr = checkoutSnapshot?.billingAddress;
            if (billingAddr?.firstname) {
              sessionStorage.setItem(STORAGE_KEYS.GUEST_FIRSTNAME, billingAddr.firstname);
            }
            if (billingAddr?.lastname) {
              sessionStorage.setItem(STORAGE_KEYS.GUEST_LASTNAME, billingAddr.lastname);
            }
          } catch {
            /* ignore */
          }
          // Show the loader while recovery runs and the page navigates.
          if (typeof onRecoveryStart === 'function') onRecoveryStart();
          // Wait for recovery before navigating, so the restored cart is available
          // on the /checkout page. recoveryPromise always resolves (never throws).
          recoveryPromise.then(() => {
            window.location.href = '/checkout';
          });
        }
      }
    } catch (error) {
      // On unexpected errors also tear down any open 3DS modal.
      const errorOverlay = document.querySelector('.adyen-3ds-overlay');
      if (errorOverlay?.__teardown && !errorOverlay.__onComplete) {
        errorOverlay.__teardown();
      }
      console.error('Additional details error:', error);
      const errorMessage = error.message || 'Payment verification failed. Please try again.';
      if (component.props?.onError) {
        component.props.onError(error);
      }
      actions.reject(errorMessage);
    }
  };
}

// ============================================================================
// DEFAULT ON PAYMENT COMPLETED
// ============================================================================

/**
 * Create default onPaymentCompleted handler.
 * Called when a client-side payment completes without going through onAdditionalDetails.
 *
 * @param {string} baseUrl - Backend integration URL
 * @param {Function} getCartData - Function that returns current cart data
 * @param {Object} [options={}] - Optional configuration
 * @param {Function|null} [options.recoverCartFn=null] - Called as
 *   recoverCartFn(incrementId, email, resultCode) to provision a fresh cart on decline.
 *   Required for wallet payments (Apple Pay) that place the order inside this handler
 *   (i.e. the order increment ID is known only after placeOrder resolves here).
 *   If null, cart recovery is skipped.
 * @param {Function} [options.getCheckoutData] - Returns current checkout data snapshot.
 *   Used to persist guest email/name for pre-filling after failure redirect.
 * @returns {Function}
 */
export function createDefaultOnPaymentCompleted(baseUrl, getCartData, options = {}) {
  const { recoverCartFn = null, getCheckoutData } = options;
  return async (result, component) => {
    if (result.resultCode === 'Backend') {
      return;
    }
    if (
      result.resultCode === 'Authorised'
      || result.resultCode === 'Pending'
      || result.resultCode === 'Received'
    ) {
      // Get current data at handler time
      const cartData = getCartData();

      // CLIENT-SIDE FLOW: Direct authorization without additional action
      // Need to set payment method and place order
      const paymentResultData = getPaymentResultSync();

      // COMPREHENSIVE LOGGING: Capture all stored payment result data in onPaymentCompleted
      console.debug('[Adyen] onPaymentCompleted - STORED Payment result data (full):', {
        paymentResultDataKeys: paymentResultData ? Object.keys(paymentResultData) : [],
        paymentResultDataFull: JSON.parse(JSON.stringify(paymentResultData)),
        paymentMethod: paymentResultData?.paymentMethod,
        stateData: paymentResultData?.stateData,
        stateDataPaymentMethod: paymentResultData?.stateData?.paymentMethod,
      });

      // On wallet payment redirect-return flows (PayPal/ApplePay/GooglePay),
      // cartData may not yet be populated via BroadcastChannel when this
      // handler fires. Fall back to the cartId stored in paymentResultData
      // (written during onSubmit) which survives page reloads via localStorage.
      const cartId = cartData?.id ?? paymentResultData?.cartId;

      if (!cartId) {
        const errorMessage = 'Cart is no longer available. Please refresh the page and try again.';
        console.error(
          'createDefaultOnPaymentCompleted: cartData is null or missing id',
        );
        if (component.props?.onError) {
          component.props.onError(new Error(errorMessage));
        }
        return;
      }

      // Extract payment method type with fallbacks for wallet methods
      let paymentMethodType = paymentResultData?.paymentMethod?.type;
      console.debug('[Adyen] onPaymentCompleted payment method extraction - attempt 1 (paymentMethod.type):', {
        result: paymentMethodType,
      });

      if (!paymentMethodType && paymentResultData?.stateData?.paymentMethod?.type) {
        paymentMethodType = paymentResultData.stateData.paymentMethod.type;
        console.debug('[Adyen] onPaymentCompleted payment method extraction - attempt 2 (stateData.paymentMethod.type):', {
          result: paymentMethodType,
        });
      }

      if (!paymentMethodType && paymentResultData?.stateData?.type) {
        paymentMethodType = paymentResultData.stateData.type;
        console.debug('[Adyen] onPaymentCompleted payment method extraction - attempt 3 (stateData.type):', {
          result: paymentMethodType,
        });
      }

      const paymentMethodCode = paymentMethodType
        ? `adyen_${paymentMethodType}`
        : undefined;
      console.debug('[Adyen] onPaymentCompleted final payment method for setPaymentMethod call', {
        paymentMethodCode,
        paymentMethodType,
        isUndefined: paymentMethodCode === undefined,
      });
      // Build additional_data array, filtering out entries with undefined values
      // because GraphQL type validation requires all key-value pairs to have values
      const additionalData = [];
      if (paymentResultData?.pspReference) {
        additionalData.push({
          key: 'pspReference',
          value: paymentResultData.pspReference,
        });
        // Also set preOrderPspReference so process-order-payment recognizes that the
        // payment was already authorized by the frontend /payments call and skips its
        // own /payments attempt (which would fail with 422 "token already used").
        additionalData.push({
          key: 'preOrderPspReference',
          value: paymentResultData.pspReference,
        });
      }
      if (paymentResultData?.donationToken) {
        additionalData.push({
          key: 'donationToken',
          value: paymentResultData.donationToken,
        });
      }
      // For wallet payments (PayPal, Apple Pay, Google Pay), include the Adyen state
      // so Commerce has the payment details for order placement verification
      if (paymentResultData?.stateData) {
        additionalData.push({
          key: 'state',
          value: JSON.stringify(paymentResultData.stateData),
        });
      }

      if (result.code === 'Received' && result.action) {
        additionalData.push({ key: 'additional_action', value: result.action });
      }

      await checkoutApi.setPaymentMethod({
        code: paymentMethodCode,
        additional_data: additionalData,
      });

      try {
        const orderData = await placeOrder(cartId);
        events.emit('order/placed', orderData);
      } catch (error) {
        console.debug('Payment error:', error);
        const checkoutSnapshot = typeof getCheckoutData === 'function' ? getCheckoutData() : {};
        const refundAuthContext = {
          backendUrl: baseUrl,
          cartId,
          isGuest: checkoutSnapshot?.isGuest || false,
        };
        await adyenFetch(`${baseUrl}refund-or-cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cartId,
            pspReference: paymentResultData?.pspReference,
          }),
        }, refundAuthContext);
        if (component.props?.onError) {
          component.props.onError(
            new Error(
              'An error occurred while placing your order. Your payment has been refunded.',
            ),
          );
        }
      }
    } else {
      // Payment was declined / failed before an order was placed (wallet payments
      // such as Apple Pay where onPaymentCompleted fires directly without
      // onAdditionalDetails). Recover the cart and redirect to /checkout so the
      // customer can retry — mirroring the behaviour of handleOrderPlaced for the
      // post-order decline path.
      console.debug('Payment not authorised:', result.resultCode);

      const paymentResultData = getPaymentResultSync();
      const declineMessage = "We're sorry, your payment was declined. Please try again or use a different payment method.";

      // Cart recovery is best-effort — no order was placed so there is nothing to
      // cancel in Commerce. We still need a fresh cart for the retry.
      const FAILURE_RESULT_CODES = ['Refused', 'Error', 'Cancelled'];
      if (
        typeof recoverCartFn === 'function'
        && FAILURE_RESULT_CODES.includes(result.resultCode)
        && paymentResultData?.cartId
      ) {
        // For pre-order declines we have no incrementId — pass cartId as a
        // reference so the backend can look up the masked cart if needed.
        try {
          await recoverCartFn(paymentResultData.cartId, null, result.resultCode);
        } catch (recoverErr) {
          console.debug('recoverCart failed after onPaymentCompleted decline:', recoverErr);
        }
      }

      try {
        sessionStorage.setItem(STORAGE_KEYS.PAYMENT_ERROR, declineMessage);
        // Persist guest email/name so they can be pre-filled on the retry page.
        const checkoutSnapshot = typeof getCheckoutData === 'function' ? getCheckoutData() : null;
        if (checkoutSnapshot?.email) {
          sessionStorage.setItem(STORAGE_KEYS.GUEST_EMAIL, checkoutSnapshot.email);
        }
        if (checkoutSnapshot?.billingAddress?.firstname) {
          sessionStorage.setItem(
            STORAGE_KEYS.GUEST_FIRSTNAME,
            checkoutSnapshot.billingAddress.firstname,
          );
        }
        if (checkoutSnapshot?.billingAddress?.lastname) {
          sessionStorage.setItem(
            STORAGE_KEYS.GUEST_LASTNAME,
            checkoutSnapshot.billingAddress.lastname,
          );
        }
      } catch {
        /* ignore */
      }

      if (component.props?.onError) {
        component.props.onError(new Error(declineMessage));
      }

      window.location.href = '/checkout';
    }
  };
}
