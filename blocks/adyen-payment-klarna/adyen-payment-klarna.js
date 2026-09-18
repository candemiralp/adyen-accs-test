/**
 * Adyen Klarna Payment Method Block
 */

import { getAdyenCheckout, setActiveComponent } from '../adyen-payment/index.js';
import {
  parseBoolean, showLoading, hideLoading, showError, clearError,
} from '../adyen-payment/utils.js';

export default async function decorate(block) {
  const container = document.createElement('div');
  block.appendChild(container);

  try {
    showLoading(block);

    // Klarna-specific config
    const type = block?.dataset?.type ?? 'klarna_paynow';
    const useKlarnaWidget = parseBoolean(block.dataset.useKlarnaWidget, true);

    // Get checkout and create Klarna components
    const checkout = await getAdyenCheckout();

    container.className = `adyen-klarna-container adyen-klarna-container--${type}`;
    const klarna = new window.AdyenWeb.Klarna(checkout, {
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
      showPayButton: false,
    });
    klarna.mount(container, {
      type,
      useKlarnaWidget,
    });
    setActiveComponent(klarna);

    clearError(container);
  } catch (error) {
    console.debug('Failed to initialize Klarna payment:', error);
    showError(container, 'Failed to load Klarna. Please refresh the page.');
  } finally {
    hideLoading(block);
  }
}
