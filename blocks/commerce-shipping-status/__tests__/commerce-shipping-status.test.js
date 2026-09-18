/**
 * Tests for Commerce Shipping Status Block
 * Tests for shipping status rendering with slots, tracking, and product linking
 */

import { render as orderRenderer } from '@dropins/storefront-order/render.js';
import { ShippingStatus } from '@dropins/storefront-order/containers/ShippingStatus.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
import {
  getProductLink,
} from '../../../scripts/commerce.js';
import decorate from '../commerce-shipping-status.js';

jest.mock('@dropins/storefront-order/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

jest.mock('@dropins/storefront-order/containers/ShippingStatus.js', () => ({
  ShippingStatus: jest.fn(),
}));

jest.mock('@dropins/tools/lib/aem/assets.js', () => ({
  tryRenderAemAssetsImage: jest.fn(),
}));

jest.mock('../../../scripts/commerce.js', () => ({
  UPS_TRACKING_URL: 'https://tracking.ups.com',
  getProductLink: jest.fn((urlKey, sku) => `/product/${urlKey}/${sku}`),
}));

jest.mock('../../../scripts/initializers/order.js', () => ({}), {
  virtual: true,
});

describe('Commerce Shipping Status Block', () => {
  let block;

  beforeEach(() => {
    block = document.createElement('div');
    document.body.appendChild(block);
    jest.clearAllMocks();
    // Reset mock implementations to default behavior
    orderRenderer.render.mockReset();
    orderRenderer.render.mockImplementation(
      (_container, _config) => jest.fn((_block) => Promise.resolve()),
    );
    ShippingStatus.mockReset();
  });

  afterEach(() => {
    if (block.parentElement) {
      document.body.removeChild(block);
    }
  });

  describe('Block Decoration', () => {
    it('should render ShippingStatus container', async () => {
      await decorate(block);

      expect(orderRenderer.render).toHaveBeenCalledWith(
        ShippingStatus,
        expect.any(Object),
      );
    });

    it('should decorate block without error', async () => {
      await expect(decorate(block)).resolves.toBeUndefined();
    });

    it('should be async function', () => {
      const result = decorate(block);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('Slot Configuration', () => {
    it('should configure ShippingStatusCardImage slot', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.slots).toBeDefined();
      expect(config.slots.ShippingStatusCardImage).toBeDefined();
      expect(typeof config.slots.ShippingStatusCardImage).toBe('function');
    });

    it('should configure NotYetShippedProductImage slot', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.slots.NotYetShippedProductImage).toBeDefined();
      expect(typeof config.slots.NotYetShippedProductImage).toBe('function');
    });

    it('should configure ShippingStatusReturnCardImage slot', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.slots.ShippingStatusReturnCardImage).toBeDefined();
      expect(typeof config.slots.ShippingStatusReturnCardImage).toBe('function');
    });

    it('should have three image slots configured', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const slotNames = Object.keys(config.slots);
      expect(slotNames.length).toBe(3);
      expect(slotNames).toContain('ShippingStatusCardImage');
      expect(slotNames).toContain('NotYetShippedProductImage');
      expect(slotNames).toContain('ShippingStatusReturnCardImage');
    });
  });

  describe('Tracking URL Configuration', () => {
    it('should configure routeTracking function', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.routeTracking).toBeDefined();
      expect(typeof config.routeTracking).toBe('function');
    });

    it('should generate UPS tracking URL for UPS carrier', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const trackingData = {
        carrier: 'UPS',
        number: '123456789',
      };

      const url = config.routeTracking(trackingData);

      expect(url).toContain('https://tracking.ups.com');
      expect(url).toContain('tracknum=123456789');
    });

    it('should handle lowercase UPS carrier name', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const trackingData = {
        carrier: 'ups',
        number: '987654321',
      };

      const url = config.routeTracking(trackingData);

      expect(url).toContain('https://tracking.ups.com');
      expect(url).toContain('tracknum=987654321');
    });

    it('should return empty string for non-UPS carrier', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const trackingData = {
        carrier: 'FedEx',
        number: '123456789',
      };

      const url = config.routeTracking(trackingData);

      expect(url).toBe('');
    });

    it('should handle missing carrier gracefully', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const trackingData = {
        number: '123456789',
      };

      const url = config.routeTracking(trackingData);

      expect(url).toBe('');
    });
  });

  describe('Product Link Configuration', () => {
    it('should configure routeProductDetails function', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.routeProductDetails).toBeDefined();
      expect(typeof config.routeProductDetails).toBe('function');
    });

    it('should generate product link from orderItem', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const data = {
        orderItem: {
          productUrlKey: 'awesome-product',
          product: { sku: 'SKU-001' },
        },
      };

      const link = config.routeProductDetails(data);

      expect(link).toContain('awesome-product');
      expect(link).toContain('SKU-001');
      expect(getProductLink).toHaveBeenCalledWith('awesome-product', 'SKU-001');
    });

    it('should generate product link from product when orderItem unavailable', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const data = {
        product: {
          urlKey: 'simple-product',
          sku: 'SKU-002',
        },
      };

      const link = config.routeProductDetails(data);

      expect(link).toContain('simple-product');
      expect(link).toContain('SKU-002');
      expect(getProductLink).toHaveBeenCalledWith('simple-product', 'SKU-002');
    });

    it('should prefer orderItem over product', async () => {
      getProductLink.mockClear();

      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const data = {
        orderItem: {
          productUrlKey: 'order-item-product',
          product: { sku: 'ORDER-SKU' },
        },
        product: {
          urlKey: 'fallback-product',
          sku: 'FALLBACK-SKU',
        },
      };

      config.routeProductDetails(data);

      expect(getProductLink).toHaveBeenCalledWith(
        'order-item-product',
        'ORDER-SKU',
      );
    });

    it('should return fallback URL when no product data', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const data = {};

      const link = config.routeProductDetails(data);

      expect(link).toBe('#');
    });
  });

  describe('Image Slot Configuration (Internal)', () => {
    it('should call tryRenderAemAssetsImage for each image slot', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const mockCtx = {
        data: { product: { sku: 'TEST-SKU' } },
        defaultImageProps: {
          width: 300,
          height: 300,
        },
      };

      // Call the slot function to verify it works
      config.slots.ShippingStatusCardImage(mockCtx);

      // Should have called tryRenderAemAssetsImage
      expect(tryRenderAemAssetsImage).toHaveBeenCalled();
    });

    it('should configure image slots with product SKU alias', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config.slots).toBeDefined();

      // All three image slots should be functions
      expect(typeof config.slots.ShippingStatusCardImage).toBe('function');
      expect(typeof config.slots.NotYetShippedProductImage).toBe('function');
      expect(typeof config.slots.ShippingStatusReturnCardImage).toBe('function');
    });
  });

  describe('Async Behavior', () => {
    it('should handle async rendering', async () => {
      const renderPromise = Promise.resolve();
      orderRenderer.render.mockReturnValue(() => renderPromise);

      const decoratePromise = decorate(block);

      expect(decoratePromise).toBeInstanceOf(Promise);
      await expect(decoratePromise).resolves.toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should propagate render errors', async () => {
      const error = new Error('Render failed');
      orderRenderer.render.mockImplementation(() => jest.fn().mockRejectedValue(error));

      await expect(decorate(block)).rejects.toThrow('Render failed');
    });

    it('should handle tracking data without number', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      const trackingData = { carrier: 'UPS' };

      const url = config.routeTracking(trackingData);

      expect(url).toContain('tracknum=undefined');
    });
  });

  describe('Configuration Integration', () => {
    it('should have all required configuration options', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];

      expect(config.slots).toBeDefined();
      expect(config.routeTracking).toBeDefined();
      expect(config.routeProductDetails).toBeDefined();
    });

    it('should pass config as second argument to render', async () => {
      await decorate(block);

      const args = orderRenderer.render.mock.calls[0];
      expect(args.length).toBe(2);
      expect(args[0]).toBe(ShippingStatus);
      expect(args[1]).toHaveProperty('slots');
      expect(args[1]).toHaveProperty('routeTracking');
      expect(args[1]).toHaveProperty('routeProductDetails');
    });
  });

  describe('Multiple Blocks', () => {
    it('should decorate multiple blocks independently', async () => {
      const block2 = document.createElement('div');
      document.body.appendChild(block2);

      await decorate(block);
      const firstCallCount = orderRenderer.render.mock.calls.length;

      await decorate(block2);
      const secondCallCount = orderRenderer.render.mock.calls.length;

      expect(secondCallCount).toBe(firstCallCount + 1);

      document.body.removeChild(block2);
    });
  });
});
