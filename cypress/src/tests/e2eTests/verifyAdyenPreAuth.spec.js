/**
 * Adyen 3DS2 Pre-Auth Flow – Cypress E2E Tests
 *
 * Covers the pre-auth flow executed inside handlePlaceOrder() before order
 * creation for adyen_scheme (new card only — not stored cards):
 *
 *  1. Frictionless pre-auth: resultCode 'Authorised' → placeOrder called, no modal
 *  2. 3DS2 fingerprint → AuthenticationFinished → placeOrder called
 *  3. 3DS2 fingerprint → ChallengeShopper → AuthenticationFinished → placeOrder called
 *  4. Pre-auth Refused → error shown, placeOrder NOT called
 *  5. 3DS2 modal dismissed by user → silent abort, placeOrder NOT called
 *  6. Stored card: pre-auth-payments NOT called, placeOrder called directly
 *  7. Non-scheme method (adyen_paypal): pre-auth NOT called, placeOrder called
 *  8. pre-auth-payments network error (500) → error surfaced, no order placed
 *  9. AuthenticationNotRequired → direct authorisation sent, placeOrder called, no modal
 *
 * Notes:
 *  - All suites stub the OOPE backend endpoints (**/pre-auth-payments and
 *    **/payments-details) so no live backend is needed.
 *  - cy.interceptConfig() is used to inject the backend URL into config.json.
 *  - The Adyen Web SDK iframes are cross-origin; we bypass them by stubbing
 *    window.__adyen_triggerPlaceOrder and monitoring the GraphQL placeOrder
 *    mutation intercept.
 */

import { adyenCreditCard, adyenPaypal } from '../../fixtures/index';

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
const CHECKOUT_URL = '/checkout';
const OVERLAY_SEL = '.adyen-3ds-overlay';
const ERROR_SEL = '.adyen-payment-error';
const PLACE_ORDER_BTN_SEL = '.checkout__place-order';
const CARD_BLOCK_SEL = '.adyen-payment-cards';

// ---------------------------------------------------------------------------
// Fixture bodies
// ---------------------------------------------------------------------------

/** Pre-auth response: frictionless Authorised (no 3DS action) */
const PRE_AUTH_AUTHORISED = {
  resultCode: 'Authorised',
  pspReference: 'FRICTIONLESS-001',
};

/** Pre-auth response: triggers 3DS2 fingerprinting */
const PRE_AUTH_3DS2_ACTION = {
  resultCode: 'IdentifyShopper',
  action: {
    type: 'threeDS2',
    subtype: 'fingerprint',
    token: 'eyJ0aHJlZURTTWV0aG9kTm90aWZpY2F0aW9uVVJMIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS8ifQ==',
    paymentData: 'PAYMENT-DATA-001',
  },
};

/** payments-details response: AuthenticationFinished (terminal — no challenge) */
const DETAILS_AUTH_FINISHED = {
  resultCode: 'AuthenticationFinished',
  pspReference: 'AUTH-FIN-001',
};

/** payments-details response: ChallengeShopper (intermediate — triggers challenge) */
const DETAILS_CHALLENGE_SHOPPER = {
  resultCode: 'ChallengeShopper',
  action: {
    type: 'threeDS2',
    subtype: 'challenge',
    token: 'eyJhY3NUcmFuc0lEIjoiYWJjMTIzIn0=',
    paymentData: 'PAYMENT-DATA-002',
  },
};

/** Pre-auth response: Refused */
const PRE_AUTH_REFUSED = {
  resultCode: 'Refused',
  refusalReason: 'Blocked Card',
  pspReference: 'REFUSED-001',
};

