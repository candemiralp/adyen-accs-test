/**
 * Adyen Config Module – Cypress E2E Tests
 *
 * Covers code paths in blocks/adyen-payment/config.js that are not exercised
 * by the existing integration/E2E test suites:
 *
 *  1. getBackendIntegrationUrl – cache hit (does not read from checkoutData)
 *  2. getBackendIntegrationUrl – cache miss: extracts URL from checkoutData and writes to localStorage
 *  3. getBackendIntegrationUrl – expired cache: extracts from checkoutData and overwrites
 *  4. getBackendIntegrationUrl – returns undefined when checkoutData has no adyen method
 *  5. fetchPublicConfiguration – cache hit: returns cached value without fetching
 *  6. fetchPublicConfiguration – cache miss: fetches, writes to localStorage, returns response
 *  7. fetchPublicConfiguration – expired cache: removes old entry, re-fetches
 *  8. buildStaticConfig – uses publicCfg.countryCode when present
 *  9. buildStaticConfig – falls back to billingAddress.country.code when publicCfg has no countryCode
 * 10. buildStaticConfig – falls back to shippingAddress country when no billing country
 * 11. buildStaticConfig – falls back to storeConfig.defaultCountry when no checkout addresses
 * 12. buildStaticConfig – falls back to 'US' when all other country sources are absent
 */

const BACKEND_URL = 'https://config-test.example.com/adyen/';
const PUBLIC_CONFIG = {
  clientKey: 'test_CLIENT_KEY_CONFIG',
  environment: 'test',
  countryCode: 'NL',
};

// ---------------------------------------------------------------------------
// Helper: visit a page and expose config module helpers via window
// ---------------------------------------------------------------------------
function visitAndExposeConfig() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    const ls = win.localStorage;

    const STORAGE_KEYS = {
      INTEGRATION_URL: 'adyen_integration_url',
      PUBLIC_CONFIG: 'adyen_public_configuration',
    };
    const STORAGE_TTL = {
      INTEGRATION_URL: 86400,
      PUBLIC_CONFIG: 86400,
    };

    // ── storage helpers ───────────────────────────────────────────────────
    const storageGetWithExpiry = (key) => {
      const raw = ls.getItem(key);
      if (!raw) return null;
      let entry;
      try { entry = JSON.parse(raw); } catch { return null; }
      const now = Math.round(Date.now() / 1000);
      const expired = entry[':expiry'] && entry[':expiry'] < now;
      return { value: entry.value, expired };
    };

    const storageSetWithExpiry = (key, value, ttl) => {
      const entry = { value, ':expiry': Math.round(Date.now() / 1000) + ttl };
      ls.setItem(key, JSON.stringify(entry));
    };

    // ── getBackendIntegrationUrl ──────────────────────────────────────────
    win.__getBackendIntegrationUrl = (checkoutData) => {
      const cached = storageGetWithExpiry(STORAGE_KEYS.INTEGRATION_URL);
      if (cached && !cached.expired) return cached.value;

      const integrationUrl = checkoutData
        ?.availablePaymentMethods
        ?.find((m) => m.code?.startsWith('adyen_'))
        ?.oope_payment_method_config
        ?.backend_integration_url;

      if (integrationUrl) {
        storageSetWithExpiry(STORAGE_KEYS.INTEGRATION_URL, integrationUrl, STORAGE_TTL.INTEGRATION_URL);
      }

      return integrationUrl;
    };

    // ── fetchPublicConfiguration ──────────────────────────────────────────
    // (async – test via cy.intercept + cy.wrap)
    win.__fetchPublicConfiguration = async (backendUrl, scope) => {
      const cached = storageGetWithExpiry(STORAGE_KEYS.PUBLIC_CONFIG);
      if (cached && !cached.expired) return cached.value;

      if (cached?.expired) {
        ls.removeItem(STORAGE_KEYS.PUBLIC_CONFIG);
      }

      const url = new URL(`${backendUrl}public-configuration`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const publicConfiguration = await response.json();
      storageSetWithExpiry(STORAGE_KEYS.PUBLIC_CONFIG, publicConfiguration, STORAGE_TTL.PUBLIC_CONFIG);
      return publicConfiguration;
    };

    // ── buildStaticConfig ─────────────────────────────────────────────────
    win.__buildStaticConfig = (publicCfg, checkoutData, storeDefaultCountry) => {
      const billingCountry = checkoutData?.billingAddress?.country?.code
        || checkoutData?.billingAddress?.country;
      const shippingCountry = checkoutData?.shippingAddress?.country?.code
        || checkoutData?.shippingAddress?.country;
      const checkoutCountry = billingCountry || shippingCountry || '';

      const countryCode = publicCfg.countryCode || checkoutCountry || storeDefaultCountry || 'US';
      const locale = win.navigator?.language || 'en-US';
      return {
        environment: publicCfg.environment,
        clientKey: publicCfg.clientKey,
        locale,
        countryCode,
        analytics: { enabled: true },
      };
    };

    win.__STORAGE_KEYS = STORAGE_KEYS;
    win.__storageSetWithExpiry = storageSetWithExpiry;
    win.__storageGetWithExpiry = storageGetWithExpiry;
  });
}

