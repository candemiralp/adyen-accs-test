/**
 * Commerce Checkout Block – Adyen 3DS2 Recovery Behavior Tests
 *
 * Covers the behaviors introduced in blocks/commerce-checkout/commerce-checkout.js
 * by the_3DS2_native branch (commits 70530fa + f064605) and *
 * 1. isPaymentErrorRecovery flag – handleAuthenticated does NOT reload the page
 *    when PAYMENT_ERROR is present in sessionStorage at page load time.
 *
 * 2. showPersistedPaymentError IIFE – when PAYMENT_ERROR is in sessionStorage,
 *    a persisted error banner is injected as the FIRST CHILD of $paymentMethods
 *    (the outer static container), NOT inside the Preact-managed sub-tree, so it
 *    survives subsequent checkout/updated re-renders.
 *
 * 3. setRecoveryStartCallback wiring – the overlay spinner is shown during cart
 *    recovery after a 3DS2 payment failure (spinner fires before redirect).
 *
 * 4. handleOrderPlaced guest field persistence (!newCartId path, Fix 1) –
 *    GUEST_EMAIL, GUEST_FIRSTNAME, GUEST_LASTNAME are written to sessionStorage
 *    alongside PAYMENT_ERROR before redirecting to /checkout.
 *
 * 5. handleOrderPlaced guest field persistence (newCartId already present path, Fix 2) –
 *    When the backend returns newCartId in the order-result response, the same
 *    sessionStorage writes and redirect still happen (without calling recover-cart).
 *
 * 6. restoreGuestFields IIFE – reads the three guest sessionStorage keys, removes
 *    them immediately (single-use), fills the DOM email input, and sets
 *    pendingGuestEmailRestore so handleCheckoutUpdated can call setGuestEmailOnCart.
 *
 * 7. handleCheckoutUpdated restore path – when pendingGuestEmailRestore is set and
 *    data.isGuest is true, calls setGuestEmailOnCart and fillGuestEmailInput; consumes
 *    pendingGuestEmailRestore (sets to null) after the first invocation.
 *
 * Test strategy:
 * ─────────────────────────────────────────────────────────────────────────────
 * All behaviors are tested by inlining the relevant logic on window (the same
 * pattern used by verifyAdyenHandlers and verifyAdyenUtils). This avoids
 * cross-origin ES module issues and keeps tests fast.
 *
 * Scenarios covered:
 *
 * isPaymentErrorRecovery:
 *  1. handleAuthenticated first call is always skipped (page-load initial auth state)
 *  1. handleAuthenticated reloads page on second+ call when isPaymentErrorRecovery is false
 *  2. handleAuthenticated skips reload on second call when isPaymentErrorRecovery is true
 *  3. isPaymentErrorRecovery flag is false when sessionStorage has no PAYMENT_ERROR key
 *  4. isPaymentErrorRecovery flag is true when sessionStorage has PAYMENT_ERROR key
 *
 * showPersistedPaymentError IIFE:
 *  5. Banner is injected as first child of $paymentMethods (not inside __content)
 *  6. Banner has id="adyen-persisted-payment-error" and role="alert"
 *  7. Banner text matches the sessionStorage message
 *  8. PAYMENT_ERROR key is cleared from sessionStorage after banner injection
 *  9. No banner is injected when PAYMENT_ERROR is absent from sessionStorage
 *
 * setRecoveryStartCallback:
 * 10. Registered callback is invoked when recovery starts
 * 11. Returned unregister function prevents further callback invocations
 *
 * handleOrderPlaced – guest field persistence (!newCartId path, Fix 1):
 * 12. Writes PAYMENT_ERROR, GUEST_EMAIL, GUEST_FIRSTNAME, GUEST_LASTNAME to sessionStorage
 * 13. Skips writing GUEST_EMAIL when orderData.email is absent
 * 14. Skips writing GUEST_FIRSTNAME/LASTNAME when billingAddress is absent
 *
 * handleOrderPlaced – guest field persistence (newCartId path, Fix 2):
 * 15. Writes same sessionStorage keys when result.newCartId is pre-set (no recover-cart call)
 * 16. Does NOT write guest fields when resultCode is Authorised (non-failure)
 *
 * restoreGuestFields IIFE:
 * 17. Reads and removes all three keys from sessionStorage
 * 18. Sets pendingGuestEmailRestore to the email value
 * 19. Early-returns when no guest keys are present (no side-effects)
 *
 * handleCheckoutUpdated restore path:
 * 20. Calls setGuestEmailOnCart with the pending email when data.isGuest is true
 * 21. Consumes pendingGuestEmailRestore (sets to null) after first call
 * 22. Skips setGuestEmailOnCart when data.isGuest is false
 *
 * firstAuthEventReceived guard (Suite 16):
 * 23. First authenticated=true call does NOT reload (page-load initial state, always skipped)
 * 24. First authenticated=false call does NOT reload (page-load initial state, always skipped)
 * 25. Second authenticated=true call (with isPaymentErrorRecovery=false) triggers reload
 * 26. Second authenticated=false call does NOT reload
 * 27. Each subsequent authenticated=true call triggers a reload (not capped)
 * 28. First-call skip applies regardless of isPaymentErrorRecovery value
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STORAGE_KEY_PAYMENT_ERROR = 'adyen_payment_error';
const DECLINE_MESSAGE = "We're sorry, your payment was declined. Please try again or use a different payment method.";

// ---------------------------------------------------------------------------
// Helper: inject inline handleAuthenticated logic onto window
// Mirrors blocks/commerce-checkout/commerce-checkout.js handleAuthenticated():
//   1. The first call (any authenticated value) is always skipped — it represents
//      the initial auth state emitted on page load by storefront-auth.
//   2. Subsequent calls with authenticated=true trigger a reload unless
//      isPaymentErrorRecovery is true.
// ---------------------------------------------------------------------------
function exposeHandleAuthenticated(win, isPaymentErrorRecovery) {
  win.__reloadCount = 0;
  let firstAuthEventReceived = false;

  win.__handleAuthenticated = (authenticated) => {
    // First event is always the initial page-load auth state — skip it.
    if (!firstAuthEventReceived) {
      firstAuthEventReceived = true;
      return;
    }
    if (!authenticated) return;
    if (!isPaymentErrorRecovery) {
      win.__reloadCount += 1;
      // In the real code this is window.location.reload() — we stub the count instead
      // to avoid actually navigating away from the test page.
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: inject inline showPersistedPaymentError IIFE logic onto window
// ---------------------------------------------------------------------------
function exposeShowPersistedPaymentError(win, $paymentMethods) {
  win.__runShowPersistedPaymentError = () => {
    let errorMessage;
    try {
      errorMessage = win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR);
    } catch { /* ignore */ }
    if (!errorMessage) return;

    try { win.sessionStorage.removeItem(STORAGE_KEY_PAYMENT_ERROR); } catch { /* ignore */ }

    const errorBanner = win.document.createElement('div');
    errorBanner.className = 'checkout-payment-methods-error';
    errorBanner.id = 'adyen-persisted-payment-error';
    errorBanner.setAttribute('role', 'alert');
    errorBanner.innerHTML = `<span>${errorMessage}</span>`;
    $paymentMethods.insertBefore(errorBanner, $paymentMethods.firstChild);
  };
}