/** Pre-auth response: AuthenticationNotRequired (no 3DS needed — direct authorisation) */
const PRE_AUTH_AUTH_NOT_REQUIRED = {
  resultCode: 'AuthenticationNotRequired',
  pspReference: 'ANR-001',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets up config intercept and stubs the placeOrder GraphQL mutation.
 * Returns the alias for the placeOrder intercept.
 */
function setupBaseIntercepts() {
  cy.interceptConfig((config) => ({
    ...config,
    'adyen-backend-integration': 'http://localhost/mock-backend/',
  }));

  // Stub the GraphQL placeOrder mutation
  cy.intercept('POST', '**/graphql', (req) => {
    if (req.body.operationName === 'placeOrder' || (req.body.query && req.body.query.includes('placeOrder'))) {
      req.alias = 'placeOrder';
      req.reply({
        statusCode: 200,
        body: {
          data: {
            placeOrder: {
              order: { order_number: 'TEST-ORDER-001' },
            },
          },
        },
      });
    }
  });
}

/**
 * Seeds localStorage to simulate the checkout state that handlePlaceOrder
 * reads (cart snapshot, checkout snapshot, payment method selection).
 */
function seedCheckoutState({
  paymentCode = adyenCreditCard.code,
  storedPaymentMethodId = null,
} = {}) {
  cy.window().then((win) => {
    // Cart snapshot expected by fetchPreAuthPayment
    win.localStorage.setItem('adyen_cart_snapshot', JSON.stringify({
      id: 'cart-id-abc',
      total_quantity: 1,
      prices: { grand_total: { value: 99.99, currency: 'USD' } },
    }));

    // Checkout snapshot
    win.localStorage.setItem('adyen_checkout_snapshot', JSON.stringify({
      billing_address: { firstname: 'John', lastname: 'Doe', city: 'Austin', country_code: 'US' },
      shipping_addresses: [{ firstname: 'John', lastname: 'Doe', city: 'Austin', country_code: 'US' }],
    }));

    // Simulate the payment component data that handlePlaceOrder reads
    const paymentData = {
      paymentMethod: { type: 'scheme', encryptedCardNumber: 'test', encryptedExpiryMonth: '03', encryptedExpiryYear: '2030', encryptedSecurityCode: '737' },
    };
    if (storedPaymentMethodId) {
      paymentData.paymentMethod.storedPaymentMethodId = storedPaymentMethodId;
    }
    win.__adyen_last_component_data = paymentData;
    win.__adyen_selected_payment_code = paymentCode;
  });
}

// ===========================================================================
// Suite 1 – Frictionless pre-auth (Authorised, no 3DS action)
// ===========================================================================
describe('Adyen Pre-Auth – frictionless (resultCode: Authorised)', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_AUTHORISED,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('calls pre-auth-payments endpoint when placing order with adyen_scheme', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth').its('request.method').should('eq', 'POST');
  });

  it('does NOT open the 3DS overlay for a frictionless response', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(OVERLAY_SEL).should('not.exist');
  });

  it('proceeds to call placeOrder after frictionless pre-auth', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.wait('@placeOrder').its('response.statusCode').should('eq', 200);
  });

  it('does NOT show an error message on success', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@placeOrder');
    cy.get(ERROR_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 2 – 3DS2 fingerprint → AuthenticationFinished (terminal, no challenge)
// ===========================================================================
describe('Adyen Pre-Auth – 3DS2 fingerprint → AuthenticationFinished', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    // Pre-auth triggers 3DS2 fingerprint action
    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_3DS2_ACTION,
    }).as('preAuth');

    // payments-details returns terminal AuthenticationFinished
    cy.intercept('POST', '**/payments-details', {
      statusCode: 200,
      body: DETAILS_AUTH_FINISHED,
    }).as('paymentsDetails');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('opens the 3DS overlay when pre-auth returns a threeDS2 action', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(OVERLAY_SEL).should('exist');
  });

  it('submits payments-details after fingerprint completes', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.wait('@paymentsDetails').its('request.method').should('eq', 'POST');
  });

  it('closes the 3DS overlay after AuthenticationFinished', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@paymentsDetails');
    cy.get(OVERLAY_SEL).should('not.exist');
  });

  it('calls placeOrder after AuthenticationFinished', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@paymentsDetails');
    cy.wait('@placeOrder').its('response.statusCode').should('eq', 200);
  });
});

