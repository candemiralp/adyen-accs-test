/**
 * Adyen ACH Direct Debit Payment Method Block
 *
 * Mandate gate: the Place Order button is disabled until the shopper completes
 * the ACH form. The Adyen Web SDK fires `onChange` with `state.isValid = true`
 * once all required fields are filled, at which point the button is enabled.
 */

import {
  showLoading,
  hideLoading,
  showError,
  clearError,
} from '../adyen-payment/utils.js';
import {
  getAdyenCheckout,
  setActiveComponent,
} from '../adyen-payment/index.js';

/** @param {boolean} enabled */
function setPlaceOrderEnabled(enabled) {
  const btn = document.querySelector('.checkout__place-order button');
  if (btn) {
    btn.disabled = !enabled;
  }
}

/**
 * Called by the Adyen Web SDK whenever the ACH form state changes.
 * Exported to `window.__adyenAchOnChange` for Cypress testability.
 *
 * @param {{ isValid: boolean }} state
 */
function onAchChange(state) {
  setPlaceOrderEnabled(state.isValid === true);
}

// Expose for Cypress tests (no-op in production).
if (typeof window !== 'undefined') {
  window.__adyenAchOnChange = onAchChange;
}

export default async function decorate(block) {
  const container = document.createElement('div');
  block.appendChild(container);

  // Disable Place Order until the mandate is acknowledged via a valid form.
  setPlaceOrderEnabled(false);

  try {
    showLoading(block);

    // Get checkout and create a payment method
    const checkout = await getAdyenCheckout();
    const paymentMethod = new window.AdyenWeb.Ach(checkout, {
      onChange: onAchChange,
      onPaymentFailed: () => {
        setPlaceOrderEnabled(false);
        showError(container, 'Payment failed. Please try again.');
      },
      onError: () => {
        setPlaceOrderEnabled(false);
        showError(container, 'An error occurred. Please try again.');
      },
    });

    clearError(container);
    paymentMethod.mount(container);
    setActiveComponent(paymentMethod);
  } catch (error) {
    console.debug('Failed to initialize payment method:', error);
    showError(
      container,
      'Failed to load payment form. Please refresh the page.',
    );
  } finally {
    hideLoading(block);
  }
}
