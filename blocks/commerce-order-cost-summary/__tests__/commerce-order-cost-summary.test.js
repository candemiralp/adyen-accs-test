/**
 * Tests for Commerce Order Cost Summary Block
 * Tests for order cost summary rendering with drop-in integration
 */

import { render as orderRenderer } from '@dropins/storefront-order/render.js';
import { OrderCostSummary } from '@dropins/storefront-order/containers/OrderCostSummary.js';
import decorate from '../commerce-order-cost-summary.js';

jest.mock('@dropins/storefront-order/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

jest.mock('@dropins/storefront-order/containers/OrderCostSummary.js', () => ({
  OrderCostSummary: jest.fn(),
}));

jest.mock('../../../scripts/initializers/order.js', () => ({}), {
  virtual: true,
});

describe('Commerce Order Cost Summary Block', () => {
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
    OrderCostSummary.mockReset();
  });

  afterEach(() => {
    if (block.parentElement) {
      document.body.removeChild(block);
    }
  });

  describe('Block Decoration', () => {
    it('should render OrderCostSummary container', async () => {
      await decorate(block);

      expect(orderRenderer.render).toHaveBeenCalledWith(
        OrderCostSummary,
        {},
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

  describe('Drop-in Container Integration', () => {
    it('should use correct drop-in container class', async () => {
      await decorate(block);

      expect(orderRenderer.render).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('should use OrderCostSummary container', async () => {
      await decorate(block);

      const { calls } = orderRenderer.render.mock;
      expect(calls[0][0]).toBe(OrderCostSummary);
    });

    it('should pass block as render target', async () => {
      await decorate(block);

      const renderFn = orderRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });

  describe('Configuration', () => {
    it('should use default empty configuration', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(config).toEqual({});
    });

    it('should not override render configuration', async () => {
      await decorate(block);

      const config = orderRenderer.render.mock.calls[0][1];
      expect(Object.keys(config).length).toBe(0);
    });

    it('should pass config as second argument to render', async () => {
      await decorate(block);

      const args = orderRenderer.render.mock.calls[0];
      expect(args.length).toBe(2);
      expect(args[1]).toEqual({});
    });
  });

  describe('Async Behavior', () => {
    it('should wait for render to complete', async () => {
      const renderPromise = Promise.resolve();
      orderRenderer.render.mockReturnValue(() => renderPromise);

      const decoratePromise = decorate(block);

      expect(decoratePromise).toBeInstanceOf(Promise);
      await expect(decoratePromise).resolves.toBeUndefined();
    });

    it('should handle delayed rendering', async () => {
      let resolveRender;
      const renderPromise = new Promise((resolve) => {
        resolveRender = resolve;
      });

      orderRenderer.render.mockReturnValue(() => renderPromise);

      const decoratePromise = decorate(block);

      let resolved = false;
      decoratePromise.then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      resolveRender();
      await renderPromise;
      await decoratePromise;

      expect(resolved).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should propagate render errors', async () => {
      const error = new Error('Render failed');
      orderRenderer.render.mockImplementation(() => jest.fn().mockRejectedValue(error));

      await expect(decorate(block)).rejects.toThrow('Render failed');
    });

    it('should handle missing drop-in container gracefully', async () => {
      const renderFn = jest.fn().mockRejectedValue(
        new Error('Container not found'),
      );
      orderRenderer.render.mockReturnValue(renderFn);

      await expect(decorate(block)).rejects.toThrow('Container not found');
    });
  });

  describe('Block Modification', () => {
    it('should work with empty block', async () => {
      expect(block.children.length).toBe(0);

      await decorate(block);

      // Decoration should complete
      expect(block).toBeDefined();
    });

    it('should work with block containing content', async () => {
      block.innerHTML = '<p>Existing content</p>';

      await decorate(block);

      // Decoration should complete
      expect(block).toBeDefined();
    });
  });

  describe('Commerce Integration', () => {
    it('should integrate with order drop-in system', async () => {
      await decorate(block);

      expect(orderRenderer.render).toHaveBeenCalled();
    });

    it('should use standard drop-in render pattern', async () => {
      await decorate(block);

      expect(orderRenderer.render).toHaveBeenCalledWith(
        OrderCostSummary,
        {},
      );

      const renderFn = orderRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });

    it('should load order initializer', () => {
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../scripts/initializers/order.js');
      }).not.toThrow();
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

  describe('Render Function Behavior', () => {
    it('should call render with container and config', async () => {
      await decorate(block);

      const { calls } = orderRenderer.render.mock;
      expect(calls.length).toBeGreaterThan(0);

      const [container, config] = calls[0];
      expect(container).toBe(OrderCostSummary);
      expect(config).toBeDefined();
    });

    it('should invoke returned render function with block', async () => {
      await decorate(block);

      const renderFn = orderRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });
});
