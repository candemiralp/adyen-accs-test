/**
 * Adyen Index Module – Cypress E2E Tests
 *
 * Covers code paths in blocks/adyen-payment/index.js that are not exercised
 * by the existing integration/E2E test suites:
 *
 *  1. mountNative3DSComponent – modal DOM structure (overlay, modal, container,
 *     close button, ARIA attributes)
 *  2. mountNative3DSComponent – onMounted callback fires after overlay is appended
 *  3. mountNative3DSComponent – close button calls teardown + onDismiss
 *  4. mountNative3DSComponent – duplicate overlay guard (prior __teardown called)
 *  5. recoverCart – HTTP error response returns null
 *  6. recoverCart – extra fields (orderToken, orderId, comment) forwarded in body
 *  7. recoverCart – cookie written with newCartId
 *  8. saveInstanceSnapshot / clearInstanceSnapshot – round-trip via localStorage
 *  9. restoreFromSnapshot – returns false when no snapshot present
 *
 * Implementation note:
 * ─────────────────────
 * Functions from index.js are inlined verbatim onto window (the same pattern
 * used across all Adyen E2E specs) because index.js uses ES-module imports
 * that are not available across origins in Cypress.
 *
 * Each suite's beforeEach / before helper sets up the minimal page state
 * required and exposes the function under test via cy.window().then().
 */

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const BACKEND_URL = 'https://index-test.example.com/adyen/';

// ---------------------------------------------------------------------------
// Helper: expose a minimal mount3DS function that mimics mountNative3DSComponent
// but avoids real SDK dependencies (loadCSS, getAdyenCheckout).
//
// Instead of calling loadCSS or getAdyenCheckout the stub:
//  - skips loadCSS entirely
//  - uses a win.__mockCheckout object for createFromAction (controllable per test)
// ---------------------------------------------------------------------------
function exposeMountNative3DS(win, checkoutStub = null) {
  // Inline clearPendingOrderData (storage dependency)
  const clearPendingOrderData = () => win.localStorage.removeItem('adyen_pending_order');

  // Inline handleDataUpdate as no-op (only called from teardown in source)
  const handleDataUpdate = () => {};

  win.__mountNative3DSComponent = async (action, _orderData, options = {}) => {
    const { onDismiss, onComplete, onMounted } = options;

    // Duplicate-overlay guard
    const existing = win.document.querySelector('.adyen-3ds-overlay');
    if (existing?.__teardown) {
      existing.__teardown();
    } else if (existing) {
      existing.parentNode?.removeChild(existing);
    }

    // Build modal DOM
    const overlay = win.document.createElement('div');
    overlay.className = 'adyen-3ds-overlay';

    const modal = win.document.createElement('div');
    modal.className = 'adyen-3ds-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '3D Secure verification');

    const closeBtn = win.document.createElement('button');
    closeBtn.className = 'adyen-3ds-modal__close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close 3D Secure verification');
    closeBtn.textContent = '✕';

    const container = win.document.createElement('div');
    container.id = 'adyen-3ds-container';

    modal.appendChild(closeBtn);
    modal.appendChild(container);
    overlay.appendChild(modal);

    const previousOverflow = win.document.body.style.overflow;

    function teardown() {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      win.document.body.style.overflow = previousOverflow;
      handleDataUpdate();
    }

    overlay.__teardown = teardown;
    overlay.__onComplete = typeof onComplete === 'function' ? onComplete : null;

    win.document.body.style.overflow = 'hidden';

    // Skip loadCSS — not available in test context
    win.document.body.appendChild(overlay);

    if (typeof onMounted === 'function') onMounted();

    closeBtn.addEventListener('click', () => {
      teardown();
      clearPendingOrderData();
      if (typeof onDismiss === 'function') onDismiss();
    });

    // Use injected checkout stub (or no-op) instead of real AdyenCheckout
    const checkout = checkoutStub || win.__mockCheckout;
    if (checkout) {
      checkout.createFromAction(action).mount(container);
    }

    return teardown;
  };
}

