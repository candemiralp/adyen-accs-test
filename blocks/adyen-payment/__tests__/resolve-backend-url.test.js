/**
 * resolveBackendUrl must take the backend URL from this site's own configuration,
 * never from a constant compiled into the block: a constant would send every
 * storefront's shopper traffic to whichever backend it happened to name.
 */
import { fetchGraphQl } from '@dropins/storefront-cart/api.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { resolveBackendUrl } from '../config.js';

jest.mock('@dropins/storefront-checkout/api.js', () => ({ getStoreConfigCache: jest.fn() }));
jest.mock('@dropins/storefront-cart/api.js', () => ({ fetchGraphQl: jest.fn() }));
jest.mock('@dropins/tools/event-bus.js', () => ({
  events: { on: jest.fn(), emit: jest.fn(), lastPayload: jest.fn() },
}));
jest.mock('@dropins/tools/lib/aem/configs.js', () => ({ getConfigValue: jest.fn() }));
jest.mock('../storage.js', () => ({
  STORAGE_KEYS: { INTEGRATION_URL: 'integration-url' },
  STORAGE_TTL: { INTEGRATION_URL: 1000 },
  removeItem: jest.fn(),
  getWithExpiry: jest.fn(() => null),
  setWithExpiry: jest.fn(),
}));
jest.mock('../../../scripts/adyen-auth.js', () => ({ adyenFetch: jest.fn() }));

const config = (values) => {
  getConfigValue.mockImplementation((key) => values[key]);
};

describe('resolveBackendUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Commerce surfaces no OOPE backend URL for the cart unless a test says otherwise.
    fetchGraphQl.mockResolvedValue({ data: { cart: { available_payment_methods: [] } } });
  });

  afterEach(() => {
    console.warn.mockRestore();
  });

  it('prefers the backend URL Commerce returns for the cart', async () => {
    fetchGraphQl.mockResolvedValue({
      data: {
        cart: {
          available_payment_methods: [
            { code: 'adyen_cc', oope_payment_method_config: { backend_integration_url: 'https://from-commerce/' } },
          ],
        },
      },
    });
    config({ 'adyen-backend-integration': 'https://from-config/' });

    await expect(resolveBackendUrl('cart-1', true)).resolves.toBe('https://from-commerce/');
  });

  it('falls back to adyen-backend-integration in config.json', async () => {
    config({ 'adyen-backend-integration': 'https://integration-key/', 'adyen-backend-url': 'https://url-key/' });

    await expect(resolveBackendUrl('cart-1', true)).resolves.toBe('https://integration-key/');
  });

  it('accepts adyen-backend-url, the key existing storefront configurations carry', async () => {
    config({ 'adyen-backend-url': 'https://url-key/' });

    await expect(resolveBackendUrl('cart-1', true)).resolves.toBe('https://url-key/');
  });

  it('resolves to nothing, rather than a built-in URL, when no configuration names a backend', async () => {
    config({});

    await expect(resolveBackendUrl('cart-1', true)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('adyen-backend-url'));
  });
});
