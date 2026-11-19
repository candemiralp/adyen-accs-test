/**
 * Tests that the Google Pay express block is not hidden by browser. Google Pay runs in Safari and
 * Firefox too; initExpressCheckout hides the block when isAvailable() rejects.
 */

import { resolveCart } from '../../adyen-payment-express/index.js';
import decorate from '../adyen-payment-googlepay-express.js';

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

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0';

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each([['Safari', SAFARI_UA], ['Firefox', FIREFOX_UA]])('Google Pay express block in %s', (_, ua) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  });

  it('starts express checkout instead of hiding the block', async () => {
    // An empty cart on the cart page ends initialisation early;
    // reaching resolveCart() is the point.
    resolveCart.mockResolvedValue({ cartId: 'cart-1', isGuest: true, isEmpty: true });
    const block = document.createElement('div');

    await decorate(block);

    expect(resolveCart).toHaveBeenCalled();
  });
});
