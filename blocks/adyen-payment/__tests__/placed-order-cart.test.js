/**
 * Tests that the wallet handlers record the cart they place an order from. placeOrder resets
 * the cart, and order-result and donations authenticate a guest against the placed cart, so
 * without this record they are sent with no cartId and answer 401.
 */

import { placeOrder } from '@dropins/storefront-order/api.js';
import { adyenFetch } from '../../../scripts/adyen-auth.js';
import {
  createDefaultOnAdditionalDetails,
  createDefaultOnPaymentCompleted,
} from '../handlers.js';
import {
  getPlacedOrderCartId,
  setPaymentResult,
  setPlacedOrderCartId,
  clearPaymentResult,
} from '../state.js';

jest.mock('@dropins/tools/event-bus.js', () => ({
  events: {
    on: jest.fn(), off: jest.fn(), emit: jest.fn(), lastPayload: jest.fn(),
  },
}));
jest.mock('@dropins/storefront-order/api.js', () => ({
  placeOrder: jest.fn(),
  cancelOrder: jest.fn(),
  requestGuestOrderCancel: jest.fn(),
}));
jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('@dropins/storefront-checkout/api.js', () => ({ setPaymentMethod: jest.fn() }));
jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));

const BASE_URL = 'https://backend.example.com/api/v1/web/adyen/';
const CART_ID = 'wallet-cart-abc';
const ORDER = { number: '000001234', token: 'order-token' };

let cartIdSeenByPlaceOrder;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  clearPaymentResult();
  setPlacedOrderCartId(null);
  cartIdSeenByPlaceOrder = undefined;
  placeOrder.mockImplementation(() => {
    cartIdSeenByPlaceOrder = getPlacedOrderCartId();
    return Promise.resolve(ORDER);
  });
});

describe('placed order cart', () => {
  it('is recorded by onPaymentCompleted before it places the order (Google Pay, Apple Pay)', async () => {
    setPaymentResult({ pspReference: 'PSP1', resultCode: 'Authorised', paymentMethod: { type: 'googlepay' } });
    const onPaymentCompleted = createDefaultOnPaymentCompleted(BASE_URL, () => ({ id: CART_ID }));

    await onPaymentCompleted({ resultCode: 'Authorised' }, { props: {} });

    expect(placeOrder).toHaveBeenCalledWith(CART_ID);
    expect(cartIdSeenByPlaceOrder).toBe(CART_ID);
    expect(getPlacedOrderCartId()).toBe(CART_ID);
  });

  it('is recorded by onAdditionalDetails before it places the order (PayPal)', async () => {
    adyenFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ resultCode: 'Authorised', pspReference: 'PSP2', paymentMethod: { type: 'paypal' } }),
    });
    const onAdditionalDetails = createDefaultOnAdditionalDetails(BASE_URL, () => ({ id: CART_ID }));
    const actions = { resolve: jest.fn(), reject: jest.fn() };

    await onAdditionalDetails({ data: { details: {}, paymentData: 'pd' } }, { props: {} }, actions);

    expect(placeOrder).toHaveBeenCalledWith(CART_ID);
    expect(cartIdSeenByPlaceOrder).toBe(CART_ID);
    expect(actions.resolve).toHaveBeenCalled();
  });
});
