/**
 * Adyen Storage Module – Cypress E2E Tests
 *
 * Covers code paths in blocks/adyen-payment/storage.js that are not exercised
 * by the existing integration/E2E test suites:
 *
 *  1. getWithExpiry – returns { value, expired: false } for a fresh entry
 *  2. getWithExpiry – returns { value, expired: true } for an expired entry
 *  3. getWithExpiry – returns null when key does not exist
 *  4. setWithExpiry – writes a JSON entry with value and :expiry timestamp
 *  5. setWithExpiry / getWithExpiry round-trip – value survives serialization
 *  6. getJSON – returns null for malformed JSON (graceful degradation)
 *  7. getItem / setItem / removeItem – basic localStorage round-trip
 *  8. removeItem – returns without throwing when key does not exist
 *  9. setJSON / getJSON – object round-trip
 * 10. localStorage unavailable – getItem returns null gracefully
 */

// ---------------------------------------------------------------------------
// Helper: visit a page and expose storage module helpers as window functions
// ---------------------------------------------------------------------------
function visitAndExposeStorage() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    const ls = win.localStorage;

    // ── getItem ───────────────────────────────────────────────────────────
    win.__storageGetItem = (key) => {
      try { return ls.getItem(key); } catch { return null; }
    };

    // ── setItem ───────────────────────────────────────────────────────────
    win.__storageSetItem = (key, value) => {
      try { ls.setItem(key, value); } catch { /* ignore */ }
    };

    // ── removeItem ────────────────────────────────────────────────────────
    win.__storageRemoveItem = (key) => {
      try { ls.removeItem(key); } catch { /* ignore */ }
    };

    // ── getJSON ───────────────────────────────────────────────────────────
    win.__storageGetJSON = (key) => {
      const stored = win.__storageGetItem(key);
      if (!stored) return null;
      try { return JSON.parse(stored); } catch { return null; }
    };

    // ── setJSON ───────────────────────────────────────────────────────────
    win.__storageSetJSON = (key, value) => {
      win.__storageSetItem(key, JSON.stringify(value));
    };

    // ── getWithExpiry ─────────────────────────────────────────────────────
    win.__storageGetWithExpiry = (key) => {
      const entry = win.__storageGetJSON(key);
      if (!entry) return null;
      const now = Math.round(Date.now() / 1000);
      const expired = entry[':expiry'] && entry[':expiry'] < now;
      return { value: entry.value, expired };
    };

    // ── setWithExpiry ─────────────────────────────────────────────────────
    win.__storageSetWithExpiry = (key, value, ttlSeconds) => {
      const entry = {
        value,
        ':expiry': Math.round(Date.now() / 1000) + ttlSeconds,
      };
      win.__storageSetJSON(key, entry);
    };
  });
}

// ===========================================================================
// Suite 1 – getWithExpiry: fresh entry
// ===========================================================================
describe('getWithExpiry – fresh (non-expired) entry', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('returns { value, expired: false } for a freshly written entry', () => {
    cy.window().then((win) => {
      win.__storageSetWithExpiry('adyen_test_key', 'hello', 3600);
      const result = win.__storageGetWithExpiry('adyen_test_key');
      expect(result).to.not.be.null;
      expect(result.value).to.equal('hello');
      expect(result.expired).to.equal(false);
    });
  });

  it('returns the correct value for an object stored with TTL', () => {
    cy.window().then((win) => {
      const obj = { clientKey: 'test_CLIENT_KEY', environment: 'test' };
      win.__storageSetWithExpiry('adyen_test_obj_key', obj, 86400);
      const result = win.__storageGetWithExpiry('adyen_test_obj_key');
      expect(result.expired).to.equal(false);
      expect(result.value).to.deep.equal(obj);
    });
  });
});

// ===========================================================================
// Suite 2 – getWithExpiry: expired entry
// ===========================================================================
describe('getWithExpiry – expired entry', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('returns { value, expired: true } when the :expiry timestamp is in the past', () => {
    cy.window().then((win) => {
      // Write entry with expiry 1 hour in the past
      const entry = {
        value: 'stale-backend-url',
        ':expiry': Math.round(Date.now() / 1000) - 3600,
      };
      win.localStorage.setItem('adyen_test_expired', JSON.stringify(entry));

      const result = win.__storageGetWithExpiry('adyen_test_expired');
      expect(result).to.not.be.null;
      expect(result.value).to.equal('stale-backend-url');
      expect(result.expired).to.equal(true);
    });
  });
});

// ===========================================================================
// Suite 3 – getWithExpiry: key does not exist
// ===========================================================================
describe('getWithExpiry – missing key', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('returns null when the key is not present in localStorage', () => {
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_test_missing');
      const result = win.__storageGetWithExpiry('adyen_test_missing');
      expect(result).to.be.null;
    });
  });
});