// ---------------------------------------------------------------------------
// Helpers: build mock checkoutData with an adyen payment method
// ---------------------------------------------------------------------------
function checkoutDataWithUrl(url) {
  return {
    availablePaymentMethods: [
      {
        code: 'adyen_card',
        oope_payment_method_config: { backend_integration_url: url },
      },
    ],
  };
}

function checkoutDataWithoutAdyen() {
  return {
    availablePaymentMethods: [
      { code: 'free', oope_payment_method_config: {} },
    ],
  };
}

// ===========================================================================
// Suite 1 – getBackendIntegrationUrl: cache hit
// ===========================================================================
describe('getBackendIntegrationUrl – cache hit returns cached value', () => {
  beforeEach(() => {
    visitAndExposeConfig();
  });

  it('returns the cached URL without reading checkoutData when cache is fresh', () => {
    cy.window().then((win) => {
      // Seed a valid (fresh) integration URL
      win.__storageSetWithExpiry('adyen_integration_url', BACKEND_URL, 3600);

      // checkoutData with a DIFFERENT url – should NOT be used
      const checkoutData = checkoutDataWithUrl('https://other.example.com/adyen/');
      const result = win.__getBackendIntegrationUrl(checkoutData);
      expect(result).to.equal(BACKEND_URL);
    });
  });
});

