/**
 * Adyen Google Pay Payment Method Block
 *
 * Google Pay authorizes payments via the checkout-instance-level createDefaultOnSubmit
 * handler which POSTs to the backend /payments endpoint. On success, onPaymentCompleted
 * fires with resultCode: 'Authorised' and places the Commerce order.
 *
 * The component-level onSubmit is intentionally omitted — when absent, the Adyen SDK
 * delegates fully to the checkout instance's onSubmit (createDefaultOnSubmit), which
 * handles the /payments call and resolves with the real resultCode so onPaymentCompleted
 * can place the order.
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

export default async function decorate(block) {
  const container = document.createElement('div');
  block.appendChild(container);

  try {
    showLoading(block);

    // Get checkout and create a payment method
    const checkout = await getAdyenCheckout();
    const paymentMethod = new window.AdyenWeb.GooglePay(checkout, {
      showPayButton: true,
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
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