// ===========================================================================
// Suite 3 – 3DS2 fingerprint → ChallengeShopper → AuthenticationFinished
// ===========================================================================
describe('Adyen Pre-Auth – 3DS2 fingerprint → ChallengeShopper → AuthenticationFinished', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_3DS2_ACTION,
    }).as('preAuth');

    // First payments-details call returns ChallengeShopper (intermediate)
    // Second call returns AuthenticationFinished (terminal)
    let detailsCallCount = 0;
    cy.intercept('POST', '**/payments-details', (req) => {
      detailsCallCount += 1;
      if (detailsCallCount === 1) {
        req.alias = 'paymentsDetails1';
        req.reply({ statusCode: 200, body: DETAILS_CHALLENGE_SHOPPER });
      } else {
        req.alias = 'paymentsDetails2';
        req.reply({ statusCode: 200, body: DETAILS_AUTH_FINISHED });
      }
    });

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('overlay remains open during ChallengeShopper intermediate step', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.wait('@paymentsDetails1');
    // Overlay should still be open while challenge is in progress
    cy.get(OVERLAY_SEL).should('exist');
  });

  it('calls placeOrder only after the final AuthenticationFinished response', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@paymentsDetails2');
    cy.wait('@placeOrder').its('response.statusCode').should('eq', 200);
  });

  it('closes the overlay after the terminal AuthenticationFinished', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@paymentsDetails2');
    cy.get(OVERLAY_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 4 – Pre-auth Refused → error shown, placeOrder NOT called
// ===========================================================================
describe('Adyen Pre-Auth – Refused result', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_REFUSED,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('shows a payment error when pre-auth is Refused', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(ERROR_SEL).should('exist');
  });

  it('does NOT call placeOrder when pre-auth is Refused', () => {
    // We should NOT see a placeOrder call after a Refused result
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');

    // Give some time for any erroneous placeOrder call to fire
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(500);

    // Verify no placeOrder call was made
    cy.get('@placeOrder.all').should('have.length', 0);
  });

  it('does NOT open the 3DS overlay on a Refused result', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(OVERLAY_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 5 – 3DS2 modal dismissed by user → silent abort
// ===========================================================================
describe('Adyen Pre-Auth – 3DS2 modal dismissed (user cancelled)', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_3DS2_ACTION,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('shows the 3DS overlay after pre-auth triggers threeDS2 action', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(OVERLAY_SEL).should('exist');
  });

  it('closes the overlay and does NOT place order when user dismisses the modal', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');

    // Simulate user dismissing the 3DS overlay (click dismiss/close button or
    // trigger the onDismiss callback directly via the window stub)
    cy.window().then((win) => {
      // Trigger the onDismiss path that handlePlaceOrder wires up
      if (typeof win.__adyen_trigger_3ds_dismiss === 'function') {
        win.__adyen_trigger_3ds_dismiss();
      } else {
        // Fallback: click a close button inside the overlay if rendered
        cy.get(OVERLAY_SEL).then(($overlay) => {
          const closeBtn = $overlay.find('[data-dismiss], .adyen-3ds-overlay__close, button[aria-label*="close" i]');
          if (closeBtn.length) {
            cy.wrap(closeBtn).first().click({ force: true });
          }
        });
      }
    });

    // After dismissal, overlay should be gone
    cy.get(OVERLAY_SEL).should('not.exist');

    // And placeOrder must NOT have been called
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(500);
    cy.get('@placeOrder.all').should('have.length', 0);
  });

  it('does NOT show a payment error on silent cancellation', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');

    cy.window().then((win) => {
      if (typeof win.__adyen_trigger_3ds_dismiss === 'function') {
        win.__adyen_trigger_3ds_dismiss();
      }
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
    cy.get(ERROR_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 6 – Stored card: pre-auth-payments NOT called, placeOrder called directly
// ===========================================================================
describe('Adyen Pre-Auth – stored card skips pre-auth', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    // This intercept should NOT be called — if it is, the test will fail via
    // the assertion below.
    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_AUTHORISED,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);

    // Seed state with a stored payment method id
    seedCheckoutState({
      paymentCode: adyenCreditCard.code,
      storedPaymentMethodId: 'stored-id-001',
    });
  });

  it('does NOT call pre-auth-payments when using a stored card', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });

    // Give time for any erroneous pre-auth call
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(500);

    cy.get('@preAuth.all').should('have.length', 0);
  });

  it('calls placeOrder directly without showing the 3DS overlay for stored cards', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@placeOrder').its('response.statusCode').should('eq', 200);
    cy.get(OVERLAY_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 7 – Non-scheme method (adyen_paypal): pre-auth NOT called
// ===========================================================================
describe('Adyen Pre-Auth – non-scheme payment method skips pre-auth', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_AUTHORISED,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);

    seedCheckoutState({ paymentCode: adyenPaypal.code });
  });

  it('does NOT call pre-auth-payments for adyen_paypal', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(500);

    cy.get('@preAuth.all').should('have.length', 0);
  });

  it('does NOT open the 3DS overlay for adyen_paypal', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
    cy.get(OVERLAY_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 8 – pre-auth-payments network error (500) → error surfaced, no order
// ===========================================================================
describe('Adyen Pre-Auth – backend returns 500 error', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 500,
      body: { message: 'Internal Server Error' },
    }).as('preAuthError');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('calls pre-auth-payments before placeOrder', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuthError').its('response.statusCode').should('eq', 500);
  });

  it('shows a payment error when pre-auth backend returns 500', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuthError');
    cy.get(ERROR_SEL).should('exist');
  });

  it('does NOT call placeOrder when pre-auth backend errors', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuthError');

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(500);

    cy.get('@placeOrder.all').should('have.length', 0);
  });

  it('does NOT open the 3DS overlay on a backend error', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuthError');
    cy.get(OVERLAY_SEL).should('not.exist');
  });
});

