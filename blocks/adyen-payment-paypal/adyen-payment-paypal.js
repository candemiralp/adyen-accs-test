/**
 * Adyen PayPal Payment Method Block
 */

import {
  showLoading, hideLoading, showError, clearError,
} from '../adyen-payment/utils.js';
import { getAdyenCheckout, setActiveComponent, validateCheckoutForms } from '../adyen-payment/index.js';

export default async function decorate(block) {
  const container = document.createElement('div');
  container.id = 'paypal-container';
  block.appendChild(container);

  try {
    showLoading(block);

    // Get checkout and create a payment method
    const checkout = await getAdyenCheckout();
    const paymentMethod = new window.AdyenWeb.PayPal(checkout, {
      showPayButton: true,
      // Validate the checkout forms before the PayPal window opens.
      onClick: (data, actions) => (validateCheckoutForms() ? actions.resolve() : actions.reject()),
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
    });

    clearError(container);
    paymentMethod.mount(container);
    setActiveComponent(paymentMethod);
  } catch (error) {
    console.debug('Failed to initialize payment method:', error);
    showError(container, 'Failed to load payment form. Please refresh the page.');
  } finally {
    hideLoading(block);
  }
}
