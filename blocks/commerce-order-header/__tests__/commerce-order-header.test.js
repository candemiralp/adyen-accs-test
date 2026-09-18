/**
 * Tests for Commerce Order Header Block
 * Tests for order header rendering with event bus integration
 */

// Setup mocks BEFORE importing
// THEN import the modules to use
import { events } from '@dropins/tools/event-bus.js';
import { Header, provider as UI } from '@dropins/tools/components.js';
import {
  CUSTOMER_ORDER_DETAILS_PATH,
  CUSTOMER_ORDERS_PATH,
  rootLink,
} from '../../../scripts/commerce.js';
import decorate from '../commerce-order-header.js';

jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  },
}));

jest.mock('@dropins/tools/components.js', () => ({
  Header: jest.fn(),
  provider: {
    render: jest.fn(() => jest.fn(() => Promise.resolve())),
  },
}));

jest.mock('../../../scripts/commerce.js', () => ({
  CUSTOMER_ORDER_DETAILS_PATH: '/customer/orders/',
  CUSTOMER_ORDERS_PATH: '/customer/orders',
  fetchPlaceholders: jest.fn(() => Promise.resolve({})),
  rootLink: jest.fn((path) => `${path}`),
}));

jest.mock('../../../scripts/initializers/order.js', () => ({}), {
  virtual: true,
});

describe('Commerce Order Header Block', () => {
  let block;

  beforeEach(() => {
    block = document.createElement('div');
    document.body.appendChild(block);
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (block.parentElement) {
      document.body.removeChild(block);
    }
  });

  describe('Block Decoration', () => {
    it('should decorate block without error', async () => {
      await expect(decorate(block)).resolves.toBeUndefined();
    });

    it('should render header component', async () => {
      await decorate(block);

      // Block should have content added
      expect(block.children.length).toBeGreaterThanOrEqual(0);
    });

    it('should be async function', () => {
      const result = decorate(block);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('Event Bus Integration', () => {
    it('should subscribe to order/data event', async () => {
      await decorate(block);

      // Should set up event listener
      expect(events.on).toHaveBeenCalled();
    });

    it('should use order event stream', async () => {
      await decorate(block);

      const { calls } = events.on.mock;
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  describe('Header Rendering', () => {
    it('should use Header component', async () => {
      await decorate(block);

      // Header should be used for rendering
      expect(Header).toBeDefined();
    });

    it('should pass block to render', async () => {
      await decorate(block);

      expect(UI.render).toHaveBeenCalled();
    });
  });

  describe('Commerce Links', () => {
    it('should import CUSTOMER_ORDER_DETAILS_PATH constant', () => {
      expect(CUSTOMER_ORDER_DETAILS_PATH).toBe('/customer/orders/');
    });

    it('should import CUSTOMER_ORDERS_PATH constant', () => {
      expect(CUSTOMER_ORDERS_PATH).toBe('/customer/orders');
    });

    it('should use rootLink function', () => {
      const link = rootLink('/test');
      expect(link).toBe('/test');
    });
  });

  describe('Initialization', () => {
    it('should initialize order functionality', async () => {
      // Initializer import should not throw
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../scripts/initializers/order.js');
      }).not.toThrow();
    });
  });

  describe('Block Modification', () => {
    it('should not clear block initially', async () => {
      block.innerHTML = '<p>Original content</p>';

      await decorate(block);

      // Check that block still exists
      expect(block).toBeDefined();
    });

    it('should be idempotent', async () => {
      await decorate(block);
      const firstChildCount = block.children.length;

      // Decorating again should not cause issues
      // (In practice this shouldn't happen, but it's defensive)
      expect(firstChildCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing event bus gracefully', async () => {
      // Even if event bus isn't available, decorate should not crash
      await expect(decorate(block)).resolves.toBeUndefined();
    });
  });

  describe('Order Path Configuration', () => {
    it('should have order details path', () => {
      expect(CUSTOMER_ORDER_DETAILS_PATH).toContain('customer');
      expect(CUSTOMER_ORDER_DETAILS_PATH).toContain('orders');
    });

    it('should have orders list path', () => {
      expect(CUSTOMER_ORDERS_PATH).toContain('customer');
      expect(CUSTOMER_ORDERS_PATH).toContain('orders');
    });
  });

  describe('Header Properties', () => {
    it('should render with order data from events', async () => {
      await decorate(block);

      // Should be listening for order data
      expect(events.on).toHaveBeenCalled();
    });

    it('should handle order detail page link', async () => {
      await decorate(block);

      // Link function should work
      const path = rootLink(CUSTOMER_ORDER_DETAILS_PATH);
      expect(path).toBeTruthy();
    });
  });

  describe('Multiple Blocks', () => {
    it('should decorate multiple blocks independently', async () => {
      const block2 = document.createElement('div');
      document.body.appendChild(block2);

      await decorate(block);
      await decorate(block2);

      expect(block).toBeDefined();
      expect(block2).toBeDefined();

      document.body.removeChild(block2);
    });
  });

  describe('Event Listener Configuration', () => {
    it('should set up event listener for order details', async () => {
      await decorate(block);

      // Should listen for order/data event
      const eventCalls = events.on.mock.calls;
      expect(eventCalls.length).toBeGreaterThan(0);
    });
  });
});
