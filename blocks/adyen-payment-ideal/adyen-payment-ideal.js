/**
 * Adyen iDeal Payment Method Block
 */

import {
  showLoading, hideLoading, showError, clearError,
} from '../adyen-payment/utils.js';
import { getAdyenCheckout, setActiveComponent } from '../adyen-payment/index.js';

export default async function decorate(block) {
  const container = document.createElement('div');
  container.className = 'adyen-ideal-container';
  block.appendChild(container);

  try {
    showLoading(block);

    // Get checkout and create card
    const checkout = await getAdyenCheckout();
    const card = new window.AdyenWeb.Redirect(checkout, {
      type: 'ideal',
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
      showPayButton: false,
    });

    clearError(container);
    card.mount(container);
    setActiveComponent(card);
  } catch (error) {
    console.debug('Failed to initialize iDeal payment:', error);
    showError(container, 'Failed to load payment form. Please refresh the page.');
  } finally {
    hideLoading(block);
  }
}
