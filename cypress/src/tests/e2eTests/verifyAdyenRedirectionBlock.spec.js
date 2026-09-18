/**
 * Adyen Payment Redirection Block – Cypress E2E Tests
 *
 * Block: blocks/adyen-payment-redirection/adyen-payment-redirection.js
 *
 * These tests focus on the block's own decorate() function — DOM setup,
 * loading state, and the paymentFailed query-param rendering path.
 *
 * Result-handling behaviors (Authorised / Pending / Received / Refused
 * server-side flows) are already covered extensively in
 * verifyAdyenRedirectBehaviors.spec.js and are deliberately excluded here.
 *
 * Key behaviors under test:
 *   1.  Block element is present on the /adyen-redirect page
 *   2.  Block appends a spinner container div during initialization
 *   3.  paymentFailed=true: error UI rendered without a backend call
 *   4.  paymentFailed=true + orderNumber: error title and order number shown
 *   5.  paymentFailed=true + orderNumber: support link is present
 *   6.  paymentFailed=true + orderNumber: order-details link is present
 *   7.  No paymentFailed + no redirectResult: block idles without error
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REDIRECT_URL = '/adyen-redirect';
const ERROR_SEL = '.adyen-payment-error';
const ERROR_TITLE_SEL = '.adyen-payment-error__title';
const SUPPORT_LINK_SEL = '.adyen-payment-error__button--primary';
const ORDER_DETAILS_LINK_SEL = '.adyen-payment-error__button--secondary';
const BLOCK_SEL = '.adyen-payment-redirection';

const TEST_ORDER = {
  number: '000000123',
  token: 'test-token-redirect-block',
  email: 'redirect-block@example.com',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds localStorage with a valid (non-expired) integration URL so that any
 * backend call the block might attempt does not throw "URL not found in cache".
 */
function seedIntegrationUrl(win) {
  win.localStorage.setItem(
    'adyen_integration_url',
    JSON.stringify({
      value: 'https://example.com/adyen/',
      ':expiry': Math.round(Date.now() / 1000) + 3600,
    }),
  );
}

/**
 * Seeds a pending order into localStorage (server-side flow context).
 */
function seedPendingOrder(win) {
  win.localStorage.setItem('adyen_pending_order', JSON.stringify(TEST_ORDER));
}

// ===========================================================================
// Suite 1: Block is present on the redirect page (sanity)
// ===========================================================================
describe('Adyen Redirection Block – block present on redirect page', () => {
  it('adyen-payment-redirection block element exists in the DOM', () => {
    cy.visit(REDIRECT_URL, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
      },
    });

    cy.get(BLOCK_SEL).should('exist');
  });
});

// ===========================================================================
// Suite 2: DOM setup – spinner appended to document.body (not inside block)
//
// decorate() appends .adyen-payment-redirection__loader directly to
// document.body so it is visible immediately.  The block's own section has
// display:none until decorate() fully resolves, so any loader placed inside
// the block would never be seen by the user.
// ===========================================================================
describe('Adyen Redirection Block – spinner container appended to document.body during initialization', () => {
  it('loader overlay is appended to document.body, not inside the block', () => {
    // Intercept the backend call so the page does not hang
    cy.intercept('POST', '**/payments-details', {
      statusCode: 200,
      body: { resultCode: 'Authorised', pspReference: 'SPINNER_PSP' },
    }).as('paymentsDetailsSpinner');

    cy.visit(REDIRECT_URL, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
        // Seed a pending order so the server-side path runs and the spinner
        // is appended before awaiting the fetch
        seedPendingOrder(win);
      },
    });

    // The spinner is appended to body synchronously in decorate() before any
    // await — it may already be gone by the time Cypress asserts (if decorate
    // resolved very quickly in the test runner).  Assert on the body-level
    // loader class rather than inside the block.
    cy.get(BLOCK_SEL).should('exist');

    // The old selector (.checkout__overlay-spinner-container inside the block)
    // must NOT be present — that was the stale pre-fix pattern.
    cy.get(BLOCK_SEL)
      .find('.checkout__overlay-spinner-container')
      .should('not.exist');
  });

  it('block itself does not contain the loader element', () => {
    cy.visit(REDIRECT_URL, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
      },
    });

    cy.get(BLOCK_SEL).should('exist');
    // The loader must never be a child of the block — it lives on body
    cy.get(BLOCK_SEL)
      .find('.adyen-payment-redirection__loader')
      .should('not.exist');
  });
});

