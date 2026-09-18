import { initializers } from '@dropins/tools/initializer.js';
import { initialize, setEndpoint } from '@dropins/storefront-checkout/api.js';
import { initializeDropin } from './index.js';
import { CORE_FETCH_GRAPHQL, fetchPlaceholders } from '../commerce.js';

await initializeDropin(async () => {
  // Set Fetch GraphQL (Core)
  setEndpoint(CORE_FETCH_GRAPHQL);

  // Fetch placeholders
  const labels = await fetchPlaceholders('placeholders/checkout.json');
  const langDefinitions = {
    default: {
      ...labels,
    },
  };

  // Initialize checkout
  return initializers.mountImmediately(initialize, {
    langDefinitions,
    models: {
      CartModel: {
        transformer: (data) => ({
          availablePaymentMethods: data?.available_payment_methods,
          selectedPaymentMethod:
            data?.selected_payment_method?.code
              ? data.selected_payment_method
              : data?.available_payment_methods?.[0],
        }),
      },
    },
  });
})();