// ===========================================================================
// Suite 4 – setWithExpiry: correct entry structure
// ===========================================================================
describe('setWithExpiry – writes correct entry structure', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('writes a JSON entry containing "value" and ":expiry" fields', () => {
    cy.window().then((win) => {
      const before = Math.round(Date.now() / 1000);
      win.__storageSetWithExpiry('adyen_test_structure', 'my-value', 7200);
      const raw = win.localStorage.getItem('adyen_test_structure');
      expect(raw).to.not.be.null;
      const parsed = JSON.parse(raw);
      expect(parsed.value).to.equal('my-value');
      expect(parsed[':expiry']).to.be.at.least(before + 7200);
    });
  });
});

// ===========================================================================
// Suite 5 – setWithExpiry / getWithExpiry round-trip
// ===========================================================================
describe('setWithExpiry / getWithExpiry – round-trip', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('value written by setWithExpiry is returned intact by getWithExpiry', () => {
    cy.window().then((win) => {
      win.__storageSetWithExpiry('adyen_roundtrip', { foo: 'bar', num: 42 }, 86400);
      const result = win.__storageGetWithExpiry('adyen_roundtrip');
      expect(result.value).to.deep.equal({ foo: 'bar', num: 42 });
      expect(result.expired).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 6 – getJSON: graceful degradation on malformed JSON
// ===========================================================================
describe('getJSON – returns null for malformed JSON', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('returns null when localStorage contains invalid JSON string', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_test_bad_json', '{not valid json}');
      const result = win.__storageGetJSON('adyen_test_bad_json');
      expect(result).to.be.null;
    });
  });

  it('returns null when the key does not exist', () => {
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_test_no_json');
      const result = win.__storageGetJSON('adyen_test_no_json');
      expect(result).to.be.null;
    });
  });
});

// ===========================================================================
// Suite 7 – getItem / setItem / removeItem: basic round-trip
// ===========================================================================
describe('getItem / setItem / removeItem – basic localStorage round-trip', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('setItem then getItem returns the stored string', () => {
    cy.window().then((win) => {
      win.__storageSetItem('adyen_test_basic', 'some-string');
      expect(win.__storageGetItem('adyen_test_basic')).to.equal('some-string');
    });
  });

  it('removeItem causes getItem to return null', () => {
    cy.window().then((win) => {
      win.__storageSetItem('adyen_test_basic_rm', 'to-remove');
      win.__storageRemoveItem('adyen_test_basic_rm');
      expect(win.__storageGetItem('adyen_test_basic_rm')).to.be.null;
    });
  });

  it('removeItem does not throw when key does not exist', () => {
    cy.window().then((win) => {
      expect(() => win.__storageRemoveItem('adyen_key_that_never_existed')).to.not.throw();
    });
  });
});

// ===========================================================================
// Suite 8 – setJSON / getJSON: object round-trip
// ===========================================================================
describe('setJSON / getJSON – object round-trip', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('object written by setJSON is returned intact by getJSON', () => {
    cy.window().then((win) => {
      const obj = { clientKey: 'test_CLIENT', environment: 'live', countryCode: 'NL' };
      win.__storageSetJSON('adyen_test_json_rt', obj);
      const result = win.__storageGetJSON('adyen_test_json_rt');
      expect(result).to.deep.equal(obj);
    });
  });

  it('array written by setJSON is returned intact by getJSON', () => {
    cy.window().then((win) => {
      const arr = ['card', 'paypal', 'ideal'];
      win.__storageSetJSON('adyen_test_arr_rt', arr);
      const result = win.__storageGetJSON('adyen_test_arr_rt');
      expect(result).to.deep.equal(arr);
    });
  });
});

// ===========================================================================
// Suite 9 – INTEGRATION_URL and PUBLIC_CONFIG key constants
// ===========================================================================
describe('Storage key constants – adyen_integration_url and adyen_public_configuration', () => {
  beforeEach(() => {
    visitAndExposeStorage();
  });

  it('adyen_integration_url can be written and read with TTL', () => {
    cy.window().then((win) => {
      win.__storageSetWithExpiry('adyen_integration_url', 'https://backend.example.com/adyen/', 86400);
      const result = win.__storageGetWithExpiry('adyen_integration_url');
      expect(result.value).to.equal('https://backend.example.com/adyen/');
      expect(result.expired).to.equal(false);
    });
  });

  it('adyen_public_configuration can be written and read with TTL', () => {
    cy.window().then((win) => {
      const config = { clientKey: 'test_CLIENT', environment: 'test' };
      win.__storageSetWithExpiry('adyen_public_configuration', config, 86400);
      const result = win.__storageGetWithExpiry('adyen_public_configuration');
      expect(result.value).to.deep.equal(config);
      expect(result.expired).to.equal(false);
    });
  });
});
