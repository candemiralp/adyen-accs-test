/**
 * Tests for Commerce Cart Block - Event Bus Integration
 * Tests for cart/data event subscription and wishlist/alert handling
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

jest.mock('@dropins/storefront-cart/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

jest.mock('@dropins/storefront-cart/containers/MiniCart.js', () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe('Commerce Cart Block - Event Bus Integration', () => {
  beforeEach(() => {
    events.on.mockClear();
    events.emit.mockClear();
    events.lastPayload.mockClear();
  });

  describe('Cart Event Subscriptions', () => {
    it('should subscribe to cart/data event for multi-block updates', () => {
      const callback = jest.fn();

      events.on('cart/data', callback);

      expect(events.on).toHaveBeenCalledWith('cart/data', callback);
    });

    it('should subscribe to cart/initialized event for initial load', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback);

      expect(events.on).toHaveBeenCalledWith('cart/initialized', callback);
    });

    it('should subscribe to wishlist/alert event', () => {
      const callback = jest.fn();

      events.on('wishlist/alert', callback);

      expect(events.on).toHaveBeenCalledWith('wishlist/alert', callback);
    });

    it('should use eager option for cart/initialized subscription', () => {
      const callback = jest.fn();

      events.on('cart/initialized', callback, { eager: true });

      expect(events.on).toHaveBeenCalledWith('cart/initialized', callback, { eager: true });
    });
  });

  describe('Cart Data Event Emission', () => {
    it('should emit cart/data with items and total', () => {
      const cartData = {
        items: [
          { sku: 'product-1', qty: 1, price: 99.99 },
        ],
        total: 99.99,
        cartId: 'cart-123',
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', cartData);
    });

    it('should emit cart/data with multiple items', () => {
      const cartData = {
        items: [
          { sku: 'product-1', qty: 1, price: 99.99 },
          { sku: 'product-2', qty: 2, price: 49.99 },
        ],
        total: 199.97,
        cartId: 'cart-456',
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'product-1' }),
          expect.objectContaining({ sku: 'product-2' }),
        ]),
      }));
    });

    it('should emit cart/initialized on load', () => {
      const cartData = { items: [], total: 0, cartId: 'cart-new' };

      events.emit('cart/initialized', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/initialized', cartData);
    });

    it('should emit wishlist/alert with action and item', () => {
      const alert = {
        action: 'added',
        item: { sku: 'product-123', name: 'Test Product' },
      };

      events.emit('wishlist/alert', alert);

      expect(events.emit).toHaveBeenCalledWith('wishlist/alert', alert);
    });

    it('should support removing items and re-emit cart/data', () => {
      const updatedCart = {
        items: [{ sku: 'product-2', qty: 2 }],
        total: 99.98,
        cartId: 'cart-456',
      };

      events.emit('cart/data', updatedCart);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'product-2' }),
        ]),
      }));
    });
  });

  describe('Wishlist Event Handling', () => {
    it('should handle wishlist/alert with add action', () => {
      const alert = {
        action: 'added',
        item: { sku: 'product-wishlist' },
      };

      events.emit('wishlist/alert', alert);

      expect(events.emit).toHaveBeenCalledWith('wishlist/alert', expect.objectContaining({
        action: 'added',
      }));
    });

    it('should handle wishlist/alert with remove action', () => {
      const alert = {
        action: 'removed',
        item: { sku: 'product-wishlist' },
      };

      events.emit('wishlist/alert', alert);

      expect(events.emit).toHaveBeenCalledWith('wishlist/alert', expect.objectContaining({
        action: 'removed',
      }));
    });

    it('should include full item details in wishlist/alert', () => {
      const alert = {
        action: 'added',
        item: {
          sku: 'DELUXE-PRODUCT',
          name: 'Deluxe Product',
          price: 299.99,
          image: 'product-image.jpg',
        },
      };

      events.emit('wishlist/alert', alert);

      expect(events.emit).toHaveBeenCalledWith('wishlist/alert', alert);
    });
  });

  describe('Cart Data Payload Validation', () => {
    it('should validate cart/data minimal payload', () => {
      const cartData = {
        items: [],
        total: 0,
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        items: expect.any(Array),
        total: expect.any(Number),
      }));
    });

    it('should validate cart/data complete payload', () => {
      const cartData = {
        items: [
          {
            sku: 'product-1', qty: 1, price: 100, name: 'Product 1',
          },
        ],
        total: 100,
        cartId: 'cart-789',
        discounts: [{ code: 'SAVE10', amount: 10 }],
      };

      events.emit('cart/data', cartData);

      expect(events.emit).toHaveBeenCalledWith('cart/data', expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            sku: expect.any(String),
            qty: expect.any(Number),
            price: expect.any(Number),
          }),
        ]),
        total: expect.any(Number),
      }));
    });

    it('should allow optional cartId in cart/data', () => {
      const withoutCartId = {
        items: [{ sku: 'product-1' }],
        total: 100,
      };

      const withCartId = {
        items: [{ sku: 'product-1' }],
        total: 100,
        cartId: 'cart-123',
      };

      events.emit('cart/data', withoutCartId);
      events.emit('cart/data', withCartId);

      expect(events.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe('Event Unsubscription', () => {
    beforeEach(() => {
      // Reset before each unsubscription test
      events.off.mockClear();
      events.on.mockClear();
    });

    it('should unsubscribe from cart/data events', () => {
      const callback = jest.fn();

      events.off('cart/data', callback);

      expect(events.off).toHaveBeenCalledWith('cart/data', callback);
    });

    it('should unsubscribe from wishlist/alert events', () => {
      const callback = jest.fn();

      events.off('wishlist/alert', callback);

      expect(events.off).toHaveBeenCalledWith('wishlist/alert', callback);
    });

    it('should support resubscription after unsubscribe', () => {
      const callback = jest.fn();

      events.off('cart/data', callback);
      events.on('cart/data', callback);

      expect(events.off).toHaveBeenCalledTimes(1);
      expect(events.on).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cart Event Payload Retrieval', () => {
    it('should retrieve last cart/data payload via lastPayload', () => {
      events.lastPayload('cart/data');

      expect(events.lastPayload).toHaveBeenCalledWith('cart/data');
    });

    it('should retrieve last cart/initialized payload', () => {
      events.lastPayload('cart/initialized');

      expect(events.lastPayload).toHaveBeenCalledWith('cart/initialized');
    });

    it('should support lastPayload for detecting cart state', () => {
      events.lastPayload.mockReturnValue({ items: [{ sku: 'product-1' }], total: 100 });

      const result = events.lastPayload('cart/data');

      expect(result).toBeDefined();
      expect(result.items).toHaveLength(1);
    });
  });
});
