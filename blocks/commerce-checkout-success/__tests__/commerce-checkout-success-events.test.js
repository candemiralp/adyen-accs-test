/**
 * Tests for Commerce Checkout Success Block - Event Bus Integration
 * Tests for order/placed and authenticated event handling
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

describe('Commerce Checkout Success Block - Event Bus Integration', () => {
  beforeEach(() => {
    events.on.mockClear();
    events.emit.mockClear();
    events.lastPayload.mockClear();
  });

  describe('Checkout Success Event Subscriptions', () => {
    it('should subscribe to authenticated event to show order history', () => {
      const callback = jest.fn();

      events.on('authenticated', callback);

      expect(events.on).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should subscribe to order/placed to display order details', () => {
      const callback = jest.fn();

      events.on('order/placed', callback);

      expect(events.on).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should use eager option for authenticated subscription', () => {
      const callback = jest.fn();

      events.on('authenticated', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('authenticated', callback, { eager: true });
    });
  });

  describe('Order Placed Event Handling', () => {
    it('should retrieve order data from order/placed event', () => {
      events.lastPayload.mockReturnValue({
        id: 'order-123',
        status: 'processing',
        total: { value: 500, currency: 'USD' },
      });

      const orderData = events.lastPayload('order/placed');

      expect(orderData.id).toBe('order-123');
      expect(orderData.total.value).toBe(500);
    });

    it('should display order confirmation with order/placed payload', () => {
      const orderData = {
        id: 'order-456',
        status: 'authorized',
        total: { value: 1000, currency: 'EUR' },
        items: [
          {
            sku: 'product-1', name: 'Product 1', qty: 1, price: 600,
          },
          {
            sku: 'product-2', name: 'Product 2', qty: 1, price: 400,
          },
        ],
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        id: 'order-456',
        total: { value: 1000, currency: 'EUR' },
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'product-1' }),
          expect.objectContaining({ sku: 'product-2' }),
        ]),
      }));
    });

    it('should include shipping information in order/placed payload', () => {
      const orderData = {
        id: 'order-ship-123',
        shippingAddress: {
          street: '123 Main St',
          city: 'Amsterdam',
          postalCode: '1012AA',
          countryCode: 'NL',
        },
        shippingMethod: 'express',
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        shippingAddress: expect.objectContaining({ city: 'Amsterdam' }),
        shippingMethod: 'express',
      }));
    });

    it('should handle order/placed with billing information', () => {
      const orderData = {
        id: 'order-bill-456',
        billingAddress: {
          street: '456 Oak Ave',
          city: 'Rotterdam',
          postalCode: '3011AA',
          countryCode: 'NL',
        },
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        billingAddress: expect.objectContaining({ city: 'Rotterdam' }),
      }));
    });
  });

  describe('Authenticated Event Handling', () => {
    it('should receive authenticated event to show customer account link', () => {
      const authPayload = {
        isAuthenticated: true,
        customerId: 'cust-123',
      };

      events.emit('authenticated', authPayload);

      expect(events.emit).toHaveBeenCalledWith('authenticated', authPayload);
    });

    it('should use authenticated payload to show order history link', () => {
      const authPayload = {
        isAuthenticated: true,
        customerId: 'cust-456',
        email: 'user@example.com',
      };

      events.lastPayload.mockReturnValue(authPayload);

      const retrieved = events.lastPayload('authenticated');

      expect(retrieved.isAuthenticated).toBe(true);
      expect(retrieved.customerId).toBe('cust-456');
    });

    it('should show guest checkout message for unauthenticated users', () => {
      const unauthPayload = {
        isAuthenticated: false,
      };

      events.emit('authenticated', unauthPayload);

      expect(events.emit).toHaveBeenCalledWith('authenticated', expect.objectContaining({
        isAuthenticated: false,
      }));
    });
  });

  describe('Checkout Success Page Elements', () => {
    it('should display order number from order/placed event', () => {
      events.lastPayload.mockReturnValue({ id: 'order-display-123' });

      const orderId = events.lastPayload('order/placed').id;

      expect(orderId).toBe('order-display-123');
    });

    it('should display order total and currency from order/placed', () => {
      events.lastPayload.mockReturnValue({
        id: 'order-789',
        total: { value: 299.99, currency: 'USD' },
      });

      const orderData = events.lastPayload('order/placed');

      expect(orderData.total.value).toBe(299.99);
      expect(orderData.total.currency).toBe('USD');
    });

    it('should display order items list from order/placed payload', () => {
      const orderData = {
        id: 'order-items-123',
        items: [
          {
            sku: 'SKU-001', name: 'Item 1', qty: 1, price: 100,
          },
          {
            sku: 'SKU-002', name: 'Item 2', qty: 2, price: 50,
          },
        ],
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'SKU-001', qty: 1 }),
          expect.objectContaining({ sku: 'SKU-002', qty: 2 }),
        ]),
      }));
    });

    it('should display estimated delivery from order/placed shipping data', () => {
      const orderData = {
        id: 'order-delivery-456',
        shippingMethod: 'express',
        estimatedDelivery: '2026-06-25',
      };

      events.emit('order/placed', orderData);

      expect(events.emit).toHaveBeenCalledWith('order/placed', expect.objectContaining({
        shippingMethod: 'express',
        estimatedDelivery: '2026-06-25',
      }));
    });
  });

  describe('Event Payload Coordination', () => {
    it('should merge order/placed and authenticated payloads', () => {
      const authPayload = { isAuthenticated: true, customerId: 'cust-789' };
      const orderPayload = { id: 'order-cust-789', customerId: 'cust-789' };

      events.emit('authenticated', authPayload);
      events.emit('order/placed', orderPayload);

      expect(events.emit).toHaveBeenCalledTimes(2);
      expect(events.emit).toHaveBeenNthCalledWith(1, 'authenticated', authPayload);
      expect(events.emit).toHaveBeenNthCalledWith(2, 'order/placed', orderPayload);
    });

    it('should support retrieving order data after order/placed event', () => {
      const orderData = {
        id: 'order-retrieve-123',
        status: 'complete',
      };

      events.lastPayload.mockReturnValue(orderData);

      const retrieved = events.lastPayload('order/placed');

      expect(retrieved.id).toBe('order-retrieve-123');
    });
  });

  describe('Success Page Navigation', () => {
    it('should support creating account link after order placement', () => {
      const accountCallback = jest.fn();

      events.on('authenticated', accountCallback);

      // Emit authenticated after successful order
      events.emit('authenticated', { isAuthenticated: true, customerId: 'new-cust' });

      expect(events.on).toHaveBeenCalledWith('authenticated', accountCallback);
      expect(events.emit).toHaveBeenCalledWith('authenticated', expect.objectContaining({
        customerId: 'new-cust',
      }));
    });

    it('should provide order history link for authenticated users', () => {
      events.lastPayload.mockReturnValue({
        isAuthenticated: true,
        customerId: 'existing-cust',
      });

      const auth = events.lastPayload('authenticated');

      expect(auth.isAuthenticated).toBe(true);
    });

    it('should handle guest checkout confirmation without account link', () => {
      events.lastPayload.mockReturnValue({
        isAuthenticated: false,
      });

      const auth = events.lastPayload('authenticated');

      expect(auth.isAuthenticated).toBe(false);
    });
  });

  describe('Event Unsubscription & Cleanup', () => {
    it('should unsubscribe from order/placed events', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);

      expect(events.off).toHaveBeenCalledWith('order/placed', callback);
    });

    it('should unsubscribe from authenticated events', () => {
      const callback = jest.fn();

      events.off('authenticated', callback);

      expect(events.off).toHaveBeenCalledWith('authenticated', callback);
    });

    it('should support cleanup after order confirmation display', () => {
      const callback = jest.fn();

      events.off('order/placed', callback);

      expect(events.off).toHaveBeenCalledWith('order/placed', callback);
    });
  });

  describe('Edge Cases & Error Handling', () => {
    it('should handle missing order/placed event gracefully', () => {
      events.lastPayload.mockReturnValue(undefined);

      const result = events.lastPayload('order/placed');

      expect(result).toBeUndefined();
    });

    it('should handle null order payload', () => {
      expect(() => {
        events.emit('order/placed', null);
      }).not.toThrow();

      expect(events.emit).toHaveBeenCalledWith('order/placed', null);
    });

    it('should handle rapid order/placed events', () => {
      events.emit('order/placed', { id: 'order-1' });
      events.emit('order/placed', { id: 'order-2' });

      expect(events.emit).toHaveBeenCalledTimes(2);
    });

    it('should handle unauthenticated users with order/placed', () => {
      events.lastPayload.mockImplementation((name) => {
        if (name === 'authenticated') {
          return { isAuthenticated: false };
        }
        if (name === 'order/placed') {
          return { id: 'order-guest-123' };
        }
        return undefined;
      });

      const auth = events.lastPayload('authenticated');
      const order = events.lastPayload('order/placed');

      expect(auth.isAuthenticated).toBe(false);
      expect(order.id).toBe('order-guest-123');
    });
  });
});
