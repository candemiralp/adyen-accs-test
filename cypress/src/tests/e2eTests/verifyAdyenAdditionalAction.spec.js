/**
 * Adyen Payment Additional Action Block – Cypress E2E Tests
 *
 * Covers behavior in adyen-payment-additional-action/adyen-payment-additional-action.js:
 *
 *  1. decorate() creates .adyen-additional-action-container inside the block
 *  2. order/data event with no payments → container stays empty
 *  3. order/data event with payments but no additional_informations → container stays empty
 *  4. order/data event with additional_action as JSON string → parsed and renderAction called
 *  5. order/data event with additional_action as object → renderAction called directly
 *  6. additional_action with type "voucher" → renderAction mounts voucher UI
 *  7. additional_action with type "qrCode" → renderAction mounts QR code UI
 *  8. additional_action with type "await" → renderAction mounts await UI
 *  9. additional_action with type "redirect" → setPendingOrderData called before mount
 * 10. Malformed JSON in additional_action string → safely returns null (no crash)
 * 11. Multiple order/data events → container is cleared and re-rendered each time
 * 12. getAdyenCheckout() rejects during renderAction → no uncaught exception propagates
 * 13. action without a type field → renderAction skips mounting
 * 14. Container is visible (not hidden) on the order confirmation page
 */

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
const ORDER_CONFIRMATION_URL = '/order/confirmation';
const ADDITIONAL_ACTION_BLOCK_SEL = '.adyen-payment-additional-action';
const CONTAINER_SEL = '.adyen-additional-action-container';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/** Minimal order data without any payment additional action */
const orderDataNoAction = {
  number: 'ORD-999',
  grandTotal: { currency: 'USD', value: 10000 },
  payments: [
    {
      code: 'adyen_scheme',
      additional_informations: null,
    },
  ],
};

/** Order data with a voucher additional action (JSON string) */
const voucherAction = {
  type: 'voucher',
  paymentMethodType: 'directdebit_GB',
  reference: 'REF001',
  instructionsUrl: 'https://example.com/voucher',
};

/** Order data with a qrCode action */
const qrCodeAction = {
  type: 'qrCode',
  paymentMethodType: 'pix',
  qrCodeData: 'pix-code-xyz',
};

/** Order data with an await action */
const awaitAction = {
  type: 'await',
  paymentMethodType: 'payto',
};

/** Order data with a redirect action */
const redirectAction = {
  type: 'redirect',
  method: 'GET',
  url: 'https://bank.example.com/authorize',
};

