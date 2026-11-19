/**
 * Tests for cart recovery when the order belongs to a customer account:
 * recover-cart answers 403 login_required to anything but that customer's token.
 */

import { adyenFetch } from '../../../scripts/adyen-auth.js';
import { getUserTokenCookie } from '../../../scripts/initializers/index.js';
import { recoverCart, resumePendingRecovery, setPaymentResult } from '../index.js';
import { STORAGE_KEYS } from '../storage.js';

jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    on: jest.fn(), off: jest.fn(), emit: jest.fn(), lastPayload: jest.fn(),
  },
}));
jest.mock('@dropins/storefront-checkout/api.js', () => ({ getStoreConfigCache: jest.fn() }));
jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../../../scripts/aem.js', () => ({ loadCSS: jest.fn() }));
jest.mock('../utils.js', () => ({
  getAdyenCheckoutFactory: jest.fn(),
  loadAdyenWebSDK: jest.fn(),
}));
jest.mock('../handlers.js', () => ({
  manualSubmit: jest.fn(),
  createDefaultOnSubmit: jest.fn(),
  createDefaultOnAdditionalDetails: jest.fn(),
  createDefaultOnPaymentCompleted: jest.fn(),
  waitForOnSubmitResult: jest.fn(),
  setHandlePlaceOrderActive: jest.fn(),
}));
jest.mock('../config.js', () => ({
  getBackendIntegrationUrl: jest.fn(() => 'https://backend.example.com/api/v1/web/adyen/'),
  fetchPublicConfiguration: jest.fn(),
  fetchPaymentMethods: jest.fn(),
  buildStaticConfig: jest.fn(),
  buildBaseConfiguration: jest.fn(),
}));
jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));
jest.mock('../../../scripts/initializers/index.js', () => ({ getUserTokenCookie: jest.fn() }));
jest.mock('../../../scripts/commerce.js', () => ({
  rootLink: jest.fn((path) => path),
  CUSTOMER_LOGIN_PATH: '/customer/login',
}));

const CART_ID = 'masked-cart-abc';
const PENDING = {
  incrementId: '000001234',
  email: 'customer@example.com',
  resultCode: 'Refused',
  orderToken: 'order-token',
  orderId: 1234,
  comment: 'Payment declined by Adyen: Refused',
  cartId: CART_ID,
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function pendingRecovery() {
  const stored = window.sessionStorage.getItem(STORAGE_KEYS.PENDING_RECOVERY);
  return stored ? JSON.parse(stored) : null;
}

let nav;

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  setPaymentResult({ cartId: CART_ID });
  nav = { navigate: jest.fn(), reload: jest.fn() };
});

describe('recoverCart', () => {
  it('sends the customer token when the shopper is signed in', async () => {
    getUserTokenCookie.mockReturnValue('customer-token');
    adyenFetch.mockResolvedValue(response(200, { newCartId: 'new-cart' }));

    await recoverCart(PENDING.incrementId, PENDING.email, 'Refused');

    const authContext = adyenFetch.mock.calls[0][2];
    expect(authContext).toMatchObject({ cartId: CART_ID, isGuest: false });
  });

  it('keeps the recovery for after sign-in when the backend answers login_required', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    adyenFetch.mockResolvedValue(response(403, { error: 'login_required' }));

    const result = await recoverCart(PENDING.incrementId, PENDING.email, PENDING.resultCode, {
      orderToken: PENDING.orderToken, orderId: PENDING.orderId, comment: PENDING.comment,
    });

    expect(result).toBeNull();
    expect(pendingRecovery()).toEqual(PENDING);
  });

  it('still accepts the older 401 login_required answer, so the backend can deploy first or last', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    adyenFetch.mockResolvedValue(response(401, { error: 'Unauthorized', reason: 'login_required' }));

    const result = await recoverCart(PENDING.incrementId, PENDING.email, PENDING.resultCode, {
      orderToken: PENDING.orderToken, orderId: PENDING.orderId, comment: PENDING.comment,
    });

    expect(result).toBeNull();
    expect(pendingRecovery()).toEqual(PENDING);
  });

  it('does not keep anything for a plain 403', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    adyenFetch.mockResolvedValue(response(403, { error: 'Forbidden' }));

    await expect(recoverCart(PENDING.incrementId, PENDING.email, 'Refused')).resolves.toBeNull();

    expect(pendingRecovery()).toBeNull();
  });

  it('does not keep anything for a plain 401', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    adyenFetch.mockResolvedValue(response(401, { error: 'Unauthorized' }));

    await expect(recoverCart(PENDING.incrementId, PENDING.email, 'Refused')).resolves.toBeNull();
    expect(pendingRecovery()).toBeNull();
  });
});

describe('resumePendingRecovery', () => {
  function seedPending(extra = {}) {
    window.sessionStorage.setItem(STORAGE_KEYS.PENDING_RECOVERY, JSON.stringify({ ...PENDING, ...extra }));
  }

  it('does nothing when no recovery is pending', async () => {
    await expect(resumePendingRecovery(nav)).resolves.toBe(false);
    expect(adyenFetch).not.toHaveBeenCalled();
  });

  it('sends a signed-out shopper to sign in, returning to checkout', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    seedPending();

    await expect(resumePendingRecovery(nav)).resolves.toBe(true);

    expect(nav.navigate).toHaveBeenCalledWith('/customer/login?returnTo=%2Fcheckout');
    expect(pendingRecovery()).toMatchObject({ promptedSignIn: true });
    expect(adyenFetch).not.toHaveBeenCalled();
  });

  it('gives up rather than looping when the shopper came back without signing in', async () => {
    getUserTokenCookie.mockReturnValue(undefined);
    seedPending({ promptedSignIn: true });

    await expect(resumePendingRecovery(nav)).resolves.toBe(false);

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(pendingRecovery()).toBeNull();
  });

  it('replays the recovery with the customer token once signed in, then reloads', async () => {
    getUserTokenCookie.mockReturnValue('customer-token');
    seedPending({ promptedSignIn: true });
    adyenFetch.mockResolvedValue(response(200, { newCartId: 'new-cart' }));

    await expect(resumePendingRecovery(nav)).resolves.toBe(true);

    const [endpoint, init, authContext] = adyenFetch.mock.calls[0];
    expect(endpoint).toBe('https://backend.example.com/api/v1/web/adyen/recover-cart');
    expect(JSON.parse(init.body)).toMatchObject({
      incrementId: PENDING.incrementId, customerEmail: PENDING.email, cartId: CART_ID,
    });
    expect(authContext).toMatchObject({ isGuest: false, cartId: CART_ID });
    expect(nav.reload).toHaveBeenCalled();
    expect(pendingRecovery()).toBeNull();
  });

  it('replays only once: a second login_required is final', async () => {
    getUserTokenCookie.mockReturnValue('other-customer-token');
    seedPending({ promptedSignIn: true });
    adyenFetch.mockResolvedValue(response(403, { error: 'login_required' }));

    await expect(resumePendingRecovery(nav)).resolves.toBe(false);

    expect(pendingRecovery()).toBeNull();
    expect(nav.reload).not.toHaveBeenCalled();
  });
});