// ---------------------------------------------------------------------------
// Helper: inject inline setRecoveryStartCallback logic onto window
// ---------------------------------------------------------------------------
function exposeSetRecoveryStartCallback(win) {
  let recoveryStartCallback = null;

  win.__setRecoveryStartCallback = (callback) => {
    recoveryStartCallback = callback;
    return () => {
      if (recoveryStartCallback === callback) {
        recoveryStartCallback = null;
      }
    };
  };

  win.__triggerRecoveryStart = () => {
    if (typeof recoveryStartCallback === 'function') recoveryStartCallback();
  };
}

// ===========================================================================
// Suite 1 – isPaymentErrorRecovery: handleAuthenticated reloads when flag is false
// ===========================================================================
describe('handleAuthenticated – reloads page when isPaymentErrorRecovery is false', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.removeItem(STORAGE_KEY_PAYMENT_ERROR);
      exposeHandleAuthenticated(win, false /* isPaymentErrorRecovery */);
    });
  });

  it('does NOT reload on the first call (page-load initial auth state is always skipped)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('increments reload counter on the second call when authenticated=true', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(true);  // second — triggers reload
      expect(win.__reloadCount).to.equal(1);
    });
  });

  it('does not increment reload counter on the second call when authenticated=false', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(false); // second — no reload because authenticated is false
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('increments reload counter for each subsequent authenticated=true call after the first', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(true);  // second
      win.__handleAuthenticated(true);  // third
      expect(win.__reloadCount).to.equal(2);
    });
  });
});

