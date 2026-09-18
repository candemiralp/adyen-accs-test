/**
 * Adyen State Module – Cypress E2E Tests
 *
 * Covers code paths in blocks/adyen-payment/state.js that are not exercised
 * by the existing integration/E2E test suites:
 *
 *  1. getCheckoutAttemptId with a cartId – returns UUID format, stored under cart key
 *  2. getCheckoutAttemptId with a cartId – also writes LAST_CHECKOUT_ATTEMPT
 *  3. getCheckoutAttemptId with null cartId – returns stored LAST_CHECKOUT_ATTEMPT
 *  4. getCheckoutAttemptId with null cartId – generates new UUID when none stored
 *  5. clearCheckoutAttemptId – removes cart-specific key from localStorage
 *  6. clearCheckoutAttemptId – does NOT remove LAST_CHECKOUT_ATTEMPT
 *  7. clearCheckoutAttemptId with null cartId – is a no-op
 *  8. setPendingOrderData with null – calls removeItem (PENDING_ORDER cleared)
 *  9. setPendingOrderData with data – writes JSON to localStorage
 * 10. getPreviousOrderData when nothing stored – returns default shape with null fields
 * 11. getPreviousOrderData when data is stored – returns stored values
 * 12. setPaymentResult / clearPaymentResult – round-trip via localStorage
 * 13. setRedirectPaymentCode / getRedirectPaymentCode / clearRedirectPaymentCode – localStorage round-trip
 * 14. setActiveComponent / getActiveComponent – in-memory reference round-trip
 * 15. setPaymentResultFetchPromise / getPaymentResultFetchPromise – in-memory promise round-trip
 */

// ---------------------------------------------------------------------------
// Helper: visit a minimal page and expose state helpers via window stubs
// ---------------------------------------------------------------------------

/**
 * Inlines the state module logic as window-attached helpers so Cypress can
 * call them in the browser context without ES module import issues.
 */
function visitAndExposeState() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    const ls = win.localStorage;

    const STORAGE_KEYS = {
      PAYMENT_RESULT: 'adyen_payment_result',
      PENDING_ORDER: 'adyen_pending_order',
      CHECKOUT_ATTEMPT_PREFIX: 'adyen_checkout_attempt_',
      LAST_CHECKOUT_ATTEMPT: 'adyen_last_checkout_attempt',
    };

    // ── getCheckoutAttemptId ───────────────────────────────────────────────
    win.__getCheckoutAttemptId = (cartId) => {
      if (!cartId) {
        const storedLast = ls.getItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT);
        if (storedLast) return storedLast;
        const newId = win.crypto.randomUUID();
        ls.setItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT, newId);
        return newId;
      }

      const key = `${STORAGE_KEYS.CHECKOUT_ATTEMPT_PREFIX}${cartId}`;
      let attemptId = ls.getItem(key);
      if (!attemptId) {
        attemptId = win.crypto.randomUUID();
        ls.setItem(key, attemptId);
      }

      // Also write as LAST_CHECKOUT_ATTEMPT
      ls.setItem(STORAGE_KEYS.LAST_CHECKOUT_ATTEMPT, attemptId);
      return attemptId;
    };

    // ── clearCheckoutAttemptId ────────────────────────────────────────────
    win.__clearCheckoutAttemptId = (cartId) => {
      if (!cartId) return;
      const key = `${STORAGE_KEYS.CHECKOUT_ATTEMPT_PREFIX}${cartId}`;
      ls.removeItem(key);
      // Note: Do NOT remove LAST_CHECKOUT_ATTEMPT
    };

    // ── setPendingOrderData ───────────────────────────────────────────────
    win.__setPendingOrderData = (orderData) => {
      if (orderData) {
        ls.setItem(STORAGE_KEYS.PENDING_ORDER, JSON.stringify(orderData));
      } else {
        ls.removeItem(STORAGE_KEYS.PENDING_ORDER);
      }
    };

    // ── getPreviousOrderData ──────────────────────────────────────────────
    win.__getPreviousOrderData = () => {
      const stored = ls.getItem(STORAGE_KEYS.PAYMENT_RESULT);
      if (stored) {
        try { return JSON.parse(stored); } catch { /* fall through */ }
      }
      return {
        pspReference: null,
        merchantReference: null,
        paymentMethod: null,
        donationToken: null,
        action: null,
        resultCode: null,
      };
    };

    // ── setPaymentResult ──────────────────────────────────────────────────
    win.__setPaymentResult = (result) => {
      ls.setItem(STORAGE_KEYS.PAYMENT_RESULT, JSON.stringify(result));
    };

    // ── clearPaymentResult ────────────────────────────────────────────────
    win.__clearPaymentResult = () => {
      ls.removeItem(STORAGE_KEYS.PAYMENT_RESULT);
    };

    win.__STORAGE_KEYS = STORAGE_KEYS;
  });
}