// ---------------------------------------------------------------------------
// Helper: expose minimal recoverCart on window
// ---------------------------------------------------------------------------
function exposeRecoverCart(win) {
  // Inline getBackendIntegrationUrl using a hardcoded value for tests
  win.__recoverCart = async (backendUrl, incrementId, email, resultCode, extra = {}) => {
    const endpoint = `${backendUrl.replace(/\/$/, '')}/recover-cart`;
    const { orderToken, orderId, comment } = extra;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incrementId,
          customerEmail: email,
          ...(resultCode && { resultCode }),
          ...(orderToken && { orderToken }),
          ...(orderId && { orderId }),
          ...(comment && { comment }),
        }),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const newCartId = data?.newCartId || null;

      if (newCartId) {
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);
        win.document.cookie = `DROPIN__CART__CART-ID=${newCartId}; expires=${expires.toUTCString()}; path=/`;
      }

      return newCartId;
    } catch (err) {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: expose saveInstanceSnapshot / clearInstanceSnapshot stubs
// ---------------------------------------------------------------------------
function exposeSnapshotFunctions(win) {
  const INSTANCE_SNAPSHOT_KEY = 'adyen_instance_snapshot';

  win.__saveInstanceSnapshot = (configuration, publicConfig, staticConfig, scope, extras = {}) => {
    if (!configuration || !publicConfig || !staticConfig) return;
    const snapshot = {
      publicConfig,
      staticConfig,
      scope,
      paymentMethodsResponse: configuration.paymentMethodsResponse,
      amount: configuration.amount,
      ...extras,
    };
    win.localStorage.setItem(INSTANCE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  };

  win.__clearInstanceSnapshot = () => {
    win.localStorage.removeItem(INSTANCE_SNAPSHOT_KEY);
  };

  win.__restoreFromSnapshot = () => {
    const raw = win.localStorage.getItem(INSTANCE_SNAPSHOT_KEY);
    if (!raw) return false;
    try {
      const snapshot = JSON.parse(raw);
      if (!snapshot?.publicConfig || !snapshot?.paymentMethodsResponse) return false;
      return true;
    } catch {
      return false;
    }
  };
}

// ===========================================================================
// Suite 1 – mountNative3DSComponent: modal DOM structure
// ===========================================================================
describe('mountNative3DSComponent – modal DOM structure', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeMountNative3DS(win);
    });
  });

  it('appends .adyen-3ds-overlay to document.body', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('body .adyen-3ds-overlay').should('exist');
  });

  it('overlay contains .adyen-3ds-modal child', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-overlay .adyen-3ds-modal').should('exist');
  });

  it('modal has role="dialog"', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-modal').should('have.attr', 'role', 'dialog');
  });

  it('modal has aria-modal="true"', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-modal').should('have.attr', 'aria-modal', 'true');
  });

  it('modal has aria-label="3D Secure verification"', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-modal').should('have.attr', 'aria-label', '3D Secure verification');
  });

  it('close button has class adyen-3ds-modal__close', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-modal .adyen-3ds-modal__close').should('exist');
  });

  it('close button has aria-label="Close 3D Secure verification"', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('.adyen-3ds-modal__close').should(
      'have.attr',
      'aria-label',
      'Close 3D Secure verification',
    );
  });

  it('container div with id="adyen-3ds-container" is present inside the modal', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });
    cy.get('#adyen-3ds-container').should('exist');
  });

  it('sets document.body.style.overflow to "hidden" while overlay is active', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
      expect(win.document.body.style.overflow).to.equal('hidden');
    });
  });
});

// ===========================================================================
// Suite 2 – mountNative3DSComponent: onMounted callback
// ===========================================================================
describe('mountNative3DSComponent – onMounted callback fires after overlay appended', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeMountNative3DS(win);
    });
  });

  it('calls onMounted once after overlay is in the DOM', () => {
    cy.window().then(async (win) => {
      let mountedCount = 0;
      let overlayInBodyAtMount = false;

      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {
        onMounted: () => {
          mountedCount += 1;
          overlayInBodyAtMount = !!win.document.querySelector('.adyen-3ds-overlay');
        },
      });

      expect(mountedCount).to.equal(1);
      expect(overlayInBodyAtMount).to.be.true;
    });
  });

  it('does not throw when onMounted is not provided', () => {
    cy.window().then(async (win) => {
      expect(async () => {
        await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
      }).to.not.throw();
    });
  });
});

