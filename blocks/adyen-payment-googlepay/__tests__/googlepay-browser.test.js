/**
 * Tests that the checkout Google Pay block is not hidden by browser. Google Pay runs in Safari
 * and Firefox too, so the component's isAvailable() decides.
 */

import { showError } from '../../adyen-payment/utils.js';
import decorate from '../adyen-payment-googlepay.js';

jest.mock('../../adyen-payment/utils.js', () => ({
  showLoading: jest.fn(),
  hideLoading: jest.fn(),
  showError: jest.fn(),
  clearError: jest.fn(),
}));
jest.mock('../../adyen-payment/index.js', () => ({
  getAdyenCheckout: jest.fn(() => Promise.resolve({})),
  setActiveComponent: jest.fn(),
  validateCheckoutForms: jest.fn(() => true),
}));

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0';

let googlePay;

function mockGooglePay(isAvailable) {
  window.AdyenWeb = {
    GooglePay: jest.fn(function GooglePay() {
      googlePay = this;
      this.isAvailable = jest.fn(isAvailable);
      this.mount = jest.fn();
    }),
  };
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  jest.clearAllMocks();
  googlePay = null;
});

describe.each([['Safari', SAFARI_UA], ['Firefox', FIREFOX_UA]])('checkout Google Pay block in %s', (_, ua) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  });

  it('mounts Google Pay when isAvailable() resolves', async () => {
    mockGooglePay(() => Promise.resolve());
    const block = document.createElement('div');

    await decorate(block);
    await flush();

    expect(googlePay.mount).toHaveBeenCalled();
  });

  it('tells the shopper to choose another method when isAvailable() rejects', async () => {
    mockGooglePay(() => Promise.reject(new Error('not available')));
    const block = document.createElement('div');

    await decorate(block);
    await flush();

    expect(googlePay.mount).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('choose another payment method'),
    );
  });
});