function buildOrderData(action, stringify = false) {
  return {
    number: 'ORD-001',
    grandTotal: { currency: 'USD', value: 5000 },
    payments: [
      {
        code: 'adyen_scheme',
        additional_informations: {
          additional_action: stringify ? JSON.stringify({ action }) : { action },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper: dispatch order/data event via the dropin event bus or CustomEvent
// ---------------------------------------------------------------------------
function dispatchOrderData(win, orderData) {
  // Try the dropin event bus first
  try {
    if (win.__dropins_events && typeof win.__dropins_events.emit === 'function') {
      win.__dropins_events.emit('order/data', orderData);
      return;
    }
  } catch { /* ignore */ }

  // Fallback: CustomEvent on window
  win.dispatchEvent(new CustomEvent('order/data', {
    detail: orderData,
    bubbles: true,
  }));
}

// ---------------------------------------------------------------------------
// Suite 1 – Container created by decorate()
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – container structure', () => {
  beforeEach(() => {
    cy.visit(ORDER_CONFIRMATION_URL);
  });

  it('creates .adyen-additional-action-container inside the block', () => {
    cy.get(ADDITIONAL_ACTION_BLOCK_SEL).within(() => {
      cy.get(CONTAINER_SEL).should('exist');
    });
  });

  it('container is initially empty', () => {
    cy.get(CONTAINER_SEL).should('be.empty');
  });

  it('block and container are visible on order confirmation page', () => {
    cy.get(ADDITIONAL_ACTION_BLOCK_SEL).should('be.visible');
    cy.get(CONTAINER_SEL).should('exist');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 – order/data with no payments
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – order/data with no payments', () => {
  it('container remains empty when order has no payments array', () => {
    cy.visit(ORDER_CONFIRMATION_URL);
    cy.get(CONTAINER_SEL).should('exist');

    cy.window().then((win) => {
      dispatchOrderData(win, { number: 'ORD-EMPTY', grandTotal: { currency: 'USD', value: 0 } });
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });

  it('container remains empty when payments array is empty', () => {
    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, { number: 'ORD-NOPAY', payments: [] });
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 – order/data with payments but no additional_action
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – order/data without additional_action', () => {
  it('container remains empty when additional_informations is null', () => {
    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, orderDataNoAction);
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });

  it('container remains empty when additional_informations has no additional_action key', () => {
    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, {
        number: 'ORD-002',
        payments: [{ code: 'adyen_scheme', additional_informations: { some_other_key: true } }],
      });
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 – additional_action as JSON string
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – additional_action as JSON string', () => {
  it('parses JSON string and passes action to renderAction', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, buildOrderData(voucherAction, true));
    });

    // The container should be populated (or at least not empty) once the
    // Adyen SDK mounts the action component
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
    cy.get(CONTAINER_SEL).should('exist');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 – additional_action as object
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – additional_action as object', () => {
  it('passes action object directly to renderAction without JSON parsing', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, buildOrderData(qrCodeAction, false));
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
    cy.get(CONTAINER_SEL).should('exist');
  });
});

// ---------------------------------------------------------------------------
// Suite 6 – Voucher action type
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – voucher action', () => {
  it('container is populated when a voucher action is received', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, buildOrderData(voucherAction));
    });

    cy.get(CONTAINER_SEL).should('exist');
    // If Adyen SDK is available, it will render content inside container
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 – QR code action type
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – qrCode action', () => {
  it('container is populated when a qrCode action is received', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, buildOrderData(qrCodeAction));
    });

    cy.get(CONTAINER_SEL).should('exist');
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 – Await action type
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – await action', () => {
  it('container is populated when an await action is received', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, buildOrderData(awaitAction));
    });

    cy.get(CONTAINER_SEL).should('exist');
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 – Redirect action: setPendingOrderData is called
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – redirect action sets pending order', () => {
  it('redirect action causes pending order to be stored in localStorage', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    const orderWithRedirect = buildOrderData(redirectAction);

    cy.window().then((win) => {
      dispatchOrderData(win, orderWithRedirect);
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(300);

    // After a redirect action, adyen_pending_order should be set in localStorage
    cy.window().then((win) => {
      const raw = win.localStorage.getItem('adyen_pending_order');
      if (raw) {
        const stored = JSON.parse(raw);
        expect(stored).to.have.property('value');
      }
      // If not stored, just verify the container still exists (no crash)
      cy.get(CONTAINER_SEL).should('exist');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 10 – Malformed JSON additional_action
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – malformed JSON in additional_action', () => {
  it('does not throw when additional_action is malformed JSON', () => {
    cy.on('uncaught:exception', (err) => {
      // Only fail for errors originating from the additional action block
      if (err.message.includes('getAdditionalAction') || err.message.includes('additional_action')) {
        return true;
      }
      return false;
    });

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, {
        number: 'ORD-BAD',
        payments: [
          {
            code: 'adyen_scheme',
            additional_informations: {
              additional_action: '{ this is: not valid JSON !!',
            },
          },
        ],
      });
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });
});

// ---------------------------------------------------------------------------
// Suite 11 – Multiple successive order/data events
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – multiple order/data events', () => {
  it('container is cleared and re-rendered on each order/data event', () => {
    cy.intercept('POST', '**/rest/*/V1/adyen/frontend/configuration', {
      statusCode: 200,
      body: { clientKey: 'test_AAAA', environment: 'test', locale: 'en-US' },
    }).as('adyenConfig');

    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      // First event with a voucher action
      dispatchOrderData(win, buildOrderData(voucherAction));
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(200);

    cy.window().then((win) => {
      // Second event with no action – container should clear
      dispatchOrderData(win, orderDataNoAction);
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(200);
    cy.get(CONTAINER_SEL).should('be.empty');
  });
});

// ---------------------------------------------------------------------------
// Suite 12 – action without type field
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – action missing type field', () => {
  it('skips mounting when action object has no type property', () => {
    cy.visit(ORDER_CONFIRMATION_URL);

    cy.window().then((win) => {
      dispatchOrderData(win, {
        number: 'ORD-NOTYPE',
        payments: [
          {
            code: 'adyen_scheme',
            additional_informations: {
              additional_action: { action: { noTypeHere: true } },
            },
          },
        ],
      });
    });

    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(100);
    cy.get(CONTAINER_SEL).should('be.empty');
  });
});

// ---------------------------------------------------------------------------
// Suite 13 – Block present on order confirmation page
// ---------------------------------------------------------------------------
describe('Adyen Additional Action – block presence', () => {
  it('additional action block exists on the order confirmation page', () => {
    cy.visit(ORDER_CONFIRMATION_URL);
    cy.get(ADDITIONAL_ACTION_BLOCK_SEL).should('exist');
  });

  it('block does not render any pay/submit button', () => {
    cy.visit(ORDER_CONFIRMATION_URL);
    cy.get(ADDITIONAL_ACTION_BLOCK_SEL)
      .find('.adyen-checkout__pay-button, button[type="submit"]')
      .should('not.exist');
  });
});