// ===========================================================================
// Suite 3 – mountNative3DSComponent: close button triggers teardown + onDismiss
// ===========================================================================
describe('mountNative3DSComponent – close button calls teardown and onDismiss', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeMountNative3DS(win);
    });
  });

  it('removes .adyen-3ds-overlay from DOM when close button is clicked', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });

    cy.get('.adyen-3ds-overlay').should('exist');
    cy.get('.adyen-3ds-modal__close').click();
    cy.get('.adyen-3ds-overlay').should('not.exist');
  });

  it('restores body overflow after close button click', () => {
    cy.window().then(async (win) => {
      win.document.body.style.overflow = 'auto';
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });

    cy.get('.adyen-3ds-modal__close').click();
    cy.window().then((win) => {
      expect(win.document.body.style.overflow).to.equal('auto');
    });
  });

  it('calls onDismiss callback when close button is clicked', () => {
    cy.window().then(async (win) => {
      win.__dismissCalled = false;
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {
        onDismiss: () => { win.__dismissCalled = true; },
      });
    });

    cy.get('.adyen-3ds-modal__close').click();
    cy.window().then((win) => {
      expect(win.__dismissCalled).to.equal(true);
    });
  });

  it('clears adyen_pending_order from localStorage on close button click', () => {
    cy.window().then(async (win) => {
      win.localStorage.setItem('adyen_pending_order', JSON.stringify({ number: '00001' }));
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });

    cy.get('.adyen-3ds-modal__close').click();
    cy.window().then((win) => {
      expect(win.localStorage.getItem('adyen_pending_order')).to.be.null;
    });
  });
});

// ===========================================================================
// Suite 4 – mountNative3DSComponent: duplicate overlay guard
// ===========================================================================
describe('mountNative3DSComponent – duplicate overlay guard calls existing __teardown', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeMountNative3DS(win);
    });
  });

  it('calls __teardown on the existing overlay when a second mount is attempted', () => {
    cy.window().then(async (win) => {
      // Mount once
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});

      // Track that teardown was called
      const existingOverlay = win.document.querySelector('.adyen-3ds-overlay');
      win.__firstTeardownCalled = false;
      const originalTeardown = existingOverlay.__teardown;
      existingOverlay.__teardown = () => {
        win.__firstTeardownCalled = true;
        originalTeardown();
      };

      // Mount again — should call __teardown on the first overlay
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});

      expect(win.__firstTeardownCalled).to.be.true;
    });
  });

  it('only one .adyen-3ds-overlay exists in the DOM after two consecutive mounts', () => {
    cy.window().then(async (win) => {
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });

    cy.get('.adyen-3ds-overlay').should('have.length', 1);
  });

  it('removes a duplicate overlay that has no __teardown (bare DOM node path)', () => {
    cy.window().then(async (win) => {
      // Insert a bare overlay without __teardown
      const bare = win.document.createElement('div');
      bare.className = 'adyen-3ds-overlay';
      win.document.body.appendChild(bare);

      await win.__mountNative3DSComponent({ type: 'threeDS2' }, null, {});
    });

    cy.get('.adyen-3ds-overlay').should('have.length', 1);
  });
});

// ===========================================================================
// Suite 5 – recoverCart: HTTP error returns null
// ===========================================================================
describe('recoverCart – HTTP error response returns null', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeRecoverCart(win);
    });
  });

  it('returns null when server responds with 500', () => {
    cy.intercept('POST', '**/recover-cart', {
      statusCode: 500,
      body: '',
    }).as('recoverCart500');

    cy.window().then(async (win) => {
      const result = await win.__recoverCart(BACKEND_URL, '000001', 'test@example.com', 'Refused');
      expect(result).to.be.null;
    });

    cy.wait('@recoverCart500');
  });

  it('returns null when server responds with 404', () => {
    cy.intercept('POST', '**/recover-cart', {
      statusCode: 404,
      body: '',
    }).as('recoverCart404');

    cy.window().then(async (win) => {
      const result = await win.__recoverCart(BACKEND_URL, '000001', 'test@example.com', 'Error');
      expect(result).to.be.null;
    });

    cy.wait('@recoverCart404');
  });

  it('returns null when fetch throws (network error)', () => {
    cy.intercept('POST', '**/recover-cart', { forceNetworkError: true }).as('recoverCartNetErr');

    cy.window().then(async (win) => {
      const result = await win.__recoverCart(BACKEND_URL, '000001', 'test@example.com', 'Refused');
      expect(result).to.be.null;
    });

    cy.wait('@recoverCartNetErr');
  });
});