// ===========================================================================
// Suite 9 – AuthenticationNotRequired → direct authorisation, no 3DS modal
// ===========================================================================
describe('Adyen Pre-Auth – AuthenticationNotRequired → direct authorisation', () => {
  beforeEach(() => {
    setupBaseIntercepts();

    cy.intercept('POST', '**/pre-auth-payments', {
      statusCode: 200,
      body: PRE_AUTH_AUTH_NOT_REQUIRED,
    }).as('preAuth');

    cy.visit(CHECKOUT_URL);
    seedCheckoutState();
  });

  it('calls pre-auth-payments endpoint for adyen_scheme', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth').its('request.method').should('eq', 'POST');
  });

  it('does NOT open the 3DS overlay for AuthenticationNotRequired', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.get(OVERLAY_SEL).should('not.exist');
  });

  it('proceeds to call placeOrder after AuthenticationNotRequired', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.wait('@placeOrder').its('response.statusCode').should('eq', 200);
  });

  it('passes authenticationNotRequired flag in setPaymentMethod additional_data', () => {
    // Spy on the Commerce setPaymentMethod GraphQL mutation to verify the
    // correct additional_data keys are forwarded to the backend.
    cy.intercept('POST', '**/graphql', (req) => {
      if (
        req.body.operationName === 'SetPaymentMethodOnCart'
        || (req.body.query && req.body.query.includes('setPaymentMethodOnCart'))
      ) {
        req.alias = 'setPaymentMethod';
      }
    });

    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@preAuth');
    cy.wait('@setPaymentMethod').then((interception) => {
      const body = interception.request.body;
      const additionalData = body?.variables?.input?.payment_method?.adyen_additional_data
        ?? body?.variables?.additional_data
        ?? [];
      const keys = additionalData.map((d) => d.key);
      expect(keys).to.include('authenticationNotRequired');
      expect(keys).to.include('state');
      // Must NOT send preAuthPaymentData — that signals /payments/details path
      expect(keys).not.to.include('preAuthPaymentData');
    });
  });

  it('does NOT show an error message on success', () => {
    cy.get(PLACE_ORDER_BTN_SEL).click({ force: true });
    cy.wait('@placeOrder');
    cy.get(ERROR_SEL).should('not.exist');
  });
});
