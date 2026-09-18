/**
 * Adyen Apple Pay Payment Method Block
 *
 * Apple Pay requires domainNames to be registered on the Adyen merchant account.
 * The domain is extracted from the current page origin and passed to the payment method.
 *
 * Apple Pay is only available on Safari. On other browsers (Chrome, Firefox, Edge),
 * the block is hidden to avoid confusion.
 */

import {
  showLoading,
  hideLoading,
  showError,
  clearError,
} from '../adyen-payment/utils.js';
import {
  getAdyenCheckout,
  getAdyenConfiguration,
  setActiveComponent,
} from '../adyen-payment/index.js';

/**
 * Detects if the current browser is Safari
 * @returns {boolean} true if running on Safari
 */
function isSafari() {
  const ua = window.navigator.userAgent;
  // eslint-disable-next-line no-console
  console.log('[Apple Pay] Browser UA:', ua);
  // Safari user agent contains "Safari" but not "Chrome", "Firefox", "Edge"
  const result = /Safari/.test(ua) && !/Chrome|Firefox|Edge|OPR/.test(ua);
  // eslint-disable-next-line no-console
  console.log('[Apple Pay] isSafari() result:', result);
  return result;
}

export default async function decorate(block) {
  // eslint-disable-next-line no-console
  console.log('[Apple Pay] Block decorator starting...');

  // Hide on non-Safari browsers (Chrome, Firefox, Edge, etc.)
  if (!isSafari()) {
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Not running on Safari, hiding block');
    block.style.display = 'none';
    return;
  }

  // eslint-disable-next-line no-console
  console.log('[Apple Pay] Safari detected, proceeding with Apple Pay initialization');

  const container = document.createElement('div');
  container.id = 'applepay-container';
  block.appendChild(container);

  try {
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Showing loading state');
    showLoading(block);

    // Get checkout and create a payment method
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Fetching Adyen checkout instance');
    const checkout = await getAdyenCheckout();
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Checkout instance retrieved:', !!checkout);

    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Fetching Adyen configuration');
    const configuration = await getAdyenConfiguration();
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Configuration retrieved:', !!configuration);

    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Looking for Apple Pay payment method in response');
    const paymentMethodDefinition = configuration.paymentMethodsResponse.paymentMethods.find((pm) => pm.type === 'applepay');
    if (!paymentMethodDefinition) {
      throw new Error('Apple Pay payment method is not available.');
    }
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Payment method definition found');

    // Extract domain from current page origin for Apple Pay domain validation
    const domain = new URL(window.location.href).hostname;
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Domain extracted:', domain);

    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Creating ApplePay payment method instance');
    const paymentMethod = new window.AdyenWeb.ApplePay(checkout, {
      configuration: paymentMethodDefinition.configuration,
      domainNames: [domain],
      onPaymentFailed: () => {
        // eslint-disable-next-line no-console
        console.log('[Apple Pay] Payment failed callback triggered');
        showError(container, 'Payment failed. Please try again.');
      },
      onError: (error) => {
        // eslint-disable-next-line no-console
        console.log('[Apple Pay] Error callback triggered:', error);
        showError(container, error.message || 'An error occurred.');
      },
    });
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Payment method instance created');

    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Checking if Apple Pay is available...');
    paymentMethod.isAvailable().then(() => {
      // eslint-disable-next-line no-console
      console.log('[Apple Pay] isAvailable() returned successfully - Apple Pay is available');
      // eslint-disable-next-line no-console
      console.log('[Apple Pay] Mounting payment method to container');
      paymentMethod.mount(container);
      // eslint-disable-next-line no-console
      console.log('[Apple Pay] Payment method mounted');
      setActiveComponent(paymentMethod);
      // eslint-disable-next-line no-console
      console.log('[Apple Pay] Active component set');
    }).catch((error) => {
      // Apple Pay is not available
      // eslint-disable-next-line no-console
      console.log('[Apple Pay] isAvailable() rejected - Apple Pay not available:', error);
      showError(container, 'Failed to load payment form. Please refresh the page.');
    });

    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Clearing any existing errors');
    clearError(container);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Apple Pay] Exception during initialization:', error);
    showError(container, 'Failed to load payment form. Please refresh the page.');
  } finally {
    // eslint-disable-next-line no-console
    console.log('[Apple Pay] Hiding loading state');
    hideLoading(block);
  }
}