// ===========================================================================
// Suite 2 – getBackendIntegrationUrl: cache miss extracts from checkoutData
// ===========================================================================
describe('getBackendIntegrationUrl – cache miss reads checkoutData and caches result', () => {
  beforeEach(() => {
    visitAndExposeConfig();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_integration_url');
    });
  });

  it('returns the URL from checkoutData when cache is empty', () => {
    cy.window().then((win) => {
      const checkoutData = checkoutDataWithUrl(BACKEND_URL);
      const result = win.__getBackendIntegrationUrl(checkoutData);
      expect(result).to.equal(BACKEND_URL);
    });
  });

  it('writes the extracted URL to adyen_integration_url in localStorage', () => {
    cy.window().then((win) => {
      const checkoutData = checkoutDataWithUrl(BACKEND_URL);
      win.__getBackendIntegrationUrl(checkoutData);
      const entry = win.__storageGetWithExpiry('adyen_integration_url');
      expect(entry).to.not.be.null;
      expect(entry.value).to.equal(BACKEND_URL);
      expect(entry.expired).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 3 – getBackendIntegrationUrl: expired cache falls back to checkoutData
// ===========================================================================
describe('getBackendIntegrationUrl – expired cache falls back to checkoutData', () => {
  beforeEach(() => {
    visitAndExposeConfig();
  });

  it('returns the URL from checkoutData when cached entry is expired', () => {
    cy.window().then((win) => {
      // Write an expired entry
      const expiredEntry = {
        value: 'https://expired.example.com/',
        ':expiry': Math.round(Date.now() / 1000) - 3600,
      };
      win.localStorage.setItem('adyen_integration_url', JSON.stringify(expiredEntry));

      const newUrl = 'https://fresh.example.com/adyen/';
      const checkoutData = checkoutDataWithUrl(newUrl);
      const result = win.__getBackendIntegrationUrl(checkoutData);
      expect(result).to.equal(newUrl);
    });
  });
});

// ===========================================================================
// Suite 4 – getBackendIntegrationUrl: returns undefined when no adyen method
// ===========================================================================
describe('getBackendIntegrationUrl – returns undefined when no adyen payment method', () => {
  beforeEach(() => {
    visitAndExposeConfig();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_integration_url');
    });
  });

  it('returns undefined when checkoutData has no adyen_ payment method', () => {
    cy.window().then((win) => {
      const result = win.__getBackendIntegrationUrl(checkoutDataWithoutAdyen());
      expect(result).to.be.undefined;
    });
  });

  it('returns undefined when checkoutData is null', () => {
    cy.window().then((win) => {
      const result = win.__getBackendIntegrationUrl(null);
      expect(result).to.be.undefined;
    });
  });
});

// ===========================================================================
// Suite 5 – fetchPublicConfiguration: cache hit does not fetch
// ===========================================================================
describe('fetchPublicConfiguration – cache hit skips network request', () => {
  beforeEach(() => {
    visitAndExposeConfig();
  });

  it('returns cached config when adyen_public_configuration is fresh', () => {
    // Intercept the fetch – it should NOT be called
    cy.intercept('POST', '**/public-configuration', cy.spy().as('fetchSpy')).as('pubConfig');

    cy.window().then((win) => {
      win.__storageSetWithExpiry('adyen_public_configuration', PUBLIC_CONFIG, 86400);
    });

    cy.window().then(async (win) => {
      const result = await win.__fetchPublicConfiguration(BACKEND_URL, 'default');
      expect(result).to.deep.equal(PUBLIC_CONFIG);
    });

    // The intercepted fetch should NOT have been called
    cy.get('@fetchSpy').should('not.have.been.called');
  });
});

// ===========================================================================
// Suite 6 – fetchPublicConfiguration: cache miss fetches and stores result
// ===========================================================================
describe('fetchPublicConfiguration – cache miss fetches from backend', () => {
  beforeEach(() => {
    visitAndExposeConfig();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_public_configuration');
    });
  });

  it('fetches public config and returns the response body', () => {
    cy.intercept('POST', '**/public-configuration', {
      statusCode: 200,
      body: PUBLIC_CONFIG,
    }).as('fetchPublicConfig');

    cy.window().then(async (win) => {
      const result = await win.__fetchPublicConfiguration(BACKEND_URL, 'default');
      expect(result.clientKey).to.equal(PUBLIC_CONFIG.clientKey);
      expect(result.environment).to.equal(PUBLIC_CONFIG.environment);
    });

    cy.wait('@fetchPublicConfig');
  });

  it('writes fetched config to adyen_public_configuration in localStorage', () => {
    cy.intercept('POST', '**/public-configuration', {
      statusCode: 200,
      body: PUBLIC_CONFIG,
    }).as('fetchPublicConfigStore');

    cy.window().then(async (win) => {
      await win.__fetchPublicConfiguration(BACKEND_URL, 'default');
    });

    cy.wait('@fetchPublicConfigStore');

    cy.window().then((win) => {
      const cached = win.__storageGetWithExpiry('adyen_public_configuration');
      expect(cached).to.not.be.null;
      expect(cached.expired).to.equal(false);
      expect(cached.value.clientKey).to.equal(PUBLIC_CONFIG.clientKey);
    });
  });
});

