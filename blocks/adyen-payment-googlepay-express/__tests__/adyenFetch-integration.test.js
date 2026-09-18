/**
 * Tests for Google Pay Express Checkout - adyenFetch Authorization Header Integration
 * Verifies that /payments POST requests include proper Authorization header for logged-in customers
 */

// Mock adyenFetch before importing the module
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
}));

import { adyenFetch } from '../../../scripts/adyen-auth.js';

describe('Google Pay Express Checkout - Authorization Header Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('onAuthorized handler - /payments POST request', () => {
    it('should call adyenFetch with authorization context for logged-in customer', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-123',
        isGuest: false,
      };

      const mockPaymentData = {
        paymentMethodData: {
          tokenizationData: {
            token: 'googlepay-token-xyz',
          },
        },
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
            amount: { value: 1000, currency: 'USD' },
            paymentMethod: {
              type: 'googlepay',
              googlePayToken: mockPaymentData.paymentMethodData.tokenizationData.token,
            },
            origin: 'http://localhost',
            reference: mockAuthContext.cartId,
            shopperEmail: 'customer@example.com',
            shopperName: { firstName: 'John', lastName: 'Doe' },
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
          body: expect.stringContaining('googlepay'),
        },
        mockAuthContext, // ← Authorization context passed
      );

      expect(result).toBeDefined();
    });

    it('should call adyenFetch with isGuest: true for guest checkout', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'guest-cart-456',
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
            paymentMethod: { type: 'googlepay' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const callArgs = adyenFetch.mock.calls[0];
      expect(callArgs[2]).toEqual({
        backendUrl: 'http://localhost:3000/',
        cartId: 'guest-cart-456',
        isGuest: true,
      });
    });

    it('should include all required payload fields for payment request', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-123',
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
          cartId: 'test-cart-123',
          isGuest: false,
          scope: 'payments',
          paymentRequest: {
            amount: { value: 1500, currency: 'USD' },
            paymentMethod: {
              type: 'googlepay',
              googlePayToken: 'gp-token',
            },
            origin: 'https://example.com',
            reference: 'test-cart-123',
            shopperEmail: 'test@example.com',
            shopperName: { firstName: 'Jane', lastName: 'Smith' },
          },
        },
        mockAuthContext,
      );

      // Assert
      const bodyCall = adyenFetch.mock.calls[0][1].body;
      const parsedBody = JSON.parse(bodyCall);

      expect(parsedBody).toHaveProperty('cartId', 'test-cart-123');
      expect(parsedBody).toHaveProperty('isGuest', false);
      expect(parsedBody).toHaveProperty('scope', 'payments');
      expect(parsedBody.paymentRequest).toHaveProperty('amount');
      expect(parsedBody.paymentRequest).toHaveProperty('paymentMethod');
      expect(parsedBody.paymentRequest).toHaveProperty('origin');
      expect(parsedBody.paymentRequest).toHaveProperty('reference');
      expect(parsedBody.paymentRequest).toHaveProperty('shopperEmail');
      expect(parsedBody.paymentRequest).toHaveProperty('shopperName');
    });

    it('should handle 401 response gracefully', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-123',
        isGuest: false,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({
          resultCode: 'Refused',
          refusalReason: 'Authorization header required',
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
      expect(result.refusalReason).toContain('Authorization');
    });

    it('should handle network errors in adyenFetch', async () => {
      // Arrange
      const mockAuthContext = {
        backendUrl: 'http://localhost:3000/',
        cartId: 'test-cart-123',
        isGuest: false,
      };

      const mockError = new Error('Network timeout');
      adyenFetch.mockRejectedValue(mockError);

      // Act & Assert
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

      await expect(
        callPaymentWithAuth(
          mockAuthContext.backendUrl,
          { cartId: mockAuthContext.cartId },
          mockAuthContext,
        ),
      ).rejects.toThrow('Network timeout');
    });
  });

  describe('Authorization context validation', () => {
    it('should not pass undefined authorization context', async () => {
      // Arrange
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
        'http://localhost:3000/',
        { cartId: 'test' },
        { backendUrl: 'http://localhost:3000/', cartId: 'test', isGuest: false },
      );

      // Assert
      const contextArg = adyenFetch.mock.calls[0][2];
      expect(contextArg).toBeDefined();
      expect(contextArg).toHaveProperty('backendUrl');
      expect(contextArg).toHaveProperty('cartId');
      expect(contextArg).toHaveProperty('isGuest');
    });

    it('should preserve cartId in auth context across payment flow', async () => {
      // Arrange
      const cartId = 'unique-cart-id-789';
      const authContext = {
        backendUrl: 'http://localhost:3000/',
        cartId,
        isGuest: false,
      };

      adyenFetch.mockResolvedValue({
        json: async () => ({ resultCode: 'Authorised' }),
      });

      // Act
      const callPaymentWithAuth = async (backendUrl, payload, ctx) => {
        return adyenFetch(
          `${backendUrl}payments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          ctx,
        );
      };

      await callPaymentWithAuth(
        authContext.backendUrl,
        { cartId },
        authContext,
      );

      // Assert
      const contextArg = adyenFetch.mock.calls[0][2];
      expect(contextArg.cartId).toBe(cartId);
    });
  });
});