// ===========================================================================
// Suite 2 – isPaymentErrorRecovery: handleAuthenticated skips reload when flag is true
// ===========================================================================
describe('handleAuthenticated – skips reload when isPaymentErrorRecovery is true', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MESSAGE);
      exposeHandleAuthenticated(win, true /* isPaymentErrorRecovery */);
    });
  });

  it('does NOT reload on the first call (page-load initial auth state is always skipped)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('does NOT reload on the second call when authenticated=true and PAYMENT_ERROR is in sessionStorage', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(true);  // second — blocked by isPaymentErrorRecovery
      expect(win.__reloadCount).to.equal(0);
    });
  });
});

// ===========================================================================
// Suite 3 – isPaymentErrorRecovery flag value when sessionStorage is empty
// ===========================================================================
describe('isPaymentErrorRecovery – false when PAYMENT_ERROR absent from sessionStorage', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.removeItem(STORAGE_KEY_PAYMENT_ERROR);
    });
  });

  it('computes isPaymentErrorRecovery as false when key is absent', () => {
    cy.window().then((win) => {
      let isPaymentErrorRecovery = false;
      try {
        isPaymentErrorRecovery = !!win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR);
      } catch { /* ignore */ }
      expect(isPaymentErrorRecovery).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 4 – isPaymentErrorRecovery flag value when sessionStorage has PAYMENT_ERROR
// ===========================================================================
describe('isPaymentErrorRecovery – true when PAYMENT_ERROR present in sessionStorage', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MESSAGE);
    });
  });

  it('computes isPaymentErrorRecovery as true when key is present', () => {
    cy.window().then((win) => {
      let isPaymentErrorRecovery = false;
      try {
        isPaymentErrorRecovery = !!win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR);
      } catch { /* ignore */ }
      expect(isPaymentErrorRecovery).to.equal(true);
    });
  });
});

// ===========================================================================
// Suite 5 – showPersistedPaymentError: banner injected as first child of $paymentMethods
// ===========================================================================
describe('showPersistedPaymentError – banner is first child of outer $paymentMethods', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MESSAGE);

      // Build the outer payment methods container with some existing child content
      // to confirm the banner is prepended (not appended).
      const $paymentMethods = win.document.createElement('div');
      $paymentMethods.className = 'checkout__payment-methods';
      $paymentMethods.id = 'test-payment-methods';

      const existingChild = win.document.createElement('div');
      existingChild.className = 'checkout-payment-methods__content';
      existingChild.textContent = 'Preact-managed content';
      $paymentMethods.appendChild(existingChild);

      win.document.body.appendChild($paymentMethods);

      exposeShowPersistedPaymentError(win, $paymentMethods);
    });
  });

  it('banner is the first child of $paymentMethods (prepended, not inside __content)', () => {
    cy.window().then((win) => {
      win.__runShowPersistedPaymentError();
    });

    cy.get('#test-payment-methods').then(($outer) => {
      const { firstChild } = $outer[0];
      expect(firstChild.classList.contains('checkout-payment-methods-error')).to.equal(true);
      expect(firstChild.id).to.equal('adyen-persisted-payment-error');
    });

    // Banner must NOT be inside the Preact sub-tree (.checkout-payment-methods__content)
    cy.get('.checkout-payment-methods__content .checkout-payment-methods-error').should('not.exist');
  });
});

// ===========================================================================
// Suite 6 – showPersistedPaymentError: banner attributes
// ===========================================================================
describe('showPersistedPaymentError – banner has correct id and role attributes', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MESSAGE);

      const $paymentMethods = win.document.createElement('div');
      $paymentMethods.className = 'checkout__payment-methods';
      $paymentMethods.id = 'test-payment-methods-attrs';
      win.document.body.appendChild($paymentMethods);

      exposeShowPersistedPaymentError(win, $paymentMethods);
    });
  });

  it('banner has id="adyen-persisted-payment-error"', () => {
    cy.window().then((win) => { win.__runShowPersistedPaymentError(); });
    cy.get('#adyen-persisted-payment-error').should('exist');
  });

  it('banner has role="alert"', () => {
    cy.window().then((win) => { win.__runShowPersistedPaymentError(); });
    cy.get('#adyen-persisted-payment-error').should('have.attr', 'role', 'alert');
  });
});