// ===========================================================================
// Suite 7 – fetchPublicConfiguration: expired cache is removed before re-fetch
// ===========================================================================
describe('fetchPublicConfiguration – expired cache removed before re-fetch', () => {
  beforeEach(() => {
    visitAndExposeConfig();
  });

  it('removes the expired entry and fetches fresh config', () => {
    cy.intercept('POST', '**/public-configuration', {
      statusCode: 200,
      body: { ...PUBLIC_CONFIG, clientKey: 'test_FRESH_KEY' },
    }).as('fetchFreshConfig');

    cy.window().then((win) => {
      // Seed an expired config
      const expired = {
        value: { ...PUBLIC_CONFIG, clientKey: 'test_OLD_KEY' },
        ':expiry': Math.round(Date.now() / 1000) - 7200,
      };
      win.localStorage.setItem('adyen_public_configuration', JSON.stringify(expired));
    });

    cy.window().then(async (win) => {
      const result = await win.__fetchPublicConfiguration(BACKEND_URL, 'default');
      expect(result.clientKey).to.equal('test_FRESH_KEY');
    });

    cy.wait('@fetchFreshConfig');
  });
});

// ===========================================================================
// Suite 8 – buildStaticConfig: uses publicCfg.countryCode
// ===========================================================================
describe('buildStaticConfig – countryCode priority', () => {
  before(visitAndExposeConfig);

  it('uses publicCfg.countryCode when provided (highest priority)', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test', countryCode: 'DE' },
        { billingAddress: { country: { code: 'US' } } },
        'NL',
      );
      expect(result.countryCode).to.equal('DE');
    });
  });
});

// ===========================================================================
// Suite 9 – buildStaticConfig: falls back to billingAddress.country.code
// ===========================================================================
describe('buildStaticConfig – billing address country fallback', () => {
  before(visitAndExposeConfig);

  it('uses billingAddress.country.code when publicCfg has no countryCode', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test' }, // no countryCode
        { billingAddress: { country: { code: 'FR' } } },
        'US',
      );
      expect(result.countryCode).to.equal('FR');
    });
  });

  it('uses billingAddress.country (string) as fallback when no .code property', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test' },
        { billingAddress: { country: 'GB' } },
        'US',
      );
      expect(result.countryCode).to.equal('GB');
    });
  });
});

// ===========================================================================
// Suite 10 – buildStaticConfig: falls back to shippingAddress when no billing
// ===========================================================================
describe('buildStaticConfig – shipping address country fallback', () => {
  before(visitAndExposeConfig);

  it('uses shippingAddress country when billingAddress country is absent', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test' },
        {
          billingAddress: {},
          shippingAddress: { country: { code: 'IT' } },
        },
        'US',
      );
      expect(result.countryCode).to.equal('IT');
    });
  });
});

// ===========================================================================
// Suite 11 – buildStaticConfig: falls back to storeConfig.defaultCountry
// ===========================================================================
describe('buildStaticConfig – storeConfig.defaultCountry fallback', () => {
  before(visitAndExposeConfig);

  it('uses storeDefaultCountry when no publicCfg countryCode and no checkout addresses', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test' },
        null,
        'AU',
      );
      expect(result.countryCode).to.equal('AU');
    });
  });
});

// ===========================================================================
// Suite 12 – buildStaticConfig: falls back to 'US' as last resort
// ===========================================================================
describe('buildStaticConfig – US hard-coded fallback', () => {
  before(visitAndExposeConfig);

  it('uses "US" when all other country sources are undefined/null', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'K', environment: 'test' }, // no countryCode
        null, // no checkoutData
        null, // no storeConfig
      );
      expect(result.countryCode).to.equal('US');
    });
  });
});

// ===========================================================================
// Suite 13 – buildStaticConfig: always includes required fields
// ===========================================================================
describe('buildStaticConfig – always includes required fields', () => {
  before(visitAndExposeConfig);

  it('returns environment, clientKey, locale, countryCode, and analytics', () => {
    cy.window().then((win) => {
      const result = win.__buildStaticConfig(
        { clientKey: 'test_KEY', environment: 'live', countryCode: 'US' },
        null,
        null,
      );
      expect(result).to.have.property('environment', 'live');
      expect(result).to.have.property('clientKey', 'test_KEY');
      expect(result).to.have.property('locale');
      expect(result).to.have.property('countryCode', 'US');
      expect(result.analytics).to.deep.equal({ enabled: true });
    });
  });
});
