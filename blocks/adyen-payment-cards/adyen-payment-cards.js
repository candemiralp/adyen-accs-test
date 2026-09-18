/**
 * Adyen Credit Card Payment Method Block
 */
import { events } from '@dropins/tools/event-bus.js';
import { h, render } from '@dropins/tools/preact.js';
import { Picker } from '@dropins/tools/components.js';
import {
  showLoading, hideLoading, showError, clearError, getAdyenCDNLogoUrl,
} from '../adyen-payment/utils.js';
import {
  getAdyenCheckout,
  getAdyenConfiguration,
  isCustomerLoggedIn,
  registerBeforeCheckoutUpdate,
  setActiveComponent,
} from '../adyen-payment/index.js';

// Keep a reference to the active card component so we can unmount it when
// checkout data changes. Only one component is ever mounted at a time.
let activeCardComponent = null;
let checkoutUpdatedListenerRegistered = false;

// Resolves when the active card component's secure fields are ready
let cardReadyPromise = null;

// Tracks if the active component's secure fields have been configured
let cardConfigured = false;

// Unregister function for the beforeCheckoutUpdate callback
let unregisterBeforeUpdate = null;

// Debounce timeout for checkout/updated handler
let checkoutUpdatedDebounceTimer = null;
const CHECKOUT_UPDATED_DEBOUNCE_MS = 100;

const fragment = `
  <div class="adyen-stored-cards-selector" style="display:none"></div>
  <div id="adyen-card-container"></div>
`;