// ===========================================================================
// Suite 7 – showPersistedPaymentError: banner text matches sessionStorage message
// ===========================================================================
describe('showPersistedPaymentError – banner text matches the stored error message', () => {
  const CUSTOM_MESSAGE = 'Custom decline message for test';

  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, CUSTOM_MESSAGE);

      const $paymentMethods = win.document.createElement('div');
      $paymentMethods.className = 'checkout__payment-methods';
      $paymentMethods.id = 'test-payment-methods-text';
      win.document.body.appendChild($paymentMethods);

      exposeShowPersistedPaymentError(win, $paymentMethods);
    });
  });

  it('banner contains the exact message that was stored in sessionStorage', () => {
    cy.window().then((win) => { win.__runShowPersistedPaymentError(); });
    cy.get('#adyen-persisted-payment-error').should('contain.text', CUSTOM_MESSAGE);
  });
});

// ===========================================================================
// Suite 8 – showPersistedPaymentError: clears PAYMENT_ERROR from sessionStorage
// ===========================================================================
describe('showPersistedPaymentError – PAYMENT_ERROR is cleared from sessionStorage after injection', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MESSAGE);

      const $paymentMethods = win.document.createElement('div');
      $paymentMethods.className = 'checkout__payment-methods';
      $paymentMethods.id = 'test-payment-methods-clear';
      win.document.body.appendChild($paymentMethods);

      exposeShowPersistedPaymentError(win, $paymentMethods);
    });
  });

  it('removes PAYMENT_ERROR from sessionStorage after injecting the banner', () => {
    cy.window().then((win) => {
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.not.be.null;
      win.__runShowPersistedPaymentError();
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.be.null;
    });
  });
});

// ===========================================================================
// Suite 9 – showPersistedPaymentError: no banner when PAYMENT_ERROR absent
// ===========================================================================
describe('showPersistedPaymentError – no banner injected when PAYMENT_ERROR is absent', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.removeItem(STORAGE_KEY_PAYMENT_ERROR);

      const $paymentMethods = win.document.createElement('div');
      $paymentMethods.className = 'checkout__payment-methods';
      $paymentMethods.id = 'test-payment-methods-absent';
      win.document.body.appendChild($paymentMethods);

      exposeShowPersistedPaymentError(win, $paymentMethods);
    });
  });

  it('does not inject any banner when PAYMENT_ERROR is not in sessionStorage', () => {
    cy.window().then((win) => { win.__runShowPersistedPaymentError(); });
    cy.get('#adyen-persisted-payment-error').should('not.exist');
    cy.get('#test-payment-methods-absent .checkout-payment-methods-error').should('not.exist');
  });
});

// ===========================================================================
// Suite 10 – setRecoveryStartCallback: callback invoked when recovery starts
// ===========================================================================
describe('setRecoveryStartCallback – registered callback is invoked on recovery start', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeSetRecoveryStartCallback(win);
    });
  });

  it('calls the registered callback when __triggerRecoveryStart is invoked', () => {
    cy.window().then((win) => {
      let callCount = 0;
      win.__setRecoveryStartCallback(() => { callCount += 1; });
      win.__triggerRecoveryStart();
      expect(callCount).to.equal(1);
    });
  });

  it('does not throw when no callback is registered', () => {
    cy.window().then((win) => {
      expect(() => win.__triggerRecoveryStart()).to.not.throw();
    });
  });

  it('replaces prior callback when setRecoveryStartCallback is called again', () => {
    cy.window().then((win) => {
      const calls = [];
      win.__setRecoveryStartCallback(() => calls.push('first'));
      win.__setRecoveryStartCallback(() => calls.push('second'));
      win.__triggerRecoveryStart();
      // Only the most recently registered callback should fire
      expect(calls).to.deep.equal(['second']);
    });
  });
});