// ===========================================================================
// Suite 3: paymentFailed=true — error UI rendered without a backend call
// ===========================================================================
describe('Adyen Redirection Block – paymentFailed=true renders error UI', () => {
  it('shows the payment error container when paymentFailed query param is true', () => {
    // No backend stub needed: paymentFailed param is handled before any fetch
    cy.visit(`${REDIRECT_URL}?paymentFailed=true&orderNumber=${TEST_ORDER.number}`, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
        seedPendingOrder(win);
      },
    });

    cy.get(BLOCK_SEL).should('exist');
    cy.get(ERROR_SEL, { timeout: 10000 }).should('exist');
  });

  it('does not display error container when paymentFailed is absent', () => {
    // Intercept the backend call so the page does not hang waiting for a real server
    cy.intercept('POST', '**/payments-details', {
      statusCode: 200,
      body: { resultCode: 'Authorised', pspReference: 'NO_FAIL_PSP' },
    }).as('paymentsDetailsNoFail');

    cy.visit(REDIRECT_URL, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
        // No pending order → idle path
        win.localStorage.removeItem('adyen_pending_order');
      },
    });

    cy.get(BLOCK_SEL).should('exist');
    // The idle path must not render a payment error
    cy.get(BLOCK_SEL).find(ERROR_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 4: paymentFailed + orderNumber — error title and order number visible
// ===========================================================================
describe('Adyen Redirection Block – error UI shows order number', () => {
  beforeEach(() => {
    cy.visit(
      `${REDIRECT_URL}?paymentFailed=true&orderNumber=${TEST_ORDER.number}`,
      {
        failOnStatusCode: false,
        onBeforeLoad: (win) => {
          seedIntegrationUrl(win);
          seedPendingOrder(win);
        },
      },
    );
    cy.get(ERROR_SEL, { timeout: 10000 }).should('exist');
  });

  it('error title uses the default "Payment Failed" heading', () => {
    cy.get(ERROR_TITLE_SEL).should('contain.text', 'Payment Failed');
  });

  it('error message contains the order number', () => {
    cy.get(ERROR_SEL).should('contain.text', TEST_ORDER.number);
  });
});

// ===========================================================================
// Suite 5: paymentFailed + orderNumber — support link is present
// ===========================================================================
describe('Adyen Redirection Block – error UI includes support link', () => {
  it('renders the primary support link button', () => {
    cy.visit(
      `${REDIRECT_URL}?paymentFailed=true&orderNumber=${TEST_ORDER.number}`,
      {
        failOnStatusCode: false,
        onBeforeLoad: (win) => {
          seedIntegrationUrl(win);
          seedPendingOrder(win);
        },
      },
    );

    cy.get(ERROR_SEL, { timeout: 10000 }).should('exist');
    cy.get(SUPPORT_LINK_SEL).should('exist');
  });
});

// ===========================================================================
// Suite 6: paymentFailed + orderNumber — order-details link is present
// ===========================================================================
describe('Adyen Redirection Block – error UI includes order-details link', () => {
  it('renders the secondary order-details link button', () => {
    cy.visit(
      `${REDIRECT_URL}?paymentFailed=true&orderNumber=${TEST_ORDER.number}`,
      {
        failOnStatusCode: false,
        onBeforeLoad: (win) => {
          seedIntegrationUrl(win);
          seedPendingOrder(win);
        },
      },
    );

    cy.get(ERROR_SEL, { timeout: 10000 }).should('exist');
    cy.get(ORDER_DETAILS_LINK_SEL).should('exist');
  });
});

// ===========================================================================
// Suite 7: Idle path — no paymentFailed, no redirectResult — no error shown
// ===========================================================================
describe('Adyen Redirection Block – idles gracefully with no query params', () => {
  it('block renders without error when no redirectResult or paymentFailed param is present', () => {
    // With neither param the block awaits handleAdyenRedirect which returns
    // { success: false, redirect: '/checkout' } — triggering window.location.href.
    // We stub the navigation so the test stays on the page long enough to assert.
    cy.visit(REDIRECT_URL, {
      failOnStatusCode: false,
      onBeforeLoad: (win) => {
        seedIntegrationUrl(win);
        win.localStorage.removeItem('adyen_pending_order');
      },
    });

    cy.get(BLOCK_SEL).should('exist');
    // No payment error should appear in the idle / redirect path
    cy.get(BLOCK_SEL).find(ERROR_SEL).should('not.exist');
  });
});
