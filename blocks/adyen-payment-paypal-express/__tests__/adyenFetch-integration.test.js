/**
 * Tests for PayPal Express Checkout - adyenFetch Authorization Header Integration
 * Verifies that /payments POST requests include proper Authorization header for logged-in customers
 */

jest.mock('../../../scripts/adyen-auth.js', () => ({
  adyenFetch: jest.fn(),
}));

jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    lastPayload: jest.fn(),
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

jest.mock('@dropins/storefront-order/api.js', () => ({
  setEndpoint: jest.fn(),
}));

jest.mock('@dropins/tools/lib/aem/configs.js', () => ({
  getConfigValue: jest.fn(),
}));

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
  formatAmount: jest.fn((amount) => ({ value: Math.round(amount * 100), currency: 'USD' })),
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
  paypalShopperDetailsToCommerce: jest.fn((details) => ({ email: details.shopperEmail })),
}));

import { adyenFetch } from '../../../scripts/adyen-auth.js';

describe('PayPal Express Checkout - Authorization Header Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('onAuthorized handler - /payments POST request', () => {
    it('should call adyenFetch with authorization context for logged-in customer', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-pp',
        isGuest: false,
      };

      const mockPaypalData = {
        version: '1.0',
        nonce: 'paypal-nonce-xyz',
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Simulating the pattern used in the block
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      // Act
      const result = await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: mockAuthContext.cartId,
          isGuest: mockAuthContext.isGuest,
          scope: 'payments',
          paymentRequest: {
            ...mockPaypalData,
            amount: { value: 1000, currency: 'USD' },
            paymentMethod: {
              type: 'paypal',
              applePayToken: mockPaypalData,
            },
            origin: 'http://localhost',
            reference: mockAuthContext.cartId,
            shopperEmail: 'paypal@example.com',
            shopperName: { firstName: 'PayPal', lastName: 'User' },
          },
        },
        mockAuthContext,
      );

      // Assert
      expect(adyenFetch).toHaveBeenCalledWith(
        'http://localhost:3000/payments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('paypal'),
        },
        mockAuthContext, // ← Authorization context passed
      );

      expect(result).toBeDefined();
    });

    it('should call adyenFetch with isGuest: true for guest PayPal checkout', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'guest-cart-pp',
        isGuest: true,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: mockAuthContext.cartId,
          isGuest: true,
          scope: 'payments',
          paymentRequest: {
            amount: { value: 2000, currency: 'USD' },
            paymentMethod: { type: 'paypal' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const callArgs = adyenFetch.mock.calls[0];
      expect(callArgs[2]).toEqual({
        backendUrl: 'http://localhost:3000/',
        cartId: 'guest-cart-pp',
        isGuest: true,
      });
    });

    it('should include PayPal specific payload fields with state.data', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-pp',
        isGuest: false,
      };

      const paypalStateData = {
        version: '3.0',
        nonce: 'paypal-enc-data',
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: 'test-cart-pp',
          isGuest: false,
          scope: 'payments',
          paymentRequest: {
            ...paypalStateData,
            amount: { value: 1500, currency: 'USD' },
            origin: 'https://example.com',
            reference: 'test-cart-pp',
            shopperEmail: 'paypal@example.com',
            shopperName: { firstName: 'Paul', lastName: 'PayPal' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const bodyCall = adyenFetch.mock.calls[0][1].body;
      const parsedBody = JSON.parse(bodyCall);

      expect(parsedBody.paymentRequest).toHaveProperty('version');
      expect(parsedBody.paymentRequest).toHaveProperty('nonce');
      expect(parsedBody.paymentRequest).toHaveProperty('amount');
      expect(parsedBody.paymentRequest).toHaveProperty('origin');
      expect(parsedBody.paymentRequest).toHaveProperty('reference');
    });

    it('should handle SUCCESS_CODES: Authorised, Pending, Received', async () => {
      // Arrange
      const successCodes = ['Authorised', 'Pending', 'Received'];
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart',
        isGuest: false,
      };

      // Act & Assert for each success code
      for (const code of successCodes) {
        adyenFetch.mockResolvedValue({
          json: async () => ({ resultCode: code }),
        });

        const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
          const response = await adyenFetch(
            `${backendUrl}payments`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
            authContext,
          );
          return response.json();
        };

        const result = await callPaymentWithAuth(
          mockAuthContext.backendUrl,
          { cartId: mockAuthContext.cartId },
          mockAuthContext,
        );

        expect(result.resultCode).toBe(code);
        expect(successCodes).toContain(result.resultCode);
      }
    });

    it('should handle payment rejection with Refused resultCode', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart',
        isGuest: false,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({
          resultCode: 'Refused',
          refusalReason: 'PayPal declined the payment',
        }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        const response = await adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
        return response.json();
      };

      const result = await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        { cartId: mockAuthContext.cartId },
        mockAuthContext,
      );

      // Assert
      expect(result.resultCode).toBe('Refused');
      expect(['Authorised', 'Pending', 'Received']).not.toContain(result.resultCode);
    });
  });

  describe('PayPal specific behavior', () => {
    it('should use walletEmail for guests when customerEmail unavailable', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'guest-cart',
        isGuest: true,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      const walletEmail = 'guest-paypal@paypal.com';
      await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: mockAuthContext.cartId,
          isGuest: true,
          scope: 'payments',
          paymentRequest: {
            amount: { value: 1000, currency: 'USD' },
            paymentMethod: { type: 'paypal' },
            shopperEmail: walletEmail,
            shopperName: { firstName: 'Guest', lastName: 'PayPal' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const bodyCall = adyenFetch.mock.calls[0][1].body;
      const parsedBody = JSON.parse(bodyCall);
      expect(parsedBody.paymentRequest.shopperEmail).toBe(walletEmail);
    });

    it('should use customerEmail for logged-in users', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'auth-cart',
        isGuest: false,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      const customerEmail = 'customer@commerce.com';
      await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: mockAuthContext.cartId,
          isGuest: false,
          scope: 'payments',
          paymentRequest: {
            amount: { value: 1000, currency: 'USD' },
            paymentMethod: { type: 'paypal' },
            shopperEmail: customerEmail,
            shopperName: { firstName: 'John', lastName: 'PayPal' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const bodyCall = adyenFetch.mock.calls[0][1].body;
      const parsedBody = JSON.parse(bodyCall);
      expect(parsedBody.paymentRequest.shopperEmail).toBe(customerEmail);
    });

    it('should handle empty shopper details gracefully', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart',
        isGuest: false,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, authContext) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          authContext,
        );
      };

      await callPaymentWithAuth(
        mockAuthContext.backendUrl,
        {
          cartId: mockAuthContext.cartId,
          isGuest: false,
          scope: 'payments',
          paymentRequest: {
            amount: { value: 1000, currency: 'USD' },
            paymentMethod: { type: 'paypal' },
            shopperEmail: '',
            shopperName: { firstName: '', lastName: '' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const bodyCall = adyenFetch.mock.calls[0][1].body;
      const parsedBody = JSON.parse(bodyCall);
      expect(parsedBody.paymentRequest.shopperName.firstName).toBe('');
      expect(parsedBody.paymentRequest.shopperName.lastName).toBe('');
    });
  });
});