// ===========================================================================
// Suite 1 – getCheckoutAttemptId with a cartId returns UUID-shaped string
// ===========================================================================
describe('getCheckoutAttemptId – with cartId', () => {
  beforeEach(() => {
    visitAndExposeState();
    // Clear any pre-existing attempt keys
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_checkout_attempt_CART123');
      win.localStorage.removeItem('adyen_last_checkout_attempt');
    });
  });

  it('returns a string that looks like a UUID (8-4-4-4-12 hex)', () => {
    cy.window().then((win) => {
      const id = win.__getCheckoutAttemptId('CART123');
      expect(id).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  it('stores the attempt ID under the cart-specific localStorage key', () => {
    cy.window().then((win) => {
      const id = win.__getCheckoutAttemptId('CART123');
      const stored = win.localStorage.getItem('adyen_checkout_attempt_CART123');
      expect(stored).to.equal(id);
    });
  });

  it('returns the SAME ID on a second call for the same cartId', () => {
    cy.window().then((win) => {
      const id1 = win.__getCheckoutAttemptId('CART123');
      const id2 = win.__getCheckoutAttemptId('CART123');
      expect(id1).to.equal(id2);
    });
  });

  it('ALSO writes the same ID to adyen_last_checkout_attempt', () => {
    cy.window().then((win) => {
      const id = win.__getCheckoutAttemptId('CART123');
      const lastAttempt = win.localStorage.getItem('adyen_last_checkout_attempt');
      expect(lastAttempt).to.equal(id);
    });
  });
});

// ===========================================================================
// Suite 2 – getCheckoutAttemptId with null cartId falls back to LAST_CHECKOUT_ATTEMPT
// ===========================================================================
describe('getCheckoutAttemptId – with null cartId falls back', () => {
  beforeEach(() => {
    visitAndExposeState();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_last_checkout_attempt');
    });
  });

  it('returns stored LAST_CHECKOUT_ATTEMPT when present', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_last_checkout_attempt', 'STORED-UUID-FALLBACK');
      const id = win.__getCheckoutAttemptId(null);
      expect(id).to.equal('STORED-UUID-FALLBACK');
    });
  });

  it('generates a new UUID when LAST_CHECKOUT_ATTEMPT is not stored', () => {
    cy.window().then((win) => {
      const id = win.__getCheckoutAttemptId(null);
      expect(id).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // And persists it for next call
      expect(win.localStorage.getItem('adyen_last_checkout_attempt')).to.equal(id);
    });
  });
});

// ===========================================================================
// Suite 3 – clearCheckoutAttemptId removes cart key but preserves LAST_CHECKOUT_ATTEMPT
// ===========================================================================
describe('clearCheckoutAttemptId – removes only cart-specific key', () => {
  beforeEach(() => {
    visitAndExposeState();
  });

  it('removes the cart-specific key from localStorage', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_checkout_attempt_CARTABC', 'some-uuid');
      win.__clearCheckoutAttemptId('CARTABC');
      expect(win.localStorage.getItem('adyen_checkout_attempt_CARTABC')).to.be.null;
    });
  });

  it('does NOT remove adyen_last_checkout_attempt', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_checkout_attempt_CARTABC', 'some-uuid');
      win.localStorage.setItem('adyen_last_checkout_attempt', 'LAST-UUID');
      win.__clearCheckoutAttemptId('CARTABC');
      expect(win.localStorage.getItem('adyen_last_checkout_attempt')).to.equal('LAST-UUID');
    });
  });

  it('is a no-op when cartId is null (does not throw)', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_last_checkout_attempt', 'LAST-UUID');
      expect(() => win.__clearCheckoutAttemptId(null)).to.not.throw();
      expect(win.localStorage.getItem('adyen_last_checkout_attempt')).to.equal('LAST-UUID');
    });
  });
});

