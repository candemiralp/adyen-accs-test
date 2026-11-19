/**
 * The browser console is readable by anything running on the page and is routinely pasted into
 * support tickets, so no part of a bearer token may be written to it.
 */
import { adyenFetch } from '../../../scripts/adyen-auth.js';
import { CORE_FETCH_GRAPHQL } from '../../../scripts/commerce.js';

jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../../../scripts/commerce.js', () => ({
  CORE_FETCH_GRAPHQL: { getFetchGraphQlHeader: jest.fn() },
}));

const GUEST_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.GUESTPAYLOADGUESTPAYLOAD.GUESTSIGNATURE';
const CUSTOMER_TOKEN = 'eyJraWQiOiIxIiwiYWxnIjoiSFMyNTYifQ.CUSTOMERPAYLOADCUSTOMER.CUSTOMERSIGNATURE';

const consoleMethods = ['debug', 'info', 'log', 'warn', 'error'];

function everythingLogged() {
  return consoleMethods
    .flatMap((method) => console[method].mock.calls)
    .map((args) => JSON.stringify(args))
    .join('\n');
}

beforeEach(() => {
  consoleMethods.forEach((method) => jest.spyOn(console, method).mockImplementation(() => {}));
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/guest-token') ? { token: GUEST_TOKEN, expiresIn: 300 } : {}),
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('adyenFetch never logs a bearer token', () => {
  it('logs no part of a guest token', async () => {
    await adyenFetch('https://backend.example/payments', {}, {
      backendUrl: 'https://backend.example/',
      cartId: 'guest-cart',
      isGuest: true,
    });

    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://backend.example/payments',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${GUEST_TOKEN}` }) }),
    );
    expect(everythingLogged()).not.toContain(GUEST_TOKEN.substring(0, 20));
  });

  it("logs no part of a signed-in customer's Commerce token", async () => {
    CORE_FETCH_GRAPHQL.getFetchGraphQlHeader.mockReturnValue(`Bearer ${CUSTOMER_TOKEN}`);

    await adyenFetch('https://backend.example/payments', {}, {
      backendUrl: 'https://backend.example/',
      cartId: 'customer-cart',
      isGuest: false,
    });

    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://backend.example/payments',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${CUSTOMER_TOKEN}` }) }),
    );
    expect(everythingLogged()).not.toContain(CUSTOMER_TOKEN.substring(0, 20));
  });
});