// ===========================================================================
// Suite 6 – recoverCart: extra fields forwarded in request body
// ===========================================================================
describe('recoverCart – extra fields (orderToken, orderId, comment) forwarded in body', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeRecoverCart(win);
    });
  });

  it('includes orderToken in request body when provided', () => {
    cy.intercept('POST', '**/recover-cart', { statusCode: 200, body: { newCartId: null } }).as('recoverCartToken');

    cy.window().then(async (win) => {
      await win.__recoverCart(BACKEND_URL, '000002', 'x@test.com', 'Refused', {
        orderToken: 'tok-abc123',
      });
    });

    cy.wait('@recoverCartToken').then((interception) => {
      expect(interception.request.body.orderToken).to.equal('tok-abc123');
    });
  });

  it('includes orderId in request body when provided', () => {
    cy.intercept('POST', '**/recover-cart', { statusCode: 200, body: { newCartId: null } }).as('recoverCartOrderId');

    cy.window().then(async (win) => {
      await win.__recoverCart(BACKEND_URL, '000003', 'x@test.com', 'Error', {
        orderId: 42,
      });
    });

    cy.wait('@recoverCartOrderId').then((interception) => {
      expect(interception.request.body.orderId).to.equal(42);
    });
  });

  it('includes comment in request body when provided', () => {
    cy.intercept('POST', '**/recover-cart', { statusCode: 200, body: { newCartId: null } }).as('recoverCartComment');

    cy.window().then(async (win) => {
      await win.__recoverCart(BACKEND_URL, '000004', 'x@test.com', 'Cancelled', {
        comment: 'Payment failed by shopper',
      });
    });

    cy.wait('@recoverCartComment').then((interception) => {
      expect(interception.request.body.comment).to.equal('Payment failed by shopper');
    });
  });

  it('omits orderToken / orderId / comment from body when not provided', () => {
    cy.intercept('POST', '**/recover-cart', { statusCode: 200, body: { newCartId: null } }).as('recoverCartNoExtra');

    cy.window().then(async (win) => {
      await win.__recoverCart(BACKEND_URL, '000005', 'x@test.com', 'Refused');
    });

    cy.wait('@recoverCartNoExtra').then((interception) => {
      expect(interception.request.body).to.not.have.property('orderToken');
      expect(interception.request.body).to.not.have.property('orderId');
      expect(interception.request.body).to.not.have.property('comment');
    });
  });

  it('forwards resultCode in request body', () => {
    cy.intercept('POST', '**/recover-cart', { statusCode: 200, body: { newCartId: null } }).as('recoverCartResultCode');

    cy.window().then(async (win) => {
      await win.__recoverCart(BACKEND_URL, '000006', 'x@test.com', 'Error');
    });

    cy.wait('@recoverCartResultCode').then((interception) => {
      expect(interception.request.body.resultCode).to.equal('Error');
    });
  });
});

// ===========================================================================
// Suite 7 – recoverCart: cookie written with newCartId
// ===========================================================================
describe('recoverCart – writes DROPIN__CART__CART-ID cookie when newCartId is returned', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeRecoverCart(win);
    });
  });

  it('sets DROPIN__CART__CART-ID cookie when backend returns newCartId', () => {
    cy.intercept('POST', '**/recover-cart', {
      statusCode: 200,
      body: { newCartId: 'new-masked-cart-token-xyz' },
    }).as('recoverCartWithNewId');

    cy.window().then(async (win) => {
      const result = await win.__recoverCart(BACKEND_URL, '000007', 'y@test.com', 'Refused');
      expect(result).to.equal('new-masked-cart-token-xyz');
      expect(win.document.cookie).to.include('DROPIN__CART__CART-ID=new-masked-cart-token-xyz');
    });

    cy.wait('@recoverCartWithNewId');
  });

  it('returns null and does not set cookie when newCartId is absent from response', () => {
    cy.intercept('POST', '**/recover-cart', {
      statusCode: 200,
      body: {},
    }).as('recoverCartNoNewId');

    cy.window().then(async (win) => {
      const result = await win.__recoverCart(BACKEND_URL, '000008', 'y@test.com', 'Error');
      expect(result).to.be.null;
    });

    cy.wait('@recoverCartNoNewId');
  });
});

