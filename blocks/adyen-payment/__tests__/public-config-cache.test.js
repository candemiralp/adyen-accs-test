/**
 * Tests that only a usable public configuration is cached. The cache lasts 24 hours, so caching
 * an error body would leave the shopper unable to pay for a day after one failed request.
 */
import { adyenFetch } from '../../../scripts/adyen-auth.js';
import { fetchPublicConfiguration } from '../config.js';

jest.mock('@dropins/storefront-checkout/api.js', () => ({ getStoreConfigCache: jest.fn() }));
jest.mock('@dropins/storefront-cart/api.js', () => ({ fetchGraphQl: jest.fn() }));
jest.mock('@dropins/tools/event-bus.js', () => ({
  events: { on: jest.fn(), emit: jest.fn(), lastPayload: jest.fn() },
}));
jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));

const BACKEND = 'https://backend.example/';
const CONFIG = {
  clientKey: 'test_CLIENTKEY', environment: 'test', merchantAccount: 'M', returnUrl: 'r',
};

const respond = (ok, status, body) => adyenFetch.mockResolvedValueOnce({
  ok, status, json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('fetchPublicConfiguration caching', () => {
  it('caches a successful configuration and serves it from the cache next time', async () => {
    respond(true, 200, CONFIG);

    await expect(fetchPublicConfiguration(BACKEND, 'default')).resolves.toEqual(CONFIG);
    await expect(fetchPublicConfiguration(BACKEND, 'default')).resolves.toEqual(CONFIG);

    expect(adyenFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, { error: 'Unauthorized' }],
    [500, { error: 'Configuration not found.' }],
  ])('does not cache a %s response', async (status, body) => {
    respond(false, status, body);
    respond(true, 200, CONFIG);

    await fetchPublicConfiguration(BACKEND, 'default');
    await expect(fetchPublicConfiguration(BACKEND, 'default')).resolves.toEqual(CONFIG);

    expect(adyenFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a successful response that carries no clientKey', async () => {
    respond(true, 200, { environment: 'test' });
    respond(true, 200, CONFIG);

    await fetchPublicConfiguration(BACKEND, 'default');
    await expect(fetchPublicConfiguration(BACKEND, 'default')).resolves.toEqual(CONFIG);
  });

  it('ignores an error body an earlier version left in the cache', async () => {
    localStorage.setItem('adyen_public_configuration', JSON.stringify({
      value: { error: 'Unauthorized' },
      ':expiry': Math.round(Date.now() / 1000) + 3600,
    }));
    respond(true, 200, CONFIG);

    await expect(fetchPublicConfiguration(BACKEND, 'default')).resolves.toEqual(CONFIG);
    expect(adyenFetch).toHaveBeenCalledTimes(1);
  });
});