export default async function decorate(block) {
  block.insertAdjacentHTML('beforeend', fragment);

  const selectorWrapper = block.querySelector('.adyen-stored-cards-selector');
  const cardContainer = block.querySelector('#adyen-card-container');

  // Create a ready promise BEFORE anything else so the callback can wait on it
  let resolveCardReady;
  cardReadyPromise = new Promise((resolve) => {
    resolveCardReady = resolve;
  });

  // Register the callback BEFORE calling getAdyenCheckout(). This ensures that
  // any checkout updates triggered during initialization (by events like cart/data
  // or checkout/updated) will wait for the secure fields to be configured.
  unregisterBeforeUpdate = registerBeforeCheckoutUpdate(async () => {
    if (cardReadyPromise) await cardReadyPromise.catch(() => {});
    return true;
  });

  try {
    showLoading(block);

    // Get the shared checkout instance and create card components
    const checkout = await getAdyenCheckout();
    const storedPaymentMethods = checkout.paymentMethodsResponse?.storedPaymentMethods || [];

    // Resolve Adyen environment for CDN logo URLs (falls back to 'test')
    const adyenConfig = await getAdyenConfiguration();
    const adyenEnvironment = adyenConfig?.environment || 'test';

    // Build new card options (shared between initial mount and "Use new card" re-mount)
    const loggedIn = await isCustomerLoggedIn();
    const newCardOptions = {
      showWarnings: true,
      hasHolderName: true,
      holderNameRequired: true,
      enableStoreDetails: loggedIn,
      showPayButton: false,
      onPaymentFailed: () => showError(block, 'Payment failed. Please try again.'),
      onError: (error) => {
        if (cardConfigured) {
          showError(block, error.message || 'An error occurred.');
        } else {
          console.warn('Card component error during configuration:', error);
        }
      },
      onConfigSuccess: () => {
        cardConfigured = true;
      },
      onReady: () => {
        cardConfigured = true;
        resolveCardReady();
      },
    };

    if (storedPaymentMethods.length > 0) {
      // Map Adyen brand codes to local fallback SVG filenames.
      // Note: cartebancaire is intentionally omitted — the CDN logo is the
      // primary source and the 1.1 MB local SVG was removed for performance.
      const localLogoFilename = {
        visa: 'visa',
        mc: 'mastercard',
        mastercard: 'mastercard',
        amex: 'amex',
        maestro: 'maestro',
        discover: 'discover',
        visadankort: 'visadankort',
      };

      const pickerOptions = [
        { value: 'new', text: 'Use new card' },
        ...storedPaymentMethods.map((method) => {
          const brand = method.brand || method.name?.toLowerCase().replace(/\s+/g, '');
          const logoUrl = brand ? getAdyenCDNLogoUrl(brand, adyenEnvironment) : null;
          const fallbackFile = brand ? localLogoFilename[brand] : null;
          const fallbackUrl = fallbackFile
            ? `${window.location.origin}/blocks/adyen-payment-cards/${fallbackFile}.svg`
            : null;
          return {
            value: method.id,
            text: `${method.name} \u2022\u2022\u2022\u2022 ${method.lastFour || '****'}`,
            icon: logoUrl ? h('img', {
              src: logoUrl,
              alt: method.name,
              width: 40,
              height: 26,
              loading: 'lazy',
              onError: fallbackUrl ? (e) => {
                // Fall back to local SVG if the CDN logo fails to load
                e.currentTarget.src = fallbackUrl;
                e.currentTarget.onerror = null;
              } : undefined,
            }) : undefined,
          };
        }),
      ];

      const handlePickerSelect = (event) => {
        const { value } = event.target;
        // eslint-disable-next-line no-use-before-define
        renderPicker(value);
        clearError(cardContainer);

        // Unmount the currently active component before mounting the next one
        if (activeCardComponent) {
          try { activeCardComponent.unmount(); } catch { /* ignore */ }
          activeCardComponent = null;
          cardConfigured = false;
        }

        if (value === 'new') {
          const cards = new window.AdyenWeb.Card(checkout, newCardOptions);
          activeCardComponent = cards;
          cards.mount(cardContainer);
        } else {
          const selectedMethod = storedPaymentMethods.find((m) => m.id === value);
          if (selectedMethod) {
            cardReadyPromise = new Promise((resolve) => {
              resolveCardReady = resolve;
            });

            try {
              const storedCard = new window.AdyenWeb.Card(checkout, {
                ...selectedMethod,
                showPayButton: false,
                onPaymentFailed: () => showError(block, 'Payment failed. Please try again.'),
                onError: (error) => {
                  if (cardConfigured) {
                    showError(block, error.message || 'An error occurred.');
                  } else {
                    console.warn('Stored card component error during configuration:', error);
                  }
                },
                onConfigSuccess: () => {
                  cardConfigured = true;
                },
                onReady: () => {
                  cardConfigured = true;
                  resolveCardReady();
                },
              });
              activeCardComponent = storedCard;
              storedCard.mount(cardContainer);
            } catch (error) {
              console.debug('Failed to mount stored card component:', error);
              showError(cardContainer, 'Failed to load stored card. Please try again.');
            }
          }
        }
      };

      const renderPicker = (value) => render(
        h(Picker, {
          id: 'adyen-stored-cards-select',
          name: 'adyen-stored-cards-select',
          value,
          options: pickerOptions,
          handleSelect: handlePickerSelect,
          variant: 'primary',
        }),
        selectorWrapper,
      );

      renderPicker('new');
      selectorWrapper.style.display = '';
    }

    // Mount the new card component (the default selection)
    const cards = new window.AdyenWeb.Card(checkout, newCardOptions);
    activeCardComponent = cards;
    cards.mount(cardContainer);

    setActiveComponent({
      get isValid() { return activeCardComponent?.isValid ?? false; },
      get data() { return activeCardComponent?.data; },
      showValidation: () => { activeCardComponent?.showValidation(); },
    });

    // Register a single checkout/updated listener for the lifetime of the page.
    if (!checkoutUpdatedListenerRegistered) {
      const checkoutListener = events.on('checkout/updated', (data) => {
        // Debounce to avoid rapid-fire updates during checkout initialization
        if (checkoutUpdatedDebounceTimer) {
          clearTimeout(checkoutUpdatedDebounceTimer);
        }

        checkoutUpdatedDebounceTimer = setTimeout(async () => {
          checkoutUpdatedDebounceTimer = null;

          if (data?.selectedPaymentMethod?.code !== 'adyen_scheme' && activeCardComponent) {
            // Wait for the active component to be ready before attempting removal
            if (cardReadyPromise) await cardReadyPromise.catch(() => {});

            // Unmount the active card component
            try { activeCardComponent?.unmount?.(); } catch { /* ignore */ }
            activeCardComponent = null;
            cardConfigured = false;

            // Unregister the callback that was blocking checkout updates
            if (unregisterBeforeUpdate) {
              unregisterBeforeUpdate();
              unregisterBeforeUpdate = null;
            }

            checkoutListener.off();
            checkoutUpdatedListenerRegistered = false;
            cardReadyPromise = null;
          }
        }, CHECKOUT_UPDATED_DEBOUNCE_MS);
      });
      checkoutUpdatedListenerRegistered = true;
    }

    clearError(block);
  } catch (error) {
    console.debug('[ADYEN-CARD] Failed to initialize card payment method:', error, error.stack);
    showError(block, 'Failed to load payment form. Please refresh the page.');

    // Unregister the callback on failure to prevent blocking future updates
    if (unregisterBeforeUpdate) {
      unregisterBeforeUpdate();
      unregisterBeforeUpdate = null;
    }

    // Resolve the ready promise to prevent any pending updates from hanging
    if (resolveCardReady) resolveCardReady();
  } finally {
    hideLoading(block);
  }
}