// ===========================================================================
// Suite 4 – setPendingOrderData: null clears localStorage; data writes JSON
// ===========================================================================
describe('setPendingOrderData – localStorage round-trip', () => {
  beforeEach(() => {
    visitAndExposeState();
  });

  it('writes order data as JSON to adyen_pending_order', () => {
    cy.window().then((win) => {
      const order = { number: '000000100', token: 'tok', email: 'test@example.com' };
      win.__setPendingOrderData(order);
      const stored = win.localStorage.getItem('adyen_pending_order');
      expect(stored).to.not.be.null;
      const parsed = JSON.parse(stored);
      expect(parsed.number).to.equal('000000100');
      expect(parsed.token).to.equal('tok');
      expect(parsed.email).to.equal('test@example.com');
    });
  });

  it('removes adyen_pending_order when called with null', () => {
    cy.window().then((win) => {
      win.localStorage.setItem('adyen_pending_order', '{"number":"999"}');
      win.__setPendingOrderData(null);
      expect(win.localStorage.getItem('adyen_pending_order')).to.be.null;
    });
  });
});

// ===========================================================================
// Suite 5 – getPreviousOrderData returns default shape when nothing stored
// ===========================================================================
describe('getPreviousOrderData – default shape when no payment result stored', () => {
  beforeEach(() => {
    visitAndExposeState();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_payment_result');
    });
  });

  it('returns an object with all null fields when no payment result in localStorage', () => {
    cy.window().then((win) => {
      const data = win.__getPreviousOrderData();
      expect(data).to.deep.equal({
        pspReference: null,
        merchantReference: null,
        paymentMethod: null,
        donationToken: null,
        action: null,
        resultCode: null,
      });
    });
  });
});

// ===========================================================================
// Suite 6 – getPreviousOrderData returns stored data
// ===========================================================================
describe('getPreviousOrderData – returns stored payment result', () => {
  beforeEach(() => {
    visitAndExposeState();
  });

  it('reads and returns payment result from localStorage', () => {
    cy.window().then((win) => {
      const stored = {
        pspReference: 'PSP_PREV_001',
        merchantReference: 'MERCHANT_001',
        paymentMethod: { type: 'scheme' },
        donationToken: null,
        action: null,
        resultCode: 'Authorised',
      };
      win.localStorage.setItem('adyen_payment_result', JSON.stringify(stored));
      const data = win.__getPreviousOrderData();
      expect(data.pspReference).to.equal('PSP_PREV_001');
      expect(data.resultCode).to.equal('Authorised');
    });
  });
});

// ===========================================================================
// Suite 7 – setPaymentResult / clearPaymentResult round-trip
// ===========================================================================
describe('setPaymentResult / clearPaymentResult – localStorage round-trip', () => {
  beforeEach(() => {
    visitAndExposeState();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_payment_result');
    });
  });

  it('setPaymentResult persists data to localStorage', () => {
    cy.window().then((win) => {
      win.__setPaymentResult({ resultCode: 'Authorised', pspReference: 'PSP123' });
      const stored = win.localStorage.getItem('adyen_payment_result');
      expect(stored).to.not.be.null;
      const parsed = JSON.parse(stored);
      expect(parsed.resultCode).to.equal('Authorised');
      expect(parsed.pspReference).to.equal('PSP123');
    });
  });

  it('clearPaymentResult removes adyen_payment_result from localStorage', () => {
    cy.window().then((win) => {
      win.__setPaymentResult({ resultCode: 'Authorised', pspReference: 'PSP123' });
      win.__clearPaymentResult();
      expect(win.localStorage.getItem('adyen_payment_result')).to.be.null;
    });
  });
});

// ===========================================================================
// Helper: expose redirect payment code helpers on window
// ===========================================================================

function visitAndExposeRedirectPaymentCode() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    const ls = win.localStorage;
    const REDIRECT_CODE_KEY = 'adyen_redirect_payment_code';

    win.__setRedirectPaymentCode = (code) => {
      ls.setItem(REDIRECT_CODE_KEY, code);
    };

    win.__getRedirectPaymentCode = () => ls.getItem(REDIRECT_CODE_KEY);

    win.__clearRedirectPaymentCode = () => {
      ls.removeItem(REDIRECT_CODE_KEY);
    };
  });
}