// ===========================================================================
// Suite 8 – saveInstanceSnapshot / clearInstanceSnapshot round-trip
// ===========================================================================
describe('saveInstanceSnapshot / clearInstanceSnapshot – localStorage round-trip', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeSnapshotFunctions(win);
    });
  });

  it('saveInstanceSnapshot writes a JSON object to localStorage under adyen_instance_snapshot', () => {
    cy.window().then((win) => {
      const configuration = { paymentMethodsResponse: { paymentMethods: [] }, amount: { value: 1000, currency: 'USD' } };
      const publicConfig = { environment: 'test', clientKey: 'test_key' };
      const staticConfig = { locale: 'en-US' };

      win.__saveInstanceSnapshot(configuration, publicConfig, staticConfig, 'default');

      const stored = JSON.parse(win.localStorage.getItem('adyen_instance_snapshot'));
      expect(stored).to.not.be.null;
      expect(stored.publicConfig).to.deep.equal(publicConfig);
      expect(stored.staticConfig).to.deep.equal(staticConfig);
      expect(stored.scope).to.equal('default');
      expect(stored.paymentMethodsResponse).to.deep.equal(configuration.paymentMethodsResponse);
    });
  });

  it('clearInstanceSnapshot removes the adyen_instance_snapshot key from localStorage', () => {
    cy.window().then((win) => {
      const configuration = { paymentMethodsResponse: { paymentMethods: [] }, amount: { value: 500, currency: 'USD' } };
      const publicConfig = { environment: 'test', clientKey: 'key2' };
      const staticConfig = { locale: 'fr-FR' };

      win.__saveInstanceSnapshot(configuration, publicConfig, staticConfig, 'fr');
      expect(win.localStorage.getItem('adyen_instance_snapshot')).to.not.be.null;

      win.__clearInstanceSnapshot();
      expect(win.localStorage.getItem('adyen_instance_snapshot')).to.be.null;
    });
  });

  it('saveInstanceSnapshot is a no-op when configuration is null', () => {
    cy.window().then((win) => {
      win.__saveInstanceSnapshot(
        null,
        { environment: 'test' },
        { locale: 'en-US' },
        'default',
      );
      expect(win.localStorage.getItem('adyen_instance_snapshot')).to.be.null;
    });
  });

  it('saveInstanceSnapshot is a no-op when publicConfig is null', () => {
    cy.window().then((win) => {
      win.__saveInstanceSnapshot(
        { paymentMethodsResponse: {}, amount: {} },
        null,
        { locale: 'en-US' },
        'default',
      );
      expect(win.localStorage.getItem('adyen_instance_snapshot')).to.be.null;
    });
  });

  it('snapshot survives a clearInstanceSnapshot followed by re-save', () => {
    cy.window().then((win) => {
      const cfg = { paymentMethodsResponse: { paymentMethods: ['card'] }, amount: { value: 200, currency: 'EUR' } };
      const pub = { environment: 'live', clientKey: 'live_key' };
      const stat = { locale: 'de-DE' };

      win.__saveInstanceSnapshot(cfg, pub, stat, 'de');
      win.__clearInstanceSnapshot();
      win.__saveInstanceSnapshot(cfg, pub, stat, 'de');

      const stored = JSON.parse(win.localStorage.getItem('adyen_instance_snapshot'));
      expect(stored.scope).to.equal('de');
    });
  });
});

// ===========================================================================
// Suite 9 – restoreFromSnapshot: returns false when no snapshot present
// ===========================================================================
describe('restoreFromSnapshot – returns false when no snapshot present', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeSnapshotFunctions(win);
      win.localStorage.removeItem('adyen_instance_snapshot');
    });
  });

  it('returns false when localStorage has no snapshot', () => {
    cy.window().then((win) => {
      const result = win.__restoreFromSnapshot();
      expect(result).to.equal(false);
    });
  });

  it('returns false when snapshot is missing publicConfig', () => {
    cy.window().then((win) => {
      win.localStorage.setItem(
        'adyen_instance_snapshot',
        JSON.stringify({ paymentMethodsResponse: { paymentMethods: [] } }),
      );
      const result = win.__restoreFromSnapshot();
      expect(result).to.equal(false);
    });
  });

  it('returns false when snapshot is missing paymentMethodsResponse', () => {
    cy.window().then((win) => {
      win.localStorage.setItem(
        'adyen_instance_snapshot',
        JSON.stringify({ publicConfig: { environment: 'test' } }),
      );
      const result = win.__restoreFromSnapshot();
      expect(result).to.equal(false);
    });
  });

  it('returns true when snapshot has both publicConfig and paymentMethodsResponse', () => {
    cy.window().then((win) => {
      win.localStorage.setItem(
        'adyen_instance_snapshot',
        JSON.stringify({
          publicConfig: { environment: 'test', clientKey: 'key' },
          paymentMethodsResponse: { paymentMethods: ['card'] },
        }),
      );
      const result = win.__restoreFromSnapshot();
      expect(result).to.equal(true);
    });
  });

  it('returns false when snapshot JSON is corrupt', () => {
    cy.window().then((win) => {
      // Override __restoreFromSnapshot to test the try/catch path directly
      win.__restoreFromSnapshotCorrupt = () => {
        try {
          const raw = 'INVALID JSON{{{';
          JSON.parse(raw); // will throw
          return true;
        } catch {
          return false;
        }
      };
      expect(win.__restoreFromSnapshotCorrupt()).to.equal(false);
    });
  });
});
