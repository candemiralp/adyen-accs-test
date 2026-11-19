/**
 * Tests that the Apple Pay express block is not hidden by browser. Adyen Web loads Apple's SDK,
 * which also runs outside Safari; initExpressCheckout hides the block when isAvailable() rejects.
 */

import { resolveCart } from '../../adyen-payment-express/index.js';
import decorate from '../adyen-payment-applepay-express.js';

jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));
jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    on: jest.fn(), once: jest.fn(), off: jest.fn(), emit: jest.fn(), lastPayload: jest.fn(),
  },
}));
jest.mock('@dropins/storefront-checkout/api.js', () => ({
  getStoreConfigCache: jest.fn(() => ({ magentoId: 'test-store' })),
  setEndpoint: jest.fn(),
}));
jest.mock('@dropins/storefront-cart/api.js', () => ({
  getCartDataFromCache: jest.fn(),
  setEndpoint: jest.fn(),
}));
jest.mock('@dropins/storefront-order/api.js', () => ({ setEndpoint: jest.fn() }));
jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../../../scripts/commerce.js', () => ({
  CORE_FETCH_GRAPHQL: jest.fn(),
  CS_FETCH_GRAPHQL: jest.fn(),
  waitForAuthState: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../../adyen-payment/config.js', () => ({
  fetchPublicConfiguration: jest.fn(),
  fetchPaymentMethods: jest.fn(),
  buildStaticConfig: jest.fn(),
  resolveBackendUrl: jest.fn(() => 'http://localhost:3000/'),
  waitForCartInitialized: jest.fn(),
}));
jest.mock('../../adyen-payment/utils.js', () => ({
  loadAdyenWebSDK: jest.fn(),
  getAdyenCheckoutFactory: jest.fn(),
  formatAmount: jest.fn(),
}));
jest.mock('../../adyen-payment-express/index.js', () => ({
  showExpressLoading: jest.fn(),
  hideExpressLoading: jest.fn(),
  showExpressError: jest.fn(),
  resolveCart: jest.fn(),
  addToCart: jest.fn(),
  estimateShipping: jest.fn(),
  setShippingMethod: jest.fn(),
  placeOrderWithPayment: jest.fn(),
  redirectToConfirmation: jest.fn(),
  getLoggedInCustomerEmail: jest.fn(),
}));

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.navigator, 'userAgent', { value: CHROME_UA, configurable: true });
});

describe('Apple Pay express block in Chrome', () => {
  it('starts express checkout instead of hiding the block', async () => {
    // An empty cart on the cart page ends initialisation early; reaching resolveCart() is the point.
    resolveCart.mockResolvedValue({ cartId: 'cart-1', isGuest: true, isEmpty: true });
    const block = document.createElement('div');

    await decorate(block);

    expect(resolveCart).toHaveBeenCalled();
  });
});