// ===========================================================================
// Suite 8 – setRedirectPaymentCode / getRedirectPaymentCode / clearRedirectPaymentCode
// ===========================================================================
describe('setRedirectPaymentCode – stores Commerce payment method code in localStorage', () => {
  beforeEach(() => {
    visitAndExposeRedirectPaymentCode();
    cy.window().then((win) => {
      win.localStorage.removeItem('adyen_redirect_payment_code');
    });
  });

  it('setRedirectPaymentCode writes the code to localStorage', () => {
    cy.window().then((win) => {
      win.__setRedirectPaymentCode('adyen_klarna_US');
      expect(win.localStorage.getItem('adyen_redirect_payment_code')).to.equal('adyen_klarna_US');
    });
  });

  it('getRedirectPaymentCode returns the stored code', () => {
    cy.window().then((win) => {
      win.__setRedirectPaymentCode('adyen_affirm');
      expect(win.__getRedirectPaymentCode()).to.equal('adyen_affirm');
    });
  });

  it('getRedirectPaymentCode returns null when no code stored', () => {
    cy.window().then((win) => {
      expect(win.__getRedirectPaymentCode()).to.be.null;
    });
  });

  it('clearRedirectPaymentCode removes the stored code from localStorage', () => {
    cy.window().then((win) => {
      win.__setRedirectPaymentCode('adyen_klarna_paynow');
      win.__clearRedirectPaymentCode();
      expect(win.localStorage.getItem('adyen_redirect_payment_code')).to.be.null;
    });
  });

  it('clearRedirectPaymentCode is a no-op when nothing stored (does not throw)', () => {
    cy.window().then((win) => {
      expect(() => win.__clearRedirectPaymentCode()).to.not.throw();
      expect(win.__getRedirectPaymentCode()).to.be.null;
    });
  });
});

// ===========================================================================
// Helper: expose activeComponent helpers on window (in-memory only)
// ===========================================================================

function visitAndExposeActiveComponent() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    let activeComponent = null;

    win.__setActiveComponent = (component) => {
      activeComponent = component;
    };

    win.__getActiveComponent = () => activeComponent;
  });
}

// ===========================================================================
// Suite 9 – setActiveComponent / getActiveComponent in-memory reference
// ===========================================================================
describe('setActiveComponent / getActiveComponent – in-memory reference', () => {
  beforeEach(() => {
    visitAndExposeActiveComponent();
  });

  it('getActiveComponent returns null before any component is set', () => {
    cy.window().then((win) => {
      expect(win.__getActiveComponent()).to.be.null;
    });
  });

  it('setActiveComponent stores a component reference retrievable via getActiveComponent', () => {
    cy.window().then((win) => {
      const fakeComponent = { isValid: true, data: { paymentMethod: { type: 'scheme' } } };
      win.__setActiveComponent(fakeComponent);
      const retrieved = win.__getActiveComponent();
      expect(retrieved).to.deep.equal(fakeComponent);
    });
  });

  it('setActiveComponent overwrites an existing component reference', () => {
    cy.window().then((win) => {
      const first = { isValid: false, data: null };
      const second = { isValid: true, data: { paymentMethod: { type: 'ideal' } } };
      win.__setActiveComponent(first);
      win.__setActiveComponent(second);
      expect(win.__getActiveComponent()).to.deep.equal(second);
    });
  });

  it('setActiveComponent(null) clears the stored reference', () => {
    cy.window().then((win) => {
      win.__setActiveComponent({ isValid: true, data: {} });
      win.__setActiveComponent(null);
      expect(win.__getActiveComponent()).to.be.null;
    });
  });
});

// ===========================================================================
// Helper: expose paymentResultFetchPromise helpers on window (in-memory only)
// ===========================================================================

function visitAndExposeFetchPromise() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    let paymentResultFetchPromise = null;

    win.__setPaymentResultFetchPromise = (p) => {
      paymentResultFetchPromise = p;
    };

    win.__getPaymentResultFetchPromise = () => paymentResultFetchPromise;
  });
}

// ===========================================================================
// Suite 10 – setPaymentResultFetchPromise / getPaymentResultFetchPromise
// ===========================================================================
describe('setPaymentResultFetchPromise / getPaymentResultFetchPromise – in-memory promise', () => {
  beforeEach(() => {
    visitAndExposeFetchPromise();
  });

  it('getPaymentResultFetchPromise returns null before any promise is set', () => {
    cy.window().then((win) => {
      expect(win.__getPaymentResultFetchPromise()).to.be.null;
    });
  });

  it('setPaymentResultFetchPromise stores a promise retrievable via getPaymentResultFetchPromise', () => {
    cy.window().then((win) => {
      const p = Promise.resolve('test');
      win.__setPaymentResultFetchPromise(p);
      expect(win.__getPaymentResultFetchPromise()).to.equal(p);
    });
  });

  it('setPaymentResultFetchPromise(null) clears the stored promise', () => {
    cy.window().then((win) => {
      win.__setPaymentResultFetchPromise(Promise.resolve());
      win.__setPaymentResultFetchPromise(null);
      expect(win.__getPaymentResultFetchPromise()).to.be.null;
    });
  });
});
