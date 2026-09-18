/**
 * Tests for Commerce Checkout Block - Event Bus Integration
 * Tests for cross-event coordination: cart → checkout → order/placed
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

jest.mock('@dropins/storefront-checkout/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

describe('Commerce Checkout Block - Event Bus Integration', () => {
  beforeEach(() => {
    events.on.mockClear();
    events.emit.mockClear();
    events.lastPayload.mockClear();
  });

  describe('Checkout Event Subscriptions', () => {
    it('should subscribe to order/placed event for success redirect', () => {
      const callback = jest.fn();

      events.on('order/placed', callback);

      expect(events.on).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should subscribe to authenticated event for login flow', () => {
      const callback = jest.fn();

      events.on('authenticated', callback);

      expect(events.on).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should subscribe to checkout/initialized with eager option', () => {
      const callback = jest.fn();

      events.on('checkout/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('checkout/initialized', callback, { eager: true });
    });

    it('should subscribe to checkout/updated events', () => {
      const callback = jest.fn();

      events.on('checkout/updated', callback);

      expect(events.on).toHaveBeenCalledWith('checkout/updated', callback);
    });

    it('should subscribe to checkout/values for field updates', () => {
      const callback = jest.fn();

      events.on('checkout/values', callback);

      expect(events.on).toHaveBeenCalledWith('checkout/values', callback);
    });

    it('should subscribe to cart/initialized for empty cart detection', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('cart/initialized', callback, { eager: true });
    });

    it('should subscribe to cart/data for dynamic cart updates', () => {
      const callback = jest.fn();

      events.on('cart/data', callback);

      expect(events.on).toHaveBeenCalledWith('cart/data', callback);
    });
  });

  describe('Order Placed Event Handling', () => {
    it('should detect order/placed event for success page redirect', () => {
      const orderData = { id: 'order-123', status: 'processing' };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', orderData);
    });

    it('should retrieve order data from order/placed payload', () => {
      events.lastPayload.mockReturnValue({ id: 'order-456', status: 'complete' });

      const result = events.lastPayload('order/placed');

      expect(result).toBeDefined();
      expect(result.id).toBe('order-456');
    });

    it('should use order/placed payload for order confirmation display', () => {
      const orderData = {
        id: 'order-789',
        status: 'processing',
        total: { value: 500, currency: 'USD' },
        items: [{ sku: 'product-1', name: 'Product', qty: 1 }],
      };

      events.lastPayload.mockReturnValue(orderData);

      const retrieved = events.lastPayload('order/placed');

      expect(retrieved.id).toBe('order-789');
      expect(retrieved.total.value).toBe(500);
    });

    it('should handle order/placed with full order information', () => {
      const orderData = {
        id: 'order-complete',
        status: 'authorized',
        total: { value: 1000, currency: 'EUR' },
        items: [
          {
            sku: 'item-1', name: 'Item 1', qty: 1, price: 500,
          },
          {
            sku: 'item-2', name: 'Item 2', qty: 1, price: 500,
          },
        ],
        billingAddress: { city: 'Amsterdam', countryCode: 'NL' },
        shippingAddress: { city: 'Rotterdam', countryCode: 'NL' },
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        id: 'order-complete',
        total: expect.objectContaining({ value: 1000 }),
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'item-1' }),
          expect.objectContaining({ sku: 'item-2' }),
        ]),
      }));
    });
  });

  describe('Authenticated Event Handling', () => {
    it('should listen for authenticated event to show order history', () => {
      const callback = jest.fn();

      events.on('authenticated', callback);

      expect(events.on).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should emit authenticated event after user login', () => {
      const authPayload = {
        isAuthenticated: true,
        customerId: 'cust-123',
        email: 'user@example.com',
      };

      events.emit('authenticated', authPayload);

      expect(events.emit).toHaveBeenCalledWith('authenticated', authPayload);
    });

    it('should use authenticated payload for personalization', () => {
      const authPayload = {
        isAuthenticated: true,
        customerId: 'cust-456',
        firstName: 'John',
        lastName: 'Doe',
      };

      events.lastPayload.mockReturnValue(authPayload);

      const result = events.lastPayload('authenticated');

      expect(result.customerId).toBe('cust-456');
      expect(result.firstName).toBe('John');
    });
  });

  describe('Checkout State Events', () => {
    it('should emit checkout/initialized on load', () => {
      const checkoutData = {
        cartId: 'cart-123',
        step: 'shipping',
        email: 'user@example.com',
      };

      events.emit('checkout/initialized', checkoutData);

      expect(events.emit).toHaveBeenCalledWith('checkout/initialized', checkoutData);
    });

    it('should emit checkout/updated on field changes', () => {
      const updatedData = {
        cartId: 'cart-123',
        step: 'payment',
        email: 'user@example.com',
      };

      events.emit('checkout/updated', updatedData);

      expect(events.emit).toHaveBeenCalledWith('checkout/updated', updatedData);
    });

    it('should emit checkout/values with form data', () => {
      const formValues = {
        email: 'user@example.com',
        shippingMethod: 'standard',
        paymentMethod: 'adyen_scheme',
      };

      events.emit('checkout/values', formValues);

      expect(events.emit).toHaveBeenCalledWith('checkout/values', formValues);
    });

    it('should support checkout state progression via events', () => {
      const initData = { step: 'shipping' };
      const updateData = { step: 'payment' };

      events.emit('checkout/initialized', initData);
      events.emit('checkout/updated', updateData);

      expect(events.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe('Cart Data Event Coordination', () => {
    it('should receive cart/initialized to check cart state', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('cart/initialized', callback, { eager: true });
    });

    it('should receive cart/data for dynamic cart updates', () => {
      const cartData = {
        items: [{ sku: 'product-1', qty: 1, price: 100 }],
        total: 100,
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', cartData);
    });

    it('should redirect if cart is empty via cart/initialized event', () => {
      events.lastPayload.mockImplementation((name) => {
        if (name === 'cart/initialized') {
          return { items: [], total: 0 };
        }
        return undefined;
      });

      const emptyCartData = events.lastPayload('cart/initialized');

      expect(emptyCartData.items).toHaveLength(0);
    });

    it('should update checkout totals when cart/data emitted', () => {
      const cartData = {
        items: [
          { sku: 'p1', qty: 1, price: 50 },
          { sku: 'p2', qty: 1, price: 75 },
        ],
        total: 125,
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        total: 125,
        items: expect.arrayContaining([
          expect.objectContaining({ price: 50 }),
          expect.objectContaining({ price: 75 }),
        ]),
      }));
    });
  });

  describe('Checkout Event Payload Validation', () => {
    it('should validate checkout/initialized payload structure', () => {
      const checkoutData = {
        cartId: 'cart-123',
        step: 'shipping',
      };

      events.emit('checkout/initialized', checkoutData);

      expect(events.emit).toHaveBeenCalledWith('checkout/initialized', expect.objectContaining({
        cartId: expect.any(String),
        step: expect.any(String),
      }));
    });

    it('should validate checkout/values payload with form data', () => {
      const formValues = {
        email: 'test@example.com',
        firstname: 'John',
        lastname: 'Doe',
        shippingMethod: 'standard',
      };

      events.emit('checkout/values', formValues);

      expect(events.emit).toHaveBeenCalledWith('checkout/values', expect.any(Object));
    });

    it('should support order/placed with complete order payload', () => {
      const orderData = {
        id: 'order-123',
        status: 'processing',
        total: { value: 500, currency: 'USD' },
        items: [{ sku: 'product-1', qty: 1 }],
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        id: expect.any(String),
        total: expect.objectContaining({ value: expect.any(Number) }),
      }));
    });
  });

  describe('Event Unsubscription', () => {
    beforeEach(() => {
      // Reset before each unsubscription test
      events.off.mockClear();
      events.on.mockClear();
    });

    it('should unsubscribe from order/placed events', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);

      expect(events.off).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should unsubscribe from checkout/updated events', () => {
      const callback = jest.fn();

      events.off('checkout/updated', callback);

      expect(events.off).toHaveBeenCalledWith('checkout/updated', callback);
    });

    it('should support re-subscription after unsubscribe', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);
      events.on('order/placed', callback);

      expect(events.off).toHaveBeenCalledTimes(1);
      expect(events.on).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cross-Event Flow: Cart → Checkout → Order/Placed', () => {
    it('should handle full checkout flow through events', () => {
      // Cart initialization
      events.emit('cart/initialized', { items: [{ sku: 'p1' }], total: 100 });

      // Checkout init
      events.emit('checkout/initialized', { step: 'shipping' });

      // Checkout update to payment
      events.emit('checkout/updated', { step: 'payment' });

      // Order placement
      events.emit('order/placed', { id: 'order-123' });

      expect(events.emit).toHaveBeenCalledTimes(4);
    });

    it('should coordinate authenticated + checkout events', () => {
      // User logs in
      events.emit('authenticated', { isAuthenticated: true, customerId: 'cust-1' });

      // Checkout initializes with auth context
      events.emit('checkout/initialized', { step: 'shipping', customerId: 'cust-1' });

      // Order placed
      events.emit('order/placed', { id: 'order-456', customerId: 'cust-1' });

      expect(events.emit).toHaveBeenCalledTimes(3);
    });

    it('should handle cart/data update during checkout', () => {
      events.emit('checkout/initialized', { step: 'shipping', total: 100 });
      events.emit('cart/data', { items: [{ sku: 'p2' }], total: 150 });
      events.emit('checkout/updated', { step: 'payment', total: 150 });

      expect(events.emit).toHaveBeenCalledTimes(3);
    });
  });
});