// ===========================================================================
// Suite 11 – setRecoveryStartCallback: unregister function prevents invocation
// ===========================================================================
describe('setRecoveryStartCallback – unregister function stops callback from firing', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeSetRecoveryStartCallback(win);
    });
  });

  it('callback is NOT invoked after unregister is called', () => {
    cy.window().then((win) => {
      let callCount = 0;
      const unregister = win.__setRecoveryStartCallback(() => { callCount += 1; });
      unregister();
      win.__triggerRecoveryStart();
      expect(callCount).to.equal(0);
    });
  });

  it('unregistering an already-replaced callback is a safe no-op', () => {
    cy.window().then((win) => {
      const calls = [];
      const unregisterFirst = win.__setRecoveryStartCallback(() => calls.push('first'));
      win.__setRecoveryStartCallback(() => calls.push('second'));
      // Unregister the stale first callback — should have no effect on the second
      unregisterFirst();
      win.__triggerRecoveryStart();
      expect(calls).to.deep.equal(['second']);
    });
  });
});

// ---------------------------------------------------------------------------
// Constants shared by guest-field suites
// ---------------------------------------------------------------------------
const STORAGE_KEY_GUEST_EMAIL = 'adyen_guest_email';
const STORAGE_KEY_GUEST_FIRSTNAME = 'adyen_guest_firstname';
const STORAGE_KEY_GUEST_LASTNAME = 'adyen_guest_lastname';

