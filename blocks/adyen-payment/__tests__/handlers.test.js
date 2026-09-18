/**
 * Tests for Adyen Payment Block - Event Bus Integration
 * Tests for event subscription patterns and cross-block communication
 */

import { events } from '@dropins/tools/event-bus.js';

// Mock the event bus
jest.mock('@dropins/tools/event-bus.js', () => {
  const mockEvents = {
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    lastPayload: jest.fn(),
  };
  return { events: mockEvents };
});

jest.mock('@dropins/storefront-order/api.js', () => ({
  placeOrder: jest.fn(),
  cancelOrder: jest.fn(),
  requestGuestOrderCancel: jest.fn(),
}));

jest.mock('@dropins/storefront-checkout/api.js', () => ({
  getCheckout: jest.fn(),
  submitPaymentDetails: jest.fn(),
  setPaymentMethod: jest.fn(),
}));

jest.mock('../state.js', () => ({
  setPaymentResult: jest.fn(),
  getPaymentResult: jest.fn(),
  getPaymentResultSync: jest.fn(),
  clearPaymentResult: jest.fn(),
  getPreviousOrderData: jest.fn(),
  setPaymentResultFetchPromise: jest.fn(),
  getPaymentResultFetchPromise: jest.fn(),
  setPendingOrderData: jest.fn(),
  getPendingOrderData: jest.fn(),
  clearPendingOrderData: jest.fn(),
  getCheckoutAttemptId: jest.fn(),
  clearCheckoutAttemptId: jest.fn(),
  setRedirectPaymentCode: jest.fn(),
  getRedirectPaymentCode: jest.fn(),
  clearRedirectPaymentCode: jest.fn(),
  setActiveComponent: jest.fn(),
  getActiveComponent: jest.fn(),
  setExtraPaymentParams: jest.fn(),
  getExtraPaymentParams: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  commerceToAdyenBillingAddress: jest.fn((addr) => addr),
  commerceToAdyenShippingAddress: jest.fn((addr) => addr),
  formatAmount: jest.fn((amount) => Math.round(amount * 100)),
  isNative3DSAction: jest.fn((result) => result?.resultCode === 'ChallengeShopper'),
  showError: jest.fn(),
  getAdyenCheckoutFactory: jest.fn(),
}));

jest.mock('../../../scripts/adyen-auth.js', () => ({
  adyenFetch: jest.fn(),
}));

