/**
 * Express Checkout addToCart Tests
 *
 * Covers the duplicate-add regression: the PDP express-checkout buttons (Apple Pay,
 * Google Pay, PayPal) all share addToCart()/hasAddedToCart() from this module. Those
 * guards only remembered what THIS module itself had added during the page session —
 * if the shopper already added the SKU via the page's own "Add to Cart" control first,
 * addedToCartSkus was still empty, so addToCart() called addProductsToCart again and
 * doubled the cart line quantity. That put a different total in the real cart than the
 * amount actually authorized via Adyen (computed once, early, from the PDP unit price),
 * and the mismatch led to the order being cancelled.
 */

const mockAddProductsToCart = jest.fn();
const mockGetCartDataFromCache = jest.fn();

jest.mock('@dropins/storefront-cart/api.js', () => ({
  createGuestCart: jest.fn(),
  getCartDataFromCache: (...args) => mockGetCartDataFromCache(...args),
  getCustomerCartPayload: jest.fn(),
  addProductsToCart: (...args) => mockAddProductsToCart(...args),
}));

jest.mock('@dropins/storefront-checkout/api.js', () => ({
  estimateShippingMethods: jest.fn(),
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

jest.mock('../../scripts/commerce.js', () => ({
  waitForAuthState: jest.fn(),
  CORE_FETCH_GRAPHQL: jest.fn(),
}));

jest.mock('./cache.js', () => ({
  get: jest.fn(),
  invalidate: jest.fn(),
}));

jest.mock('./circuit-breaker.js', () => ({
  getCircuitBreaker: jest.fn(() => ({})),
}));

jest.mock('./nr-events.js', () => ({
  nrEventBatcher: {},
}));

// eslint-disable-next-line import/first
import { addToCart, hasAddedToCart } from './cart.js';

describe('addToCart — duplicate-add guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddProductsToCart.mockResolvedValue(undefined);
    mockGetCartDataFromCache.mockReturnValue(null);
  });

  it('adds the SKU when the cart is empty', async () => {
    mockGetCartDataFromCache.mockReturnValue({ items: [] });

    await addToCart('sku-1', 1);

    expect(mockAddProductsToCart).toHaveBeenCalledWith([{ sku: 'sku-1', quantity: 1 }]);
    expect(hasAddedToCart('sku-1')).toBe(true);
  });

  it('does not re-add a SKU the shopper already added via a different control', async () => {
    mockGetCartDataFromCache.mockReturnValue({ items: [{ sku: 'sku-2', quantity: 1 }] });

    await addToCart('sku-2', 1);

    expect(mockAddProductsToCart).not.toHaveBeenCalled();
    expect(hasAddedToCart('sku-2')).toBe(true);
  });

  it('matches a cached cart line nested under item.product.sku', async () => {
    mockGetCartDataFromCache.mockReturnValue({
      items: [{ product: { sku: 'sku-3' }, quantity: 1 }],
    });

    await addToCart('sku-3', 1);

    expect(mockAddProductsToCart).not.toHaveBeenCalled();
  });

  it('matches a cached cart line nested under item.configurableProduct.sku', async () => {
    mockGetCartDataFromCache.mockReturnValue({
      items: [{ configurableProduct: { sku: 'sku-4' }, quantity: 1 }],
    });

    await addToCart('sku-4', 1);

    expect(mockAddProductsToCart).not.toHaveBeenCalled();
  });

  it('still only adds once across repeated calls in the same session (existing guard)', async () => {
    mockGetCartDataFromCache.mockReturnValue({ items: [] });

    await addToCart('sku-5', 1);
    await addToCart('sku-5', 1);

    expect(mockAddProductsToCart).toHaveBeenCalledTimes(1);
  });

  it('proceeds with the add when the cache read itself is unavailable', async () => {
    mockGetCartDataFromCache.mockReturnValue(undefined);

    await addToCart('sku-6', 1);

    expect(mockAddProductsToCart).toHaveBeenCalledWith([{ sku: 'sku-6', quantity: 1 }]);
  });
});