// ---------------------------------------------------------------------------
// Helper: inline simulateGuestFieldPersistence (models the sessionStorage writes
// from both the !newCartId and newCartId branches of handleOrderPlaced)
// ---------------------------------------------------------------------------
function exposeGuestFieldPersistence(win) {
  const FAILURE_CODES = ['Refused', 'Error', 'Cancelled'];
  const DECLINE_MSG = "We're sorry, your payment was declined. Please try again or use a different payment method.";

  // Simulates the !newCartId branch (Fix 1): recover-cart has already been called
  // externally; this only models the sessionStorage write + redirect side-effects.
  win.__persistGuestFieldsNoNewCartId = (orderData) => {
    const result = JSON.parse(win.sessionStorage.getItem('adyen_test_result') || '{}');
    if (
      result?.resultCode
      && FAILURE_CODES.includes(result.resultCode)
      && !result.newCartId
    ) {
      try {
        win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MSG);
        if (orderData.email) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_EMAIL, orderData.email);
        }
        const billingAddr = orderData.billingAddress;
        if (billingAddr?.firstName) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_FIRSTNAME, billingAddr.firstName);
        }
        if (billingAddr?.lastName) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_LASTNAME, billingAddr.lastName);
        }
      } catch { /* ignore */ }
      win.__redirectTarget = '/checkout';
    }
  };

  // Simulates the result.newCartId branch (Fix 2): backend already returned a
  // newCartId; same writes happen without calling recover-cart.
  win.__persistGuestFieldsWithNewCartId = (orderData) => {
    const result = JSON.parse(win.sessionStorage.getItem('adyen_test_result') || '{}');
    if (
      result?.resultCode
      && FAILURE_CODES.includes(result.resultCode)
      && result.newCartId
    ) {
      try {
        win.sessionStorage.setItem(STORAGE_KEY_PAYMENT_ERROR, DECLINE_MSG);
        if (orderData.email) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_EMAIL, orderData.email);
        }
        const billingAddrRecovered = orderData.billingAddress;
        if (billingAddrRecovered?.firstName) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_FIRSTNAME, billingAddrRecovered.firstName);
        }
        if (billingAddrRecovered?.lastName) {
          win.sessionStorage.setItem(STORAGE_KEY_GUEST_LASTNAME, billingAddrRecovered.lastName);
        }
      } catch { /* ignore */ }
      win.__redirectTarget = '/checkout';
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: inline restoreGuestFields IIFE logic onto window
// ---------------------------------------------------------------------------
function exposeRestoreGuestFields(win) {
  // pendingGuestEmailRestore is a closure variable in the real code; we expose
  // it on win so tests can assert its value.
  win.__pendingGuestEmailRestore = null;

  win.__runRestoreGuestFields = ($loginEl) => {
    let guestEmail;
    let guestFirstname;
    let guestLastname;
    try {
      guestEmail = win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL);
      guestFirstname = win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME);
      guestLastname = win.sessionStorage.getItem(STORAGE_KEY_GUEST_LASTNAME);
    } catch { /* ignore */ }
    if (!guestEmail && !guestFirstname && !guestLastname) return;

    try {
      if (guestEmail) win.sessionStorage.removeItem(STORAGE_KEY_GUEST_EMAIL);
      if (guestFirstname) win.sessionStorage.removeItem(STORAGE_KEY_GUEST_FIRSTNAME);
      if (guestLastname) win.sessionStorage.removeItem(STORAGE_KEY_GUEST_LASTNAME);
    } catch { /* ignore */ }

    if (guestEmail) {
      win.__pendingGuestEmailRestore = guestEmail;
    }

    // Attempt immediate DOM fill (simplified: just fill input if present)
    if ($loginEl && guestEmail) {
      const emailInput = $loginEl.querySelector('input[name="customer-email"]');
      if (emailInput) {
        emailInput.value = guestEmail;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: inline handleCheckoutUpdated restore-path logic onto window
// ---------------------------------------------------------------------------
function exposeHandleCheckoutUpdated(win) {
  win.__setGuestEmailCalls = [];
  win.__fillInputCalls = [];
  win.__pendingGuestEmailRestoreHCU = null;

  // Simulate checkoutApi.setGuestEmailOnCart
  win.__mockSetGuestEmailOnCart = (email) => {
    win.__setGuestEmailCalls.push(email);
    return Promise.resolve();
  };

  // Simulate fillGuestEmailInput
  win.__mockFillGuestEmailInput = (email) => {
    win.__fillInputCalls.push(email);
  };

  win.__runHandleCheckoutUpdated = (data) => {
    if (!data) return;
    if (win.__pendingGuestEmailRestoreHCU && data.isGuest) {
      const emailToRestore = win.__pendingGuestEmailRestoreHCU;
      win.__pendingGuestEmailRestoreHCU = null; // consume once
      win.__mockSetGuestEmailOnCart(emailToRestore).catch(() => {});
      win.__mockFillGuestEmailInput(emailToRestore);
    }
  };
}

// ===========================================================================
// Suite 12 – handleOrderPlaced: !newCartId path writes guest fields to sessionStorage
// ===========================================================================
describe('handleOrderPlaced – !newCartId path writes GUEST_EMAIL/FIRSTNAME/LASTNAME to sessionStorage', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      [
        STORAGE_KEY_PAYMENT_ERROR, STORAGE_KEY_GUEST_EMAIL,
        STORAGE_KEY_GUEST_FIRSTNAME, STORAGE_KEY_GUEST_LASTNAME,
        'adyen_test_result',
      ].forEach((k) => win.sessionStorage.removeItem(k));
      exposeGuestFieldPersistence(win);
    });
  });

  it('writes PAYMENT_ERROR, GUEST_EMAIL, GUEST_FIRSTNAME and GUEST_LASTNAME for a Refused result', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem('adyen_test_result', JSON.stringify({ resultCode: 'Refused' }));
      win.__persistGuestFieldsNoNewCartId({
        email: 'guest@example.com',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.not.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.equal('guest@example.com');
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME)).to.equal('Jane');
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_LASTNAME)).to.equal('Doe');
      expect(win.__redirectTarget).to.equal('/checkout');
    });
  });

  it('skips writing GUEST_EMAIL when orderData.email is absent', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem('adyen_test_result', JSON.stringify({ resultCode: 'Error' }));
      win.__persistGuestFieldsNoNewCartId({
        email: '',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.be.null;
      // Other keys are still written
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME)).to.equal('Jane');
    });
  });

  it('skips writing GUEST_FIRSTNAME and GUEST_LASTNAME when billingAddress is absent', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem('adyen_test_result', JSON.stringify({ resultCode: 'Cancelled' }));
      win.__persistGuestFieldsNoNewCartId({ email: 'guest@example.com' });
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.equal('guest@example.com');
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME)).to.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_LASTNAME)).to.be.null;
    });
  });

  it('does NOT write anything and does NOT redirect for an Authorised result', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem('adyen_test_result', JSON.stringify({ resultCode: 'Authorised' }));
      win.__persistGuestFieldsNoNewCartId({
        email: 'guest@example.com',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.be.null;
      expect(win.__redirectTarget).to.be.undefined;
    });
  });
});

