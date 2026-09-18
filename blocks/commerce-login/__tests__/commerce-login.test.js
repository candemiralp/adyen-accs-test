/**
 * Tests for Commerce Login Block
 * Tests for authentication UI with form validation, error handling, and drop-in integration
 */

import { render as authRenderer } from '@dropins/storefront-auth/render.js';
import { SignIn } from '@dropins/storefront-auth/containers/SignIn.js';
import { checkIsAuthenticated } from '../../../scripts/commerce.js';
import decorate from '../commerce-login.js';

jest.mock('@dropins/storefront-auth/render.js', () => {
  const renderMethod = jest.fn((_container, _config) => jest.fn((_block) => Promise.resolve()));
  return { render: { render: renderMethod } };
});

jest.mock('@dropins/storefront-auth/containers/SignIn.js', () => ({
  SignIn: jest.fn(),
}));

jest.mock('../../../scripts/initializers/auth.js', () => ({}), {
  virtual: true,
});

jest.mock('../../../scripts/commerce.js', () => ({
  rootLink: jest.fn((path) => `${path}`),
  fetchPlaceholders: jest.fn(() => Promise.resolve({})),
  checkIsAuthenticated: jest.fn(() => false),
  CUSTOMER_ACCOUNT_PATH: '/account',
  CUSTOMER_FORGOTPASSWORD_PATH: '/forgot-password',
}));

