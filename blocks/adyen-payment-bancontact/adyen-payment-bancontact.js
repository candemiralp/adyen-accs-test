/**
 * Adyen Bancontact Payment Method Block
 */

import { events } from '@dropins/tools/event-bus.js';
import {
  showLoading, hideLoading, showError, clearError,
} from '../adyen-payment/utils.js';
import { getAdyenCheckout, setActiveComponent } from '../adyen-payment/index.js';

// Keep a reference to the component so we can unmount it when checkout data changes
let lastBancontactComponent = null;
let checkoutUpdatedListenerRegistered = false;
let readyPromise = null;
let resolveReady = null;

export default async function decorate(block) {
  const container = document.createElement('div');
  block.appendChild(container);

  try {
    showLoading(block);

    // Get checkout and create a payment method
    const checkout = await getAdyenCheckout();

    // Create promise that resolves when component is ready
    readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });

    const paymentMethod = new window.AdyenWeb.Bancontact(checkout, {
      onPaymentFailed: () => showError(container, 'Payment failed. Please try again.'),
      onError: (error) => showError(container, error.message || 'An error occurred.'),
      onReady: () => resolveReady(),
    });

    lastBancontactComponent = paymentMethod;
    clearError(container);
    paymentMethod.mount(container);
    setActiveComponent(paymentMethod);

    // Register a single checkout/updated listener for the lifetime of the page
    if (!checkoutUpdatedListenerRegistered) {
      const checkoutListener = events.on('checkout/updated', async (data) => {
        if (data.selectedPaymentMethod.code !== 'adyen_bcmc' && lastBancontactComponent) {
          await readyPromise; // Ensure the component is ready before removing

          // Unmount component if another payment method is selected
          try {
            lastBancontactComponent?.remove?.();
          } catch {
            // Ignore unmount errors
          }
          lastBancontactComponent = null;

          checkoutListener.off();
          readyPromise = null;
          resolveReady = null;
        } else {
          lastBancontactComponent?.update?.();
        }
      });
      checkoutUpdatedListenerRegistered = true;
    }
  } catch (error) {
    console.debug('Failed to initialize payment method:', error);
    showError(container, 'Failed to load payment form. Please refresh the page.');
  } finally {
    hideLoading(block);
  }
}