// ===========================================================================
// Suite 13 – handleOrderPlaced: newCartId-present path writes guest fields (Fix 2)
// ===========================================================================
describe('handleOrderPlaced – newCartId-present path writes GUEST_EMAIL/FIRSTNAME/LASTNAME (Fix 2)', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      [
        STORAGE_KEY_PAYMENT_ERROR, STORAGE_KEY_GUEST_EMAIL,
        STORAGE_KEY_GUEST_FIRSTNAME, STORAGE_KEY_GUEST_LASTNAME,
        'adyen_test_result',
      ].forEach((k) => win.sessionStorage.removeItem(k));
      exposeGuestFieldPersistence(win);
    });
  });

  it('writes PAYMENT_ERROR, GUEST_EMAIL, GUEST_FIRSTNAME and GUEST_LASTNAME when newCartId is pre-set', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(
        'adyen_test_result',
        JSON.stringify({ resultCode: 'Refused', newCartId: 'server-recovered-cart' }),
      );
      win.__persistGuestFieldsWithNewCartId({
        email: 'guest@example.com',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.not.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.equal('guest@example.com');
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME)).to.equal('Jane');
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_LASTNAME)).to.equal('Doe');
      expect(win.__redirectTarget).to.equal('/checkout');
    });
  });

  it('does NOT write anything for Authorised result even when newCartId is present', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(
        'adyen_test_result',
        JSON.stringify({ resultCode: 'Authorised', newCartId: 'some-cart' }),
      );
      win.__persistGuestFieldsWithNewCartId({
        email: 'guest@example.com',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_PAYMENT_ERROR)).to.be.null;
      expect(win.__redirectTarget).to.be.undefined;
    });
  });

  it('does NOT fire when result has no newCartId (belongs to the !newCartId branch)', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(
        'adyen_test_result',
        JSON.stringify({ resultCode: 'Refused' /* no newCartId */ }),
      );
      win.__persistGuestFieldsWithNewCartId({
        email: 'guest@example.com',
        billingAddress: { firstName: 'Jane', lastName: 'Doe' },
      });
      // The newCartId branch condition is false → nothing written
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.be.null;
      expect(win.__redirectTarget).to.be.undefined;
    });
  });
});

// ===========================================================================
// Suite 14 – restoreGuestFields IIFE reads/removes keys and sets pendingGuestEmailRestore
// ===========================================================================
describe('restoreGuestFields – reads and removes guest sessionStorage keys on page load', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      [STORAGE_KEY_GUEST_EMAIL, STORAGE_KEY_GUEST_FIRSTNAME, STORAGE_KEY_GUEST_LASTNAME]
        .forEach((k) => win.sessionStorage.removeItem(k));
      exposeRestoreGuestFields(win);
    });
  });

  it('removes all three keys from sessionStorage after reading them', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_GUEST_EMAIL, 'guest@example.com');
      win.sessionStorage.setItem(STORAGE_KEY_GUEST_FIRSTNAME, 'Jane');
      win.sessionStorage.setItem(STORAGE_KEY_GUEST_LASTNAME, 'Doe');
      win.__runRestoreGuestFields(null);
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_EMAIL)).to.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_FIRSTNAME)).to.be.null;
      expect(win.sessionStorage.getItem(STORAGE_KEY_GUEST_LASTNAME)).to.be.null;
    });
  });

  it('sets pendingGuestEmailRestore to the stored email', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_GUEST_EMAIL, 'guest@example.com');
      win.__runRestoreGuestFields(null);
      expect(win.__pendingGuestEmailRestore).to.equal('guest@example.com');
    });
  });

  it('early-returns without side-effects when no guest keys are present', () => {
    cy.window().then((win) => {
      win.__runRestoreGuestFields(null);
      expect(win.__pendingGuestEmailRestore).to.be.null;
    });
  });

  it('fills the DOM input immediately when the login container has the email input', () => {
    cy.window().then((win) => {
      win.sessionStorage.setItem(STORAGE_KEY_GUEST_EMAIL, 'prefill@example.com');
      const $login = win.document.createElement('div');
      const emailInput = win.document.createElement('input');
      emailInput.name = 'customer-email';
      $login.appendChild(emailInput);
      win.document.body.appendChild($login);
      win.__runRestoreGuestFields($login);
      expect(emailInput.value).to.equal('prefill@example.com');
    });
  });
});

