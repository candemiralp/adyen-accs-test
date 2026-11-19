/**
 * Tests that checkout only forwards a stored payment result as a pre-order payment when it
 * records a completed payment for the cart being placed. The stored result survives in
 * localStorage, so a declined attempt or another cart's payment must never be presented as this
 * order's payment.
 */

import {
  getCompletedPaymentResultForCart,
  setPaymentResult,
  clearPaymentResult,
} from '../state.js';

const CART_ID = 'cart-being-placed';

const completed = {
  pspReference: 'PSP-COMPLETED',
  resultCode: 'Authorised',
  cartId: CART_ID,
};

beforeEach(() => {
  clearPaymentResult();
  localStorage.clear();
});

describe('getCompletedPaymentResultForCart', () => {
  it('returns a completed payment written for this cart', () => {
    setPaymentResult(completed);

    expect(getCompletedPaymentResultForCart(CART_ID)).toEqual(completed);
  });

  it.each(['Pending', 'Received'])('accepts a %s payment, which the backend also accepts', (resultCode) => {
    setPaymentResult({ ...completed, resultCode });

    expect(getCompletedPaymentResultForCart(CART_ID)?.pspReference).toBe('PSP-COMPLETED');
  });

  it('ignores a payment written for another cart', () => {
    setPaymentResult({ ...completed, cartId: 'another-cart' });

    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });

  it('ignores a result that records no cart at all', () => {
    const { cartId, ...withoutCart } = completed;
    setPaymentResult(withoutCart);

    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });

  it.each(['Cancelled', 'Refused', 'Error'])('ignores an earlier %s attempt on the same cart', (resultCode) => {
    // A declined card leaves its pspReference behind; retrying on the same cart must not claim it.
    setPaymentResult({ ...completed, resultCode });

    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });

  it('ignores a payment still waiting on an action', () => {
    setPaymentResult({ ...completed, action: { type: 'threeDS2' } });

    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });

  it('ignores a result without a pspReference', () => {
    setPaymentResult({ ...completed, pspReference: undefined });

    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });

  it('returns nothing when no cart is given', () => {
    setPaymentResult(completed);

    expect(getCompletedPaymentResultForCart(undefined)).toBeNull();
  });

  it('returns nothing when no result is stored', () => {
    expect(getCompletedPaymentResultForCart(CART_ID)).toBeNull();
  });
});
