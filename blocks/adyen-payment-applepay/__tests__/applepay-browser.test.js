/**
 * Tests that the checkout Apple Pay block is not hidden by browser. Adyen Web loads Apple's SDK,
 * which also runs outside Safari, so the component's isAvailable() decides.
 */

import { showError } from '../../adyen-payment/utils.js';
import decorate from '../adyen-payment-applepay.js';

jest.mock('../../adyen-payment/utils.js', () => ({
  showLoading: jest.fn(),
  hideLoading: jest.fn(),
  showError: jest.fn(),
  clearError: jest.fn(),
}));
jest.mock('../../adyen-payment/index.js', () => ({
  getAdyenCheckout: jest.fn(() => Promise.resolve({})),
  getAdyenConfiguration: jest.fn(() => Promise.resolve({
    paymentMethodsResponse: { paymentMethods: [{ type: 'applepay', configuration: { merchantId: 'm' } }] },
  })),
  setActiveComponent: jest.fn(),
}));

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

let applePay;

function mockApplePay(isAvailable) {
  window.AdyenWeb = {
    ApplePay: jest.fn(function ApplePay() {
      applePay = this;
      this.isAvailable = jest.fn(isAvailable);
      this.mount = jest.fn();
    }),
  };
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  jest.clearAllMocks();
  applePay = null;
  Object.defineProperty(window.navigator, 'userAgent', { value: CHROME_UA, configurable: true });
});

describe('checkout Apple Pay block in Chrome', () => {
  it('mounts Apple Pay when isAvailable() resolves', async () => {
    mockApplePay(() => Promise.resolve());
    const block = document.createElement('div');

    await decorate(block);
    await flush();

    expect(block.style.display).not.toBe('none');
    expect(window.AdyenWeb.ApplePay).toHaveBeenCalled();
    expect(applePay.mount).toHaveBeenCalled();
  });

  it('tells the shopper to choose another method when isAvailable() rejects', async () => {
    mockApplePay(() => Promise.reject(new Error('not available')));
    const block = document.createElement('div');

    await decorate(block);
    await flush();

    expect(applePay.mount).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('choose another payment method'),
    );
  });
});