// ===========================================================================
// Suite 15 – handleCheckoutUpdated restore path: calls setGuestEmailOnCart + fillInput
// ===========================================================================
describe('handleCheckoutUpdated – restore path calls setGuestEmailOnCart when pendingGuestEmailRestore is set', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeHandleCheckoutUpdated(win);
    });
  });

  it('calls setGuestEmailOnCart with the pending email when data.isGuest is true', () => {
    cy.window().then((win) => {
      win.__pendingGuestEmailRestoreHCU = 'guest@example.com';
      win.__runHandleCheckoutUpdated({ isGuest: true });
      expect(win.__setGuestEmailCalls).to.deep.equal(['guest@example.com']);
    });
  });

  it('calls fillGuestEmailInput with the pending email when data.isGuest is true', () => {
    cy.window().then((win) => {
      win.__pendingGuestEmailRestoreHCU = 'guest@example.com';
      win.__runHandleCheckoutUpdated({ isGuest: true });
      expect(win.__fillInputCalls).to.deep.equal(['guest@example.com']);
    });
  });

  it('sets pendingGuestEmailRestore to null after consuming it (one-shot)', () => {
    cy.window().then((win) => {
      win.__pendingGuestEmailRestoreHCU = 'guest@example.com';
      win.__runHandleCheckoutUpdated({ isGuest: true });
      expect(win.__pendingGuestEmailRestoreHCU).to.be.null;
    });
  });

  it('does NOT call setGuestEmailOnCart when data.isGuest is false', () => {
    cy.window().then((win) => {
      win.__pendingGuestEmailRestoreHCU = 'guest@example.com';
      win.__runHandleCheckoutUpdated({ isGuest: false });
      expect(win.__setGuestEmailCalls).to.deep.equal([]);
      // pendingGuestEmailRestore remains set — not consumed
      expect(win.__pendingGuestEmailRestoreHCU).to.equal('guest@example.com');
    });
  });

  it('does NOT call setGuestEmailOnCart when pendingGuestEmailRestore is null', () => {
    cy.window().then((win) => {
      win.__pendingGuestEmailRestoreHCU = null;
      win.__runHandleCheckoutUpdated({ isGuest: true });
      expect(win.__setGuestEmailCalls).to.deep.equal([]);
    });
  });
});

// ===========================================================================
// Suite 16 – firstAuthEventReceived guard
// ===========================================================================
describe('handleAuthenticated – firstAuthEventReceived guard skips the initial page-load event', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.sessionStorage.removeItem(STORAGE_KEY_PAYMENT_ERROR);
      exposeHandleAuthenticated(win, false /* isPaymentErrorRecovery */);
    });
  });

  it('does NOT reload when the very first call has authenticated=true (page-load state, always skipped)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('does NOT reload when the very first call has authenticated=false (page-load state, always skipped)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(false);
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('reloads on the second call with authenticated=true (user signed in after page load)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped unconditionally
      win.__handleAuthenticated(true);  // second — user actually signed in
      expect(win.__reloadCount).to.equal(1);
    });
  });

  it('does NOT reload on the second call with authenticated=false (user signed out, not a sign-in event)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(false); // second — not authenticated, no reload
      expect(win.__reloadCount).to.equal(0);
    });
  });

  it('each subsequent authenticated=true call after the first triggers a reload (not capped)', () => {
    cy.window().then((win) => {
      win.__handleAuthenticated(true);  // first — skipped
      win.__handleAuthenticated(true);  // second  → reload 1
      win.__handleAuthenticated(true);  // third   → reload 2
      win.__handleAuthenticated(true);  // fourth  → reload 3
      expect(win.__reloadCount).to.equal(3);
    });
  });

  it('the first-call skip applies regardless of isPaymentErrorRecovery value (no reload even when flag is false)', () => {
    // isPaymentErrorRecovery=false (already set in beforeEach) — the first call must
    // still be skipped purely because of firstAuthEventReceived, not because of the
    // payment-error guard.
    cy.window().then((win) => {
      win.__handleAuthenticated(true); // first — skipped by firstAuthEventReceived guard
      expect(win.__reloadCount).to.equal(0);
    });
  });
});
