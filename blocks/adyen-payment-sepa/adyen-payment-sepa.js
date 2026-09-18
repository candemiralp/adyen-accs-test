/**
 * Adyen SEPA Direct Debit Payment Method Block
 *
 * Flow:
 * 1. Awaits the shared getAdyenCheckout() singleton.
 * 2. Instantiates window.AdyenWeb.SepaDirectDebit with showPayButton: false.
 * 3. Gates Place Order via onChange — button stays disabled until state.isValid is true.
 * 4. Mounts the component and registers it with setActiveComponent().
 */

import {
  showLoading, hideLoading, showError, clearError,
} from '../adyen-payment/utils.js';
import { getAdyenCheckout, setActiveComponent } from '../adyen-payment/index.js';

/**
 * Resolves the Place Order button in the checkout, if present.
 * @returns {HTMLButtonElement|null}
 */
function getPlaceOrderButton() {
  return document.querySelector('.place-order button, [data-testid="place-order-button"]');
}

/**
 * onChange handler — disables/enables Place Order based on SEPA form validity.
 * Exported to window for Cypress testability.
 * @param {object} state - Adyen component state
 */
function onSepaChange(state) {
  const btn = getPlaceOrderButton();
  if (btn) {
    btn.disabled = !state.isValid;
  }
}

window.__adyenSepaOnChange = onSepaChange;

export default async function decorate(block) {
  const container = document.createElement('div');
  block.appendChild(container);

  // Disable Place Order until IBAN is valid
  const btn = getPlaceOrderButton();
  if (btn) {
    btn.disabled = true;
  }

  try {
    showLoading(block);

    const checkout = await getAdyenCheckout();
    const paymentMethod = new window.AdyenWeb.SepaDirectDebit(checkout, {
      showPayButton: false,
      onChange: onSepaChange,
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
    });

    clearError(container);
    paymentMethod.mount(container);
    setActiveComponent(paymentMethod);
  } catch (error) {
    console.debug('Failed to initialize SEPA Direct Debit payment method:', error);
    showError(container, 'Failed to load payment form. Please refresh the page.');
  } finally {
    hideLoading(block);
  }
}
