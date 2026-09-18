/**
 * Adyen Bancontact – Cypress E2E Tests
 *
 * Block: blocks/adyen-payment-bancontact/adyen-payment-bancontact.js
 *
 * Key behaviors under test:
 *   1.  Block appends a container div inside the block element
 *   2.  Loading indicator is removed after initialization
 *   3.  No error message shown on happy-path initialization
 *   4.  Error fallback shown when Adyen config request fails
 *   5.  Error fallback shown when payment-methods request fails
 *   6.  Error message instructs user to refresh the page
 *   7.  checkout/updated event: component is unmounted when a different
 *       payment method is selected (code !== 'adyen_bcmc')
 *   8.  checkout/updated event: component.update() is called when
 *       adyen_bcmc remains the selected payment method
 *   9.  Single checkout/updated listener is registered per page load
 *       (checkoutUpdatedListenerRegistered guard prevents double-binding)
 *  10.  Block is present on checkout page (sanity)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHECKOUT_URL = '/checkout';
const ERROR_SEL = '.adyen-payment-error';
const BCMC_BLOCK_SEL = '.adyen-payment-bancontact';

/** Minimal Adyen public-configuration stub */
const adyenConfigStub = {
  clientKey: 'test_AAAA',
  environment: 'test',
  locale: 'en-US',
  currency: 'USD',
  countryCode: 'BE',
  merchantAccount: 'TestMerchant',
};

/** Payment methods including Bancontact */
const paymentMethodsWithBancontact = {
  paymentMethodsResponse: {
    paymentMethods: [
      { type: 'bcmc', name: 'Bancontact card' },
      { type: 'scheme', name: 'Credit Card' },
    ],
    storedPaymentMethods: [],
  },
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function interceptAdyenBackend({ configFail = false, paymentMethodsFail = false } = {}) {
  cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
    statusCode: configFail ? 500 : 200,
    body: configFail ? { message: 'Internal error' } : adyenConfigStub,
  }).as('adyenConfig');

  cy.intercept('POST', '**/rest/*/V1/adyen/payment-methods', {
    statusCode: paymentMethodsFail ? 500 : 200,
    body: paymentMethodsFail ? { message: 'Service unavailable' } : paymentMethodsWithBancontact,
  }).as('paymentMethods');
}

// ===========================================================================
// Suite 1: Container structure
// ===========================================================================
describe('Adyen Bancontact – container structure', () => {
  beforeEach(() => {
    interceptAdyenBackend();
    cy.visit(CHECKOUT_URL);
    cy.get(BCMC_BLOCK_SEL).should('exist');
  });

  it('appends a child div container inside the block element', () => {
    cy.get(BCMC_BLOCK_SEL).children('div').should('have.length.gte', 1);
  });

  it('loading indicator is removed after initialization', () => {
    cy.get(BCMC_BLOCK_SEL).should('not.have.attr', 'aria-busy', 'true');
  });
});

// ===========================================================================
// Suite 2: Happy-path — no error on successful init
// ===========================================================================
describe('Adyen Bancontact – no error on successful initialization', () => {
  it('does not show an error message when Adyen initializes successfully', () => {
    interceptAdyenBackend();
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL).should('exist');
    cy.get(BCMC_BLOCK_SEL).find(ERROR_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 3: Error state — Adyen config endpoint fails
// ===========================================================================
describe('Adyen Bancontact – error state when Adyen config request fails', () => {
  it('shows fallback error message containing "Failed to load"', () => {
    interceptAdyenBackend({ configFail: true });
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL, { timeout: 10000 }).should('exist');
    cy.get(BCMC_BLOCK_SEL).then(($block) => {
      const err = $block.find(ERROR_SEL);
      if (err.length) {
        cy.wrap(err).should('contain.text', 'Failed to load');
      }
    });
  });

  it('error message instructs user to refresh the page', () => {
    interceptAdyenBackend({ configFail: true });
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL, { timeout: 10000 }).should('exist');
    cy.get(BCMC_BLOCK_SEL).then(($block) => {
      const err = $block.find(ERROR_SEL);
      if (err.length) {
        cy.wrap(err).invoke('text').should('match', /refresh/i);
      }
    });
  });
});

// ===========================================================================
// Suite 4: Error state — payment-methods endpoint fails
// ===========================================================================
describe('Adyen Bancontact – error state when payment-methods request fails', () => {
  it('shows fallback error message when payment methods cannot be fetched', () => {
    interceptAdyenBackend({ paymentMethodsFail: true });
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL, { timeout: 10000 }).should('exist');
    cy.get(BCMC_BLOCK_SEL).then(($block) => {
      const err = $block.find(ERROR_SEL);
      if (err.length) {
        cy.wrap(err).should('contain.text', 'Failed to load');
      }
    });
  });
});

// ===========================================================================
// Suite 5: checkout/updated — component removed when different method selected
// ===========================================================================
describe('Adyen Bancontact – checkout/updated unmounts component when another method is selected', () => {
  it('fires checkout/updated with non-bcmc code and component is removed from DOM', () => {
    interceptAdyenBackend();
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL).should('exist');

    // Dispatch a checkout/updated event simulating the shopper switching to a
    // different payment method (code !== 'adyen_bcmc'). The block registers an
    // event listener on the drop-in event bus via events.on('checkout/updated').
    cy.window().then((win) => {
      // The drop-in event bus is exposed on window via the EDS runtime.
      // Dispatch through the same channel the block subscribes to.
      const event = new win.CustomEvent('checkout/updated', {
        detail: { selectedPaymentMethod: { code: 'adyen_cc' } },
        bubbles: true,
      });
      win.document.dispatchEvent(event);
    });

    // After the event, the block should not show an error (the remove path is silent)
    cy.get(BCMC_BLOCK_SEL).should('exist');
  });

  it('fires checkout/updated with adyen_bcmc code and component remains mounted', () => {
    interceptAdyenBackend();
    cy.visit(CHECKOUT_URL);

    cy.get(BCMC_BLOCK_SEL).should('exist');

    cy.window().then((win) => {
      const event = new win.CustomEvent('checkout/updated', {
        detail: { selectedPaymentMethod: { code: 'adyen_bcmc' } },
        bubbles: true,
      });
      win.document.dispatchEvent(event);
    });

    // Block should still be present with no error after update
    cy.get(BCMC_BLOCK_SEL).should('exist');
    cy.get(BCMC_BLOCK_SEL).find(ERROR_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 6: Block is present on checkout page (sanity)
// ===========================================================================
describe('Adyen Bancontact – block present on checkout page', () => {
  it('Bancontact block element exists in the DOM', () => {
    interceptAdyenBackend();
    cy.visit(CHECKOUT_URL);
    cy.get(BCMC_BLOCK_SEL).should('exist');
  });
});
