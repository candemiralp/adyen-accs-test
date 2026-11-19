/**
 * Tests for the Adyen redirect return (client-side flow: Klarna, Affirm, iDEAL, ...)
 */

// redirect.js caches the payment result in module state, as a real page load starts fresh.
// Each test loads its own copy of the module (and of its mocks) so that cache starts empty.
let placeOrder;
let checkoutApi;
let adyenFetch;
let handleAdyenRedirect;
let sanitizeRedirectState;

jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    // The redirect handler waits for checkout/initialized; resolve it straight away.
    on: jest.fn((name, callback) => {
      if (name === 'checkout/initialized') callback();
    }),
  },
}));

jest.mock('@dropins/storefront-order/api.js', () => ({
  placeOrder: jest.fn(),
}));

jest.mock('@dropins/storefront-checkout/api.js', () => ({
  setPaymentMethod: jest.fn(),
}));

jest.mock('../../../scripts/initializers/index.js', () => ({
  getUserTokenCookie: jest.fn(() => undefined),
}));

jest.mock('../../../scripts/commerce.js', () => ({
  rootLink: jest.fn((path) => path),
}));

jest.mock('../../../scripts/initializers/checkout.js', () => ({}));

jest.mock('../../../scripts/adyen-auth.js', () => ({
  adyenFetch: jest.fn(),
}));

const CART_ID = 'masked-cart-abc';
const ORDER = {
  number: '000001234', email: 'shopper@example.com', token: 'order-token', id: 1234,
};

function storedPaymentResult(overrides = {}) {
  return {
    resultCode: 'RedirectShopper',
    paymentMethod: { type: 'klarna' },
    cartId: CART_ID,
    stateData: { paymentMethod: { type: 'klarna', checkoutAttemptId: 'attempt-1' } },
    ...overrides,
  };
}

function seedStorage(paymentResult) {
  window.localStorage.clear();
  window.localStorage.setItem('adyen_integration_url', JSON.stringify({
    value: 'https://backend.example.com/api/v1/web/adyen/',
    ':expiry': Math.round(Date.now() / 1000) + 3600,
  }));
  window.localStorage.setItem('adyen_redirect_payment_code', 'adyen_klarna');
  if (paymentResult) {
    window.localStorage.setItem('adyen_payment_result', JSON.stringify(paymentResult));
  }
}

function orderResultResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function setReturnUrl(query) {
  window.history.pushState({}, '', `/adyen-redirect?${query}`);
}

function sentAdditionalData() {
  return checkoutApi.setPaymentMethod.mock.calls[0][0].additional_data;
}

beforeEach(() => {
  jest.resetModules();
  ({ placeOrder } = require('@dropins/storefront-order/api.js'));
  checkoutApi = require('@dropins/storefront-checkout/api.js');
  ({ adyenFetch } = require('../../../scripts/adyen-auth.js'));
  ({ handleAdyenRedirect, sanitizeRedirectState } = require('../redirect.js'));
  seedStorage(storedPaymentResult());
  setReturnUrl('redirectResult=abc123');
  placeOrder.mockResolvedValue(ORDER);
  checkoutApi.setPaymentMethod.mockResolvedValue({});
});

describe('handleAdyenRedirect — client-side flow', () => {
  const removeOverlaySpinner = jest.fn();

  it('reports a declined payment instead of success when the backend recorded a failure', async () => {
    adyenFetch.mockResolvedValue(orderResultResponse(200, { resultCode: 'Error' }));

    const result = await handleAdyenRedirect({ removeOverlaySpinner });

    expect(placeOrder).toHaveBeenCalledWith(CART_ID);
    expect(result).toMatchObject({
      success: false, paymentDeclined: true, resultCode: 'Error', cartId: CART_ID, orderData: ORDER,
    });
  });

  it('asks order-result about the order just placed, bound to its cart and order token', async () => {
    adyenFetch.mockResolvedValue(orderResultResponse(200, { resultCode: 'Authorised' }));

    await handleAdyenRedirect({ removeOverlaySpinner });

    const [endpoint, init, authContext] = adyenFetch.mock.calls[0];
    expect(endpoint).toBe('https://backend.example.com/api/v1/web/adyen/order-result');
    expect(JSON.parse(init.body)).toEqual({
      incrementId: ORDER.number,
      customerEmail: ORDER.email,
      cartId: CART_ID,
      orderToken: ORDER.token,
    });
    expect(authContext).toMatchObject({ cartId: CART_ID, isGuest: true });
  });

  it('shows success when the backend recorded an authorisation', async () => {
    adyenFetch.mockResolvedValue(orderResultResponse(200, { resultCode: 'Authorised' }));

    const result = await handleAdyenRedirect({ removeOverlaySpinner });

    expect(result).toEqual({ success: true, orderData: ORDER });
  });

  it('falls back to success when the payment result cannot be read', async () => {
    adyenFetch.mockResolvedValue(orderResultResponse(401, { error: 'Unauthorized' }));

    const result = await handleAdyenRedirect({ removeOverlaySpinner });

    expect(result).toEqual({ success: true, orderData: ORDER });
  });

  it('does not place an order when no payment result was stored before the redirect', async () => {
    seedStorage(null);

    const result = await handleAdyenRedirect({ removeOverlaySpinner });

    expect(placeOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, redirect: '/checkout' });
  });

  it('does not place an order when the URL cartId disagrees with the stored cart', async () => {
    setReturnUrl('redirectResult=abc123&cartId=someone-elses-cart');

    const result = await handleAdyenRedirect({ removeOverlaySpinner });

    expect(placeOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, redirect: '/checkout' });
  });

  it('never sends a stored-card state alongside the redirect details', async () => {
    seedStorage(storedPaymentResult({
      stateData: { paymentMethod: { type: 'scheme', storedPaymentMethodId: 'stored-card-1' } },
    }));
    adyenFetch.mockResolvedValue(orderResultResponse(200, { resultCode: 'Authorised' }));

    await handleAdyenRedirect({ removeOverlaySpinner });

    const keys = sentAdditionalData().map(({ key }) => key);
    expect(keys).toContain('details');
    expect(keys).not.toContain('state');
  });

  it('still sends the redirect method state that Commerce checks for availability', async () => {
    adyenFetch.mockResolvedValue(orderResultResponse(200, { resultCode: 'Authorised' }));

    await handleAdyenRedirect({ removeOverlaySpinner });

    const state = sentAdditionalData().find(({ key }) => key === 'state');
    expect(JSON.parse(state.value)).toEqual({
      paymentMethod: { type: 'klarna', checkoutAttemptId: 'attempt-1' },
    });
  });
});

describe('sanitizeRedirectState', () => {
  it('drops scheme and stored-card state entirely', () => {
    expect(sanitizeRedirectState({ paymentMethod: { type: 'scheme', encryptedCardNumber: 'x' } })).toBeUndefined();
    expect(sanitizeRedirectState({ paymentMethod: { type: 'paypal', storedPaymentMethodId: 's1' } })).toBeUndefined();
    expect(sanitizeRedirectState(undefined)).toBeUndefined();
  });

  it('strips encrypted and recurring fields from other payment methods', () => {
    const result = sanitizeRedirectState({
      paymentMethod: {
        type: 'klarna', encryptedSecurityCode: 'x', recurringDetailReference: 'r1', checkoutAttemptId: 'a',
      },
      browserInfo: { language: 'en-US' },
    });

    expect(result).toEqual({
      paymentMethod: { type: 'klarna', checkoutAttemptId: 'a' },
      browserInfo: { language: 'en-US' },
    });
  });
});
