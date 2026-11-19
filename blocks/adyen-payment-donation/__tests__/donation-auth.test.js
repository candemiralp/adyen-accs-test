/**
 * Tests that the donation requests carry the shopper's auth context. The backend binds a guest
 * token to the cart the order was placed from, so /donations must be sent with that cartId, both
 * to mint the token and in the request body.
 */

import { adyenFetch } from '../../../scripts/adyen-auth.js';
import { getUserTokenCookie } from '../../../scripts/initializers/index.js';
import { getLastPlacedOrderCartId } from '../../commerce-checkout/commerce-checkout.js';
import { mountDonationComponent } from '../adyen-payment-donation.js';

jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn(() => 'default') }));
jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));
jest.mock('../../../scripts/initializers/index.js', () => ({ getUserTokenCookie: jest.fn() }));
jest.mock('../../commerce-checkout/commerce-checkout.js', () => ({
  getLastPlacedOrderCartId: jest.fn(),
}));
jest.mock('../../adyen-payment/index.js', () => ({
  getAdyenCheckout: jest.fn(() => Promise.resolve({})),
  getAdyenConfiguration: jest.fn(() => Promise.resolve({ merchantAccount: 'TestMerchant', locale: 'en-US' })),
  getBackendIntegrationUrl: jest.fn(() => 'https://backend.example.com/api/v1/web/adyen/'),
  getPaymentResult: jest.fn(() => Promise.resolve({
    donationToken: 'donation-token',
    pspReference: 'PSP123',
    paymentMethod: { type: 'scheme' },
  })),
}));

const CART_ID = 'placed-cart-abc';
const ORDER = { number: '000001234', email: 'shopper@example.com', grandTotal: { currency: 'USD', value: 50 } };
const CAMPAIGN = { id: 'campaign-1', donation: { type: 'fixedAmounts', values: [100] } };

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let donationProps;

beforeEach(() => {
  jest.clearAllMocks();
  donationProps = null;
  window.AdyenWeb = {
    Donation: jest.fn(function Donation(_checkout, props) {
      donationProps = props;
      this.mount = jest.fn();
      this.unmount = jest.fn();
    }),
  };
  getLastPlacedOrderCartId.mockReturnValue(CART_ID);
  adyenFetch.mockImplementation((url) => Promise.resolve(url.endsWith('/donationCampaigns')
    ? response(200, { donationCampaigns: [CAMPAIGN] })
    : response(200, { status: 'completed' })));
});

async function mountAndDonate() {
  await mountDonationComponent(document.createElement('div'), ORDER);
  // Checkout clears its copy of the placed cart once the success page has rendered,
  // before the shopper gets to click Donate.
  getLastPlacedOrderCartId.mockReturnValue(null);
  const component = { setStatus: jest.fn(), unmount: jest.fn() };
  await donationProps.onDonate({ isValid: true, data: { amount: { currency: 'USD', value: 100 } } }, component);
  return component;
}

function donationsCall() {
  return adyenFetch.mock.calls.find(([url]) => url.endsWith('/donations'));
}

describe('/donations auth context', () => {
  it('sends the placed cartId to mint the guest token and in the body', async () => {
    getUserTokenCookie.mockReturnValue(undefined);

    const component = await mountAndDonate();

    const [, options, authContext] = donationsCall();
    expect(authContext).toEqual(expect.objectContaining({ cartId: CART_ID, isGuest: true }));
    expect(JSON.parse(options.body).cartId).toBe(CART_ID);
    expect(component.setStatus).toHaveBeenLastCalledWith('success');
  });

  it('uses the customer token when the shopper is signed in', async () => {
    getUserTokenCookie.mockReturnValue('customer-token');

    await mountAndDonate();

    const [, , authContext] = donationsCall();
    expect(authContext).toEqual(expect.objectContaining({ cartId: CART_ID, isGuest: false }));
  });
});

describe('/donationCampaigns auth context', () => {
  it('does not mint a guest token for a signed-in shopper', async () => {
    getUserTokenCookie.mockReturnValue('customer-token');

    await mountDonationComponent(document.createElement('div'), ORDER);

    const [, , authContext] = adyenFetch.mock.calls.find(([url]) => url.endsWith('/donationCampaigns'));
    expect(authContext).toEqual(expect.objectContaining({ cartId: CART_ID, isGuest: false }));
  });
});