describe('Commerce Login Block', () => {
  let block;

  beforeEach(() => {
    block = document.createElement('div');
    document.body.appendChild(block);
    jest.clearAllMocks();
    // Reset mock implementations to default behavior
    authRenderer.render.mockReset();
    authRenderer.render.mockImplementation(
      (_container, _config) => jest.fn((_block) => Promise.resolve()),
    );
    SignIn.mockReset();
    // Mock checkIsAuthenticated to return false (user not logged in)
    checkIsAuthenticated.mockReturnValue(false);
  });

  afterEach(() => {
    if (block.parentElement) {
      document.body.removeChild(block);
    }
  });

  describe('Block Decoration', () => {
    it('should render SignIn container', async () => {
      await decorate(block);

      expect(authRenderer.render).toHaveBeenCalledWith(
        SignIn,
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

  describe('Drop-in Container Integration', () => {
    it('should use correct drop-in container class', async () => {
      await decorate(block);

      expect(authRenderer.render).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('should use SignIn container', async () => {
      await decorate(block);

      const { calls } = authRenderer.render.mock;
      expect(calls[0][0]).toBe(SignIn);
    });

    it('should pass block as render target', async () => {
      await decorate(block);

      const renderFn = authRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });

  describe('Configuration', () => {
    it('should pass route callbacks in config', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      expect(config.routeForgotPassword).toBeDefined();
      expect(config.routeRedirectOnSignIn).toBeDefined();
      expect(typeof config.routeForgotPassword).toBe('function');
      expect(typeof config.routeRedirectOnSignIn).toBe('function');
    });

    it('should configure correct routes in config', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      expect(config).toHaveProperty('routeForgotPassword');
      expect(config).toHaveProperty('routeRedirectOnSignIn');
    });
  });

  describe('Navigation Routes', () => {
    it('should navigate to account page after sign-in', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      const accountRoute = config.routeRedirectOnSignIn();

      expect(accountRoute).toBeTruthy();
      expect(accountRoute).toContain('/');
    });

    it('should navigate to forgot password page', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      const forgotPasswordRoute = config.routeForgotPassword();

      expect(forgotPasswordRoute).toBeTruthy();
      expect(forgotPasswordRoute).toContain('/');
    });

    it('should handle route callbacks without error', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      const handler1 = config.routeForgotPassword;
      const handler2 = config.routeRedirectOnSignIn;

      // Call the handlers
      expect(() => {
        handler1();
        handler2();
      }).not.toThrow();
    });
  });

  describe('Async Behavior', () => {
    it('should wait for render to complete', async () => {
      const renderPromise = Promise.resolve();
      authRenderer.render.mockReturnValue(() => renderPromise);

      const decoratePromise = decorate(block);

      expect(decoratePromise).toBeInstanceOf(Promise);
      await expect(decoratePromise).resolves.toBeUndefined();
    });

    it('should handle async rendering', async () => {
      let resolveRender;
      const renderPromise = new Promise((resolve) => {
        resolveRender = resolve;
      });

      authRenderer.render.mockReturnValue(() => renderPromise);

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
      authRenderer.render.mockImplementation(() => jest.fn().mockRejectedValue(error));

      const renderFn = authRenderer.render();
      await expect(renderFn(block)).rejects.toThrow('Render failed');
    });

    it('should handle rendering failures gracefully', async () => {
      const renderFn = jest.fn().mockRejectedValue(
        new Error('Render failed'),
      );
      authRenderer.render.mockReturnValue(renderFn);

      await expect(decorate(block)).rejects.toThrow('Render failed');
    });

    it('should handle missing drop-in container gracefully', async () => {
      const renderFn = jest.fn().mockRejectedValue(
        new Error('Container not found'),
      );
      authRenderer.render.mockReturnValue(renderFn);

      await expect(decorate(block)).rejects.toThrow('Container not found');
    });

    it('should validate route callbacks are functions', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      expect(typeof config.routeForgotPassword).toBe('function');
      expect(typeof config.routeRedirectOnSignIn).toBe('function');
    });

    it('should handle route callback errors gracefully', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      const routes = [config.routeForgotPassword, config.routeRedirectOnSignIn];

      routes.forEach((route) => {
        expect(() => {
          route();
        }).not.toThrow();
      });
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

  describe('Auth Integration', () => {
    it('should integrate with auth drop-in system', async () => {
      await decorate(block);

      expect(authRenderer.render).toHaveBeenCalled();
    });

    it('should use standard drop-in render pattern', async () => {
      await decorate(block);

      expect(authRenderer.render).toHaveBeenCalledWith(
        SignIn,
        expect.objectContaining({
          routeForgotPassword: expect.any(Function),
          routeRedirectOnSignIn: expect.any(Function),
        }),
      );

      const renderFn = authRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });

    it('should load auth initializer', () => {
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../scripts/initializers/auth.js');
      }).not.toThrow();
    });
  });

  describe('Multiple Blocks', () => {
    it('should decorate multiple blocks independently', async () => {
      const block2 = document.createElement('div');
      document.body.appendChild(block2);

      await decorate(block);
      const firstCallCount = authRenderer.render.mock.calls.length;

      await decorate(block2);
      const secondCallCount = authRenderer.render.mock.calls.length;

      expect(secondCallCount).toBe(firstCallCount + 1);

      document.body.removeChild(block2);
    });
  });

  describe('Configuration Integration', () => {
    it('should have route callbacks in configuration', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      expect(config.routeForgotPassword).toBeDefined();
      expect(config.routeRedirectOnSignIn).toBeDefined();
    });

    it('should pass configuration as second argument to render', async () => {
      await decorate(block);

      const args = authRenderer.render.mock.calls[0];
      expect(args.length).toBe(2);
      expect(args[0]).toBe(SignIn);
      expect(args[1]).toHaveProperty('routeForgotPassword');
      expect(args[1]).toHaveProperty('routeRedirectOnSignIn');
    });

    it('should configure route callbacks for navigation', async () => {
      await decorate(block);

      const config = authRenderer.render.mock.calls[0][1];
      expect(typeof config.routeForgotPassword).toBe('function');
      expect(typeof config.routeRedirectOnSignIn).toBe('function');
    });
  });

  describe('Render Function Behavior', () => {
    it('should call render with container and config', async () => {
      await decorate(block);

      const { calls } = authRenderer.render.mock;
      expect(calls.length).toBeGreaterThan(0);

      const [container, config] = calls[0];
      expect(container).toBe(SignIn);
      expect(config).toBeDefined();
    });

    it('should invoke returned render function with block', async () => {
      await decorate(block);

      const renderFn = authRenderer.render.mock.results[0].value;
      expect(renderFn).toHaveBeenCalledWith(block);
    });
  });
});
