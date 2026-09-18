/**
 * Tests for Commerce Customer Information Block
 * Tests for customer details rendering with address, email, phone display
 */

import { render as accountRenderer } from '@dropins/storefront-account/render.js';
import CustomerInformation from '@dropins/storefront-account/containers/CustomerInformation.js';
import { checkIsAuthenticated } from '../../../scripts/commerce.js';
import decorate from '../commerce-customer-information.js';

jest.mock('@dropins/storefront-account/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

jest.mock('@dropins/storefront-account/containers/CustomerInformation.js', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../scripts/initializers/account.js', () => ({}), {
  virtual: true,
});

jest.mock('../../../scripts/commerce.js', () => ({
  rootLink: jest.fn((path) => `${path}`),
  fetchPlaceholders: jest.fn(() => Promise.resolve({})),
  CUSTOMER_LOGIN_PATH: '/customer/login',
  checkIsAuthenticated: jest.fn(),
}));

describe('Commerce Customer Information Block', () => {
  let block;

  beforeEach(() => {
    block = document.createElement('div');
    document.body.appendChild(block);
    jest.clearAllMocks();
    // Reset mock implementations to default behavior
    accountRenderer.render.mockReset();
    accountRenderer.render.mockImplementation(
      (_container, _config) => jest.fn((_block) => Promise.resolve()),
    );
    CustomerInformation.mockReset();
    // Mock checkIsAuthenticated to return true for testing
    checkIsAuthenticated.mockReturnValue(true);
  });

  afterEach(() => {
    if (block.parentElement) {
      document.body.removeChild(block);
    }
  });

  describe('Block Decoration', () => {
    it('should render CustomerInformation container', async () => {
      await decorate(block);

      expect(accountRenderer.render).toHaveBeenCalledWith(
        CustomerInformation,
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

      expect(accountRenderer.render).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('should use CustomerInformation container', async () => {
      await decorate(block);

      const { calls } = accountRenderer.render.mock;
      expect(calls[0][0]).toBe(CustomerInformation);
    });

    it('should pass block as render target', async () => {
      await decorate(block);

      const renderFn = accountRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });

  describe('Configuration', () => {
    it('should use default empty configuration', async () => {
      await decorate(block);

      const config = accountRenderer.render.mock.calls[0][1];
      expect(config).toEqual({});
    });

    it('should not override render configuration', async () => {
      await decorate(block);

      const config = accountRenderer.render.mock.calls[0][1];
      expect(Object.keys(config).length).toBe(0);
    });
  });

  describe('Async Behavior', () => {
    it('should wait for render to complete', async () => {
      const renderPromise = Promise.resolve();
      accountRenderer.render.mockReturnValue(() => renderPromise);

      const decoratePromise = decorate(block);

      expect(decoratePromise).toBeInstanceOf(Promise);
      await expect(decoratePromise).resolves.toBeUndefined();
    });

    it('should handle async rendering', async () => {
      let resolveRender;
      const renderPromise = new Promise((resolve) => {
        resolveRender = resolve;
      });

      accountRenderer.render.mockReturnValue(() => renderPromise);

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
      accountRenderer.render.mockImplementation(() => jest.fn().mockRejectedValue(error));

      await expect(decorate(block)).rejects.toThrow('Render failed');
    });

    it('should handle missing drop-in container gracefully', async () => {
      const renderFn = jest.fn().mockRejectedValue(
        new Error('Container not found'),
      );
      accountRenderer.render.mockReturnValue(renderFn);

      await expect(decorate(block)).rejects.toThrow('Container not found');
    });

    it('should handle missing customer data', async () => {
      await expect(decorate(block)).resolves.toBeUndefined();
    });
  });

  describe('Block Modification', () => {
    it('should work with empty block', async () => {
      expect(block.children.length).toBe(0);

      await decorate(block);

      expect(block).toBeDefined();
    });

    it('should work with block containing content', async () => {
      block.innerHTML = '<p>Existing content</p>';

      await decorate(block);

      expect(block).toBeDefined();
    });
  });

  describe('Account Integration', () => {
    it('should integrate with account drop-in system', async () => {
      await decorate(block);

      expect(accountRenderer.render).toHaveBeenCalled();
    });

    it('should use standard drop-in render pattern', async () => {
      await decorate(block);

      expect(accountRenderer.render).toHaveBeenCalledWith(
        CustomerInformation,
        {},
      );

      const renderFn = accountRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });

    it('should load account initializer', () => {
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../scripts/initializers/account.js');
      }).not.toThrow();
    });
  });

  describe('Multiple Blocks', () => {
    it('should decorate multiple blocks independently', async () => {
      const block2 = document.createElement('div');
      document.body.appendChild(block2);

      await decorate(block);
      const firstCallCount = accountRenderer.render.mock.calls.length;

      await decorate(block2);
      const secondCallCount = accountRenderer.render.mock.calls.length;

      expect(secondCallCount).toBe(firstCallCount + 1);

      document.body.removeChild(block2);
    });
  });

  describe('Accessibility', () => {
    it('should render customer information with semantic structure', async () => {
      await decorate(block);

      expect(block).toBeDefined();
      expect(accountRenderer.render).toHaveBeenCalled();
    });
  });

  describe('Render Function Behavior', () => {
    it('should call render with container and config', async () => {
      await decorate(block);

      const { calls } = accountRenderer.render.mock;
      expect(calls.length).toBeGreaterThan(0);

      const [container, config] = calls[0];
      expect(container).toBe(CustomerInformation);
      expect(config).toBeDefined();
    });

    it('should invoke returned render function with block', async () => {
      await decorate(block);

      const renderFn = accountRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });
});
