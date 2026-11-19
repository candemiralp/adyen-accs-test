/**
 * Tests that the checkout wallet buttons validate the checkout forms before their payment sheet
 * opens. Wallets open from their own button, not Place Order, so without onClick they skipped
 * the shipping and billing validation.
 */

import decorateGooglePay from '../../adyen-payment-googlepay/adyen-payment-googlepay.js';
import decoratePayPal from '../../adyen-payment-paypal/adyen-payment-paypal.js';
import decorateApplePay from '../../adyen-payment-applepay/adyen-payment-applepay.js';
import { setCheckoutFormsValidator, validateCheckoutForms } from '../state.js';

jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../utils.js', () => ({
  showLoading: jest.fn(),
  hideLoading: jest.fn(),
  showError: jest.fn(),
  clearError: jest.fn(),
}));
jest.mock('../index.js', () => {
  const state = jest.requireActual('../state.js');
  return {
    getAdyenCheckout: jest.fn(() => Promise.resolve({})),
    getAdyenConfiguration: jest.fn(() => Promise.resolve({
      paymentMethodsResponse: { paymentMethods: [{ type: 'applepay', configuration: {} }] },
    })),
    setActiveComponent: jest.fn(),
    validateCheckoutForms: state.validateCheckoutForms,
  };
});

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

let props;

function mockWallet(name) {
  window.AdyenWeb = {
    [name]: jest.fn(function Wallet(_checkout, componentProps) {
      props = componentProps;
      this.mount = jest.fn();
      this.isAvailable = jest.fn(() => Promise.resolve());
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  props = null;
  setCheckoutFormsValidator(null);
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    configurable: true,
  });
});

describe('validateCheckoutForms', () => {
  it('passes when no checkout validator is registered', () => {
    expect(validateCheckoutForms()).toBe(true);
  });

  it('runs the registered checkout validator', () => {
    const validator = jest.fn(() => false);
    setCheckoutFormsValidator(validator);

    expect(validateCheckoutForms()).toBe(false);
    expect(validator).toHaveBeenCalled();
  });
});

describe.each([
  ['Google Pay', 'GooglePay', decorateGooglePay],
  ['Apple Pay', 'ApplePay', decorateApplePay],
])('%s button', (_label, component, decorate) => {
  it('does not open the sheet when the checkout forms are invalid', async () => {
    mockWallet(component);
    setCheckoutFormsValidator(() => false);
    await decorate(document.createElement('div'));
    await flush();
    const resolve = jest.fn();
    const reject = jest.fn();

    props.onClick(resolve, reject);

    expect(reject).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('opens the sheet when the checkout forms are valid', async () => {
    mockWallet(component);
    setCheckoutFormsValidator(() => true);
    await decorate(document.createElement('div'));
    await flush();
    const resolve = jest.fn();
    const reject = jest.fn();

    props.onClick(resolve, reject);

    expect(resolve).toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});

describe('PayPal button', () => {
  it('does not open PayPal when the checkout forms are invalid', async () => {
    mockWallet('PayPal');
    setCheckoutFormsValidator(() => false);
    await decoratePayPal(document.createElement('div'));
    const actions = { resolve: jest.fn(), reject: jest.fn() };

    props.onClick({}, actions);

    expect(actions.reject).toHaveBeenCalled();
    expect(actions.resolve).not.toHaveBeenCalled();
  });

  it('opens PayPal when the checkout forms are valid', async () => {
    mockWallet('PayPal');
    setCheckoutFormsValidator(() => true);
    await decoratePayPal(document.createElement('div'));
    const actions = { resolve: jest.fn(), reject: jest.fn() };

    props.onClick({}, actions);

    expect(actions.resolve).toHaveBeenCalled();
    expect(actions.reject).not.toHaveBeenCalled();
  });
});