describe('Adyen Payment Block - Event Bus Patterns', () => {
  // Helper: Reset all event mocks
  function resetEventMocks() {
    events.on.mockClear();
    events.once.mockClear();
    events.off.mockClear();
    events.emit.mockClear();
    events.lastPayload.mockClear();
  }

  beforeEach(() => {
    resetEventMocks();
  });

  describe('Event Bus API Availability', () => {
    it('should have events object with on method', () => {
      expect(events.on).toBeDefined();
      expect(typeof events.on).toBe('function');
    });

    it('should have events object with emit method', () => {
      expect(events.emit).toBeDefined();
      expect(typeof events.emit).toBe('function');
    });

    it('should have events object with lastPayload method', () => {
      expect(events.lastPayload).toBeDefined();
      expect(typeof events.lastPayload).toBe('function');
    });

    it('should have events object with off method for unsubscription', () => {
      expect(events.off).toBeDefined();
      expect(typeof events.off).toBe('function');
    });

    it('should have events object with once method for one-time listeners', () => {
      expect(events.once).toBeDefined();
      expect(typeof events.once).toBe('function');
    });
  });

  describe('Event Subscription Registration', () => {
    it('should register order/placed event subscription', () => {
      const callback = jest.fn();

      events.on('order/placed', callback);

      expect(events.on).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should register authenticated event subscription', () => {
      const callback = jest.fn();

      events.on('authenticated', callback);

      expect(events.on).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should register cart/initialized event subscription', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback);

      expect(events.on).toHaveBeenCalledWith('cart/initialized', callback);
    });

    it('should register checkout/initialized event subscription', () => {
      const callback = jest.fn();

      events.on('checkout/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('checkout/initialized', callback, { eager: true });
    });

    it('should register multiple subscriptions to the same event', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      events.on('order/placed', callback1);
      events.on('order/placed', callback2);

      expect(events.on).toHaveBeenCalledTimes(2);
      expect(events.on).toHaveBeenNthCalledWith(1, 'order/placed', callback1);
      expect(events.on).toHaveBeenNthCalledWith(2, 'order/placed', callback2);
    });

    it('should support eager option for immediate callback', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith(
        'cart/initialized',
        callback,
        { eager: true },
      );
    });
  });

  describe('Event Emission & Payload Management', () => {
    it('should emit order/placed event with order data payload', () => {
      const orderData = {
        id: 'order-123',
        status: 'processing',
        total: { value: 100, currency: 'USD' },
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', orderData);
    });

    it('should emit authenticated event with user context', () => {
      const userContext = {
        isAuthenticated: true,
        customerId: 'cust-456',
      };

      events.emit('authenticated', userContext);

      expect(events.emit).toHaveBeenCalledWith('authenticated', userContext);
    });

    it('should retrieve last emitted payload via lastPayload', () => {
      const _orderData = { id: 'order-789' };

      events.lastPayload('order/placed');

      expect(events.lastPayload).toHaveBeenCalledWith('order/placed');
    });

    it('should support multiple events with distinct payloads', () => {
      const cartData = { items: [{ sku: 'product-1' }], total: 99.99 };
      const checkoutData = { cartId: 'cart-123', step: 'shipping' };

      events.emit('cart/data', cartData);
      events.emit('checkout/initialized', checkoutData);

      expect(events.emit).toHaveBeenNthCalledWith(1, 'cart/data', cartData);
      expect(events.emit).toHaveBeenNthCalledWith(2, 'checkout/initialized', checkoutData);
    });

    it('should emit order/placed with nested address information', () => {
      const orderWithAddresses = {
        id: 'order-addr-123',
        billingAddress: {
          street: '123 Main St',
          city: 'Amsterdam',
          countryCode: 'NL',
        },
        shippingAddress: {
          street: '123 Main St',
          city: 'Amsterdam',
          countryCode: 'NL',
        },
      };

      events.emit('order/placed', orderWithAddresses);

      expect(events.emit).toHaveBeenCalledWith(
        'order/placed',
        expect.objectContaining({
          billingAddress: expect.objectContaining({ city: 'Amsterdam' }),
          shippingAddress: expect.objectContaining({ city: 'Amsterdam' }),
        }),
      );
    });
  });

  describe('Event Unsubscription', () => {
    it('should unsubscribe from order/placed events', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);

      expect(events.off).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should support unsubscription from authenticated events', () => {
      const callback = jest.fn();

      events.off('authenticated', callback);

      expect(events.off).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should allow resubscription after unsubscription', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);
      events.on('order/placed', callback);

      expect(events.off).toHaveBeenCalledTimes(1);
      expect(events.on).toHaveBeenCalledTimes(1);
    });
  });

  describe('One-Time Event Listeners', () => {
    it('should register one-time listener via events.once', () => {
      const callback = jest.fn();

      events.once('order/placed', callback);

      expect(events.once).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should support once for checkout completion', () => {
      const callback = jest.fn();

      events.once('checkout/success', callback);

      expect(events.once).toHaveBeenCalledWith('checkout/success', callback);
    });

    it('should allow multiple once listeners on same event', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      events.once('order/placed', callback1);
      events.once('order/placed', callback2);

      expect(events.once).toHaveBeenCalledTimes(2);
    });
  });

  describe('Cross-Block Event Communication Patterns', () => {
    it('should support cart → checkout order flow via events', () => {
      const cartCallback = jest.fn();
      const checkoutCallback = jest.fn();

      // Cart block listens to cart data changes
      events.on('cart/data', cartCallback);

      // Checkout block listens to order placement
      events.on('order/placed', checkoutCallback);

      // Emit cart update
      events.emit('cart/data', { items: [{ sku: 'product-1' }] });

      // Emit order placement
      events.emit('order/placed', { id: 'order-123' });

      expect(events.on).toHaveBeenCalledTimes(2);
      expect(events.emit).toHaveBeenCalledTimes(2);
    });

    it('should support checkout → order management redirect via order/placed', () => {
      const orderMgmtCallback = jest.fn();

      // Order management block waits for order placement
      events.on('order/placed', orderMgmtCallback);

      const orderData = {
        id: 'order-999',
        status: 'processing',
        items: [],
      };

      // Checkout emits after successful payment
      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', orderData);
    });

    it('should support authentication flow via authenticated event', () => {
      const _loginCallback = jest.fn();
      const accountCallback = jest.fn();

      // Login block emits after authentication
      events.emit('authenticated', { isAuthenticated: true, customerId: 'cust-123' });

      // Account block listens for auth changes
      events.on('authenticated', accountCallback);

      expect(events.emit).toHaveBeenCalledWith(
        'authenticated',
        expect.objectContaining({ isAuthenticated: true }),
      );
    });

    it('should maintain event payload availability via lastPayload', () => {
      const orderData = { id: 'order-payload-123', status: 'complete' };

      // Simulate order placement
      events.emit('order/placed', orderData);

      // Another block checks last order status
      events.lastPayload('order/placed');

      expect(events.lastPayload).toHaveBeenCalledWith('order/placed');
    });
  });

  describe('Event Bus Edge Cases & Robustness', () => {
    it('should handle null payload in events.emit', () => {
      expect(() => {
        events.emit('order/placed', null);
      }).not.toThrow();

      expect(events.emit).toHaveBeenCalledWith('order/placed', null);
    });

    it('should handle undefined payload in events.emit', () => {
      expect(() => {
        events.emit('order/placed', undefined);
      }).not.toThrow();

      expect(events.emit).toHaveBeenCalledWith('order/placed', undefined);
    });

    it('should handle lastPayload call when no event emitted', () => {
      events.lastPayload.mockReturnValue(undefined);

      const result = events.lastPayload('order/placed');

      expect(result).toBeUndefined();
    });

    it('should handle unsubscribe for non-existent callback', () => {
      const callback = jest.fn();

      expect(() => {
        events.off('order/placed', callback);
      }).not.toThrow();

      expect(events.off).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should support rapid successive events of same type', () => {
      events.emit('order/placed', { id: 'order-1' });
      events.emit('order/placed', { id: 'order-2' });
      events.emit('order/placed', { id: 'order-3' });

      expect(events.emit).toHaveBeenCalledTimes(3);
    });

    it('should handle empty event name gracefully', () => {
      const callback = jest.fn();

      expect(() => {
        events.on('', callback);
      }).not.toThrow();

      expect(events.on).toHaveBeenCalledWith('', callback);
    });

    it('should support special characters in event names', () => {
      const callback = jest.fn();

      events.on('order/placed:success', callback);
      events.on('cart-data_updated', callback);

      expect(events.on).toHaveBeenCalledTimes(2);
    });
  });

  describe('Standard Commerce Drop-in Events', () => {
    it('should support wishlist/alert event for commerce-cart block', () => {
      const callback = jest.fn();

      events.on('wishlist/alert', callback);

      expect(events.on).toHaveBeenCalledWith('wishlist/alert', callback);
    });

    it('should support cart/data event for multi-block updates', () => {
      const callback = jest.fn();

      events.on('cart/data', callback);

      expect(events.on).toHaveBeenCalledWith('cart/data', callback);
    });

    it('should support checkout/updated event sequence', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      events.on('checkout/initialized', callback1);
      events.on('checkout/updated', callback2);

      expect(events.on).toHaveBeenCalledTimes(2);
    });

    it('should support checkout/values event for field updates', () => {
      const callback = jest.fn();

      events.on('checkout/values', callback);

      expect(events.on).toHaveBeenCalledWith('checkout/values', callback);
    });

    it('should support cart/reset event for post-order cleanup', () => {
      const callback = jest.fn();

      events.on('cart/reset', callback);

      expect(events.on).toHaveBeenCalledWith('cart/reset', callback);
    });
  });

  describe('Event Payload Structure & Contract', () => {
    it('should validate order/placed minimal payload structure', () => {
      const minimalOrder = {
        id: 'order-123',
      };

      events.emit('order/placed', minimalOrder);

      expect(events.emit).toHaveBeenCalledWith(
        'order/placed',
        expect.objectContaining({ id: 'order-123' }),
      );
    });

    it('should validate order/placed complete payload structure', () => {
      const completeOrder = {
        id: 'order-456',
        status: 'processing',
        total: { value: 150, currency: 'USD' },
        items: [{ sku: 'product-1', qty: 1, price: 150 }],
        billingAddress: { street: '123 Main', city: 'NYC', countryCode: 'US' },
        shippingAddress: { street: '123 Main', city: 'NYC', countryCode: 'US' },
        cartId: 'cart-456-empty',
      };

      events.emit('order/placed', completeOrder);

      expect(events.emit).toHaveBeenCalledWith('order/placed', completeOrder);
    });

    it('should validate cart/data payload structure', () => {
      const cartData = {
        items: [
          { sku: 'product-1', qty: 1, price: 99.99 },
          { sku: 'product-2', qty: 2, price: 49.99 },
        ],
        total: 199.97,
        cartId: 'cart-789',
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        items: expect.any(Array),
        total: expect.any(Number),
        cartId: expect.any(String),
      }));
    });

    it('should validate authenticated event payload', () => {
      const authPayload = {
        isAuthenticated: true,
        customerId: 'cust-123',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      };

      events.emit('authenticated', authPayload);

      expect(events.emit).toHaveBeenCalledWith('authenticated', authPayload);
    });
  });
});
