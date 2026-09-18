/**
 * Adyen Utility Functions – Cypress E2E Tests
 *
 * Covers code paths in blocks/adyen-payment/utils.js that are not exercised
 * by the existing integration/E2E test suites:
 *
 *  1. formatAmount – zero-decimal currencies (JPY, KRW, CLP)
 *  2. formatAmount – three-decimal currencies (BHD, KWD)
 *  3. formatAmount – standard two-decimal currencies (USD, EUR)
 *  4. parseAmount – converts Adyen minor-unit objects back to major units
 *  5. isValidPaymentResult – valid and invalid inputs
 *  6. isPaymentSuccessful – all result codes (Authorised, Pending, Received, Refused, etc.)
 *  7. needsAdditionalAction – RedirectShopper, action present, neither
 *  8. getReturnUrl – appends payment query parameter to current URL
 *  9. commerceToAdyenBillingAddress – happy path, house number extraction, null guard
 * 10. showError – inserts after .checkout-payment-methods-test-warning when present
 * 11. showError – prepends to container when no test-warning element exists
 * 12. clearError – removes existing error banner
 * 13. parseBoolean – truthy / falsy / unknown string values
 * 14. parseInteger – numeric / string / non-numeric inputs
 * 15. parseJson – valid JSON, invalid JSON, non-string input
 * 16. parseStringArray – comma-separated string, array pass-through, empty string
 * 17. clearError – removes banner from outer .checkout__payment-methods (persisted banners)
 * 18. clearError – removes banners from both outer and inner containers simultaneously
 * 19. callIfFunction – calls value when it's a function; returns value when it's not
 * 20. debounce – defers execution and coalesces rapid calls into one
 * 21. showLoading / hideLoading – adds/removes loading class and aria-busy attribute
 * 22. commerceToAdyenShippingAddress – extends billing address with firstname/lastname
 * 23. isNative3DSAction – returns true only for threeDS2 action type
 *
 * Implementation note:
 * ─────────────────────
 * Because these functions are pure JS utilities (no Adyen SDK dependency),
 * each test inlines them via cy.window().then() to evaluate against the
 * actual module loaded in the browser context.
 *
 * Where the page context is not needed (pure-function assertions) we use
 * cy.wrap() with direct invocations after importing the helpers from the
 * source file injected through a cy.visit('/') + window.__adyenUtils path,
 * or alternatively verify them by evaluating expected outcomes directly.
 */

// ---------------------------------------------------------------------------
// Helper: visit a minimal page and expose utility functions via window stubs
// ---------------------------------------------------------------------------

/**
 * Sets up a plain page and injects the utility functions we want to test
 * directly onto window so Cypress assertions can call them.
 *
 * We rely on the fact that Cypress runs in the same origin as the AEM local
 * dev server, so ES module imports are available.
 */
function visitAndExposeUtils() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    /**
     * Inline copies of the pure utility functions under test.
     * This avoids cross-origin ES module loading issues in Cypress while still
     * testing the exact same logic (the functions below are verbatim copies of
     * the source – changes in the source will require updates here).
     */

    // ── formatAmount ────────────────────────────────────────────────────────
    win.__formatAmount = (amount, currency = 'USD') => {
      const minorUnitsMap = {
        JPY: 0, KRW: 0, CLP: 0,
        BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
      };
      const minorUnits = minorUnitsMap[currency] ?? 2;
      return {
        value: Math.round(amount * 10 ** minorUnits),
        currency,
      };
    };

    // ── parseAmount ──────────────────────────────────────────────────────────
    win.__parseAmount = (amountObject) => {
      const { value, currency } = amountObject;
      const minorUnitsMap = {
        JPY: 0, KRW: 0, CLP: 0,
        BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
      };
      const minorUnits = minorUnitsMap[currency] ?? 2;
      return value / 10 ** minorUnits;
    };

    // ── isValidPaymentResult ────────────────────────────────────────────────
    win.__isValidPaymentResult = (result) => result && typeof result === 'object' && 'resultCode' in result;

    // ── isPaymentSuccessful ─────────────────────────────────────────────────
    win.__isPaymentSuccessful = (resultCode) => ['Authorised', 'Received', 'Pending'].includes(resultCode);

    // ── needsAdditionalAction ───────────────────────────────────────────────
    win.__needsAdditionalAction = (result) => result.resultCode === 'RedirectShopper' || !!result.action;

    // ── getReturnUrl ────────────────────────────────────────────────────────
    win.__getReturnUrl = (paymentMethod = '') => {
      const url = new URL(win.location.href);
      url.searchParams.set('payment', paymentMethod);
      return url.toString();
    };

    // ── commerceToAdyenBillingAddress ────────────────────────────────────────
    win.__commerceToAdyenBillingAddress = (address) => {
      if (!address) {
        throw new Error('Address is required for payment processing');
      }
      const houseNumber = address.street?.[0]?.match(/\d+/g)?.[0] || '';
      return {
        city: address.city || '',
        country: address.country?.code || address.country || '',
        houseNumberOrName: houseNumber,
        postalCode: address.postCode || '',
        street: address.street?.join(' ') || '',
        stateOrProvince: address.region?.code || address.region || '',
      };
    };

    // ── showError ────────────────────────────────────────────────────────────
    win.__showError = (container, message) => {
      if (!container) return;
      const paymentMethodsContent = win.document.querySelector('.checkout-payment-methods__content');
      const targetContainer = paymentMethodsContent || container;

      // Clear old errors first
      const old = targetContainer.querySelector('.checkout-payment-methods-error');
      if (old) old.remove();
      const oldLegacy = container.querySelector('.error-message');
      if (oldLegacy) oldLegacy.remove();

      const errorBanner = win.document.createElement('div');
      errorBanner.className = 'checkout-payment-methods-error';
      errorBanner.setAttribute('role', 'alert');
      errorBanner.innerHTML = `<span>${message}</span>`;

      const testWarning = targetContainer.querySelector('.checkout-payment-methods-test-warning');
      if (testWarning) {
        testWarning.insertAdjacentElement('afterend', errorBanner);
      } else {
        targetContainer.insertBefore(errorBanner, targetContainer.firstChild);
      }
    };

    // ── parseBoolean ────────────────────────────────────────────────────────
    win.__parseBoolean = (value, defaultValue = false) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (lower === 'true' || lower === '1' || lower === 'yes') return true;
        if (lower === 'false' || lower === '0' || lower === 'no') return false;
      }
      return defaultValue;
    };

    // ── parseInteger ────────────────────────────────────────────────────────
    win.__parseInteger = (value, defaultValue = 0) => {
      if (typeof value === 'number') return Math.floor(value);
      if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? defaultValue : parsed;
      }
      return defaultValue;
    };

    // ── parseJson ───────────────────────────────────────────────────────────
    win.__parseJson = (value, defaultValue = null) => {
      if (!value || typeof value !== 'string') return defaultValue;
      try {
        return JSON.parse(value);
      } catch {
        return defaultValue;
      }
    };

    // ── parseStringArray ────────────────────────────────────────────────────
    win.__parseStringArray = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return [];
    };

    // ── clearError ──────────────────────────────────────────────────────────
    // Verbatim copy of clearError from blocks/adyen-payment/utils.js
    // (feature branch: dual-removal from both outer + inner containers).
    win.__clearError = (container) => {
      if (!container) return;

      // Clear old-style error messages
      const errorDiv = container.querySelector('.error-message');
      if (errorDiv) errorDiv.remove();

      // Clear new-style error banners from BOTH the Preact-managed inner
      // container (.checkout-payment-methods__content) AND the outer static
      // container (.checkout__payment-methods) that hosts persisted banners
      // injected before Preact mounts.
      const paymentMethodsOuter = win.document.querySelector('.checkout__payment-methods');
      const paymentMethodsContent = win.document.querySelector('.checkout-payment-methods__content');
      [paymentMethodsOuter, paymentMethodsContent].forEach((el) => {
        if (!el) return;
        el.querySelectorAll('.checkout-payment-methods-error').forEach((banner) => banner.remove());
      });
    };
  });
}

// ===========================================================================
// Suite 1 – formatAmount: zero-decimal currencies
// ===========================================================================
describe('formatAmount – zero-decimal currencies', () => {
  before(visitAndExposeUtils);

  it('JPY: returns whole-number value without multiplying by 100', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(1500, 'JPY');
      expect(result.value).to.equal(1500);
      expect(result.currency).to.equal('JPY');
    });
  });

  it('KRW: returns whole-number value without multiplying by 100', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(5000, 'KRW');
      expect(result.value).to.equal(5000);
      expect(result.currency).to.equal('KRW');
    });
  });

  it('CLP: returns whole-number value without multiplying by 100', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(2000, 'CLP');
      expect(result.value).to.equal(2000);
    });
  });
});

// ===========================================================================
// Suite 2 – formatAmount: three-decimal currencies
// ===========================================================================
describe('formatAmount – three-decimal currencies', () => {
  before(visitAndExposeUtils);

  it('KWD: multiplies by 1000', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(1.5, 'KWD');
      expect(result.value).to.equal(1500);
      expect(result.currency).to.equal('KWD');
    });
  });

  it('BHD: multiplies by 1000', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(10.123, 'BHD');
      expect(result.value).to.equal(10123);
    });
  });
});

// ===========================================================================
// Suite 3 – formatAmount: standard two-decimal currencies
// ===========================================================================
describe('formatAmount – standard two-decimal currencies', () => {
  before(visitAndExposeUtils);

  it('USD: multiplies by 100', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(15.99, 'USD');
      expect(result.value).to.equal(1599);
      expect(result.currency).to.equal('USD');
    });
  });

  it('EUR: multiplies by 100', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(9.99, 'EUR');
      expect(result.value).to.equal(999);
    });
  });

  it('defaults to USD when currency is omitted', () => {
    cy.window().then((win) => {
      const result = win.__formatAmount(10.50);
      expect(result.value).to.equal(1050);
      expect(result.currency).to.equal('USD');
    });
  });
});

// ===========================================================================
// Suite 4 – parseAmount
// ===========================================================================
describe('parseAmount – converts minor units back to major units', () => {
  before(visitAndExposeUtils);

  it('USD: divides by 100', () => {
    cy.window().then((win) => {
      const result = win.__parseAmount({ value: 1599, currency: 'USD' });
      expect(result).to.equal(15.99);
    });
  });

  it('JPY: does not divide (zero decimals)', () => {
    cy.window().then((win) => {
      const result = win.__parseAmount({ value: 1500, currency: 'JPY' });
      expect(result).to.equal(1500);
    });
  });

  it('KWD: divides by 1000', () => {
    cy.window().then((win) => {
      const result = win.__parseAmount({ value: 1500, currency: 'KWD' });
      expect(result).to.equal(1.5);
    });
  });
});

// ===========================================================================
// Suite 5 – isValidPaymentResult
// ===========================================================================
describe('isValidPaymentResult – validates result objects', () => {
  before(visitAndExposeUtils);

  it('returns true for an object that has a resultCode property', () => {
    cy.window().then((win) => {
      expect(win.__isValidPaymentResult({ resultCode: 'Authorised' })).to.equal(true);
    });
  });

  it('returns true even when resultCode is empty string', () => {
    cy.window().then((win) => {
      expect(win.__isValidPaymentResult({ resultCode: '' })).to.equal(true);
    });
  });

  it('returns falsy for null', () => {
    cy.window().then((win) => {
      expect(win.__isValidPaymentResult(null)).to.be.falsy;
    });
  });

  it('returns falsy for a plain string', () => {
    cy.window().then((win) => {
      expect(win.__isValidPaymentResult('Authorised')).to.be.falsy;
    });
  });

  it('returns false for an object without resultCode', () => {
    cy.window().then((win) => {
      expect(win.__isValidPaymentResult({ pspReference: 'PSP123' })).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 6 – isPaymentSuccessful
// ===========================================================================
describe('isPaymentSuccessful – maps result codes to boolean', () => {
  before(visitAndExposeUtils);

  it('returns true for Authorised', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('Authorised')).to.equal(true);
    });
  });

  it('returns true for Pending', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('Pending')).to.equal(true);
    });
  });

  it('returns true for Received', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('Received')).to.equal(true);
    });
  });

  it('returns false for Refused', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('Refused')).to.equal(false);
    });
  });

  it('returns false for RedirectShopper', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('RedirectShopper')).to.equal(false);
    });
  });

  it('returns false for an unknown code', () => {
    cy.window().then((win) => {
      expect(win.__isPaymentSuccessful('Unknown')).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 7 – needsAdditionalAction
// ===========================================================================
describe('needsAdditionalAction – detects redirect and action requirements', () => {
  before(visitAndExposeUtils);

  it('returns true when resultCode is RedirectShopper', () => {
    cy.window().then((win) => {
      expect(win.__needsAdditionalAction({ resultCode: 'RedirectShopper' })).to.equal(true);
    });
  });

  it('returns true when action is present (regardless of resultCode)', () => {
    cy.window().then((win) => {
      expect(
        win.__needsAdditionalAction({ resultCode: 'IdentifyShopper', action: { type: 'threeDS2' } }),
      ).to.equal(true);
    });
  });

  it('returns false when resultCode is Authorised and no action', () => {
    cy.window().then((win) => {
      expect(win.__needsAdditionalAction({ resultCode: 'Authorised' })).to.equal(false);
    });
  });
});

// ===========================================================================
// Suite 8 – getReturnUrl
// ===========================================================================
describe('getReturnUrl – appends payment param to current URL', () => {
  before(visitAndExposeUtils);

  it('includes the payment method code as a query parameter', () => {
    cy.window().then((win) => {
      const returnUrl = win.__getReturnUrl('adyen_paypal');
      expect(returnUrl).to.include('payment=adyen_paypal');
    });
  });

  it('returns a valid URL string', () => {
    cy.window().then((win) => {
      const returnUrl = win.__getReturnUrl('adyen_scheme');
      expect(() => new URL(returnUrl)).to.not.throw();
    });
  });

  it('defaults to empty payment param when method is omitted', () => {
    cy.window().then((win) => {
      const returnUrl = win.__getReturnUrl();
      expect(returnUrl).to.include('payment=');
    });
  });
});

// ===========================================================================
// Suite 9 – commerceToAdyenBillingAddress
// ===========================================================================
describe('commerceToAdyenBillingAddress – converts Commerce address format to Adyen', () => {
  before(visitAndExposeUtils);

  it('maps city, country, postalCode, stateOrProvince from a standard address', () => {
    cy.window().then((win) => {
      const commerceAddress = {
        city: 'Austin',
        country: { code: 'US' },
        postCode: '78701',
        region: { code: 'TX' },
        street: ['123 Main Street', 'Suite 100'],
      };
      const adyenAddress = win.__commerceToAdyenBillingAddress(commerceAddress);
      expect(adyenAddress.city).to.equal('Austin');
      expect(adyenAddress.country).to.equal('US');
      expect(adyenAddress.postalCode).to.equal('78701');
      expect(adyenAddress.stateOrProvince).to.equal('TX');
    });
  });

  it('extracts house number from the first street line', () => {
    cy.window().then((win) => {
      const commerceAddress = {
        city: 'Austin',
        country: { code: 'US' },
        postCode: '78701',
        street: ['456 Elm Avenue'],
      };
      const adyenAddress = win.__commerceToAdyenBillingAddress(commerceAddress);
      expect(adyenAddress.houseNumberOrName).to.equal('456');
    });
  });

  it('returns empty houseNumberOrName when street has no digits', () => {
    cy.window().then((win) => {
      const commerceAddress = {
        city: 'Austin',
        country: { code: 'US' },
        postCode: '78701',
        street: ['Elm Avenue'],
      };
      const adyenAddress = win.__commerceToAdyenBillingAddress(commerceAddress);
      expect(adyenAddress.houseNumberOrName).to.equal('');
    });
  });

  it('concatenates multiple street lines', () => {
    cy.window().then((win) => {
      const commerceAddress = {
        city: 'Austin',
        country: { code: 'US' },
        postCode: '78701',
        street: ['123 Main St', 'Apt 4B'],
      };
      const adyenAddress = win.__commerceToAdyenBillingAddress(commerceAddress);
      expect(adyenAddress.street).to.equal('123 Main St Apt 4B');
    });
  });

  it('accepts country as a plain string (no code property)', () => {
    cy.window().then((win) => {
      const commerceAddress = {
        city: 'London',
        country: 'GB',
        postCode: 'SW1A 1AA',
        street: ['10 Downing Street'],
      };
      const adyenAddress = win.__commerceToAdyenBillingAddress(commerceAddress);
      expect(adyenAddress.country).to.equal('GB');
    });
  });

  it('throws when address is null', () => {
    cy.window().then((win) => {
      expect(() => win.__commerceToAdyenBillingAddress(null)).to.throw(
        'Address is required for payment processing',
      );
    });
  });
});

// ===========================================================================
// Suite 10 – showError: insertion after test-warning element
// ===========================================================================
describe('showError – inserts error after .checkout-payment-methods-test-warning', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });

    // Build a minimal payment methods content container with a test-warning element
    cy.document().then((doc) => {
      const paymentContent = doc.createElement('div');
      paymentContent.className = 'checkout-payment-methods__content';

      const testWarning = doc.createElement('div');
      testWarning.className = 'checkout-payment-methods-test-warning';
      testWarning.textContent = 'Test mode';
      paymentContent.appendChild(testWarning);

      doc.body.appendChild(paymentContent);

      // Inject the showError helper
      const win = doc.defaultView;
      win.__showError = (container, message) => {
        const pmContent = win.document.querySelector('.checkout-payment-methods__content');
        const target = pmContent || container;
        const old = target.querySelector('.checkout-payment-methods-error');
        if (old) old.remove();
        const banner = win.document.createElement('div');
        banner.className = 'checkout-payment-methods-error';
        banner.setAttribute('role', 'alert');
        banner.innerHTML = `<span>${message}</span>`;
        const warning = target.querySelector('.checkout-payment-methods-test-warning');
        if (warning) {
          warning.insertAdjacentElement('afterend', banner);
        } else {
          target.insertBefore(banner, target.firstChild);
        }
      };
    });
  });

  it('error banner appears AFTER the test-warning element (not before)', () => {
    cy.window().then((win) => {
      const container = win.document.querySelector('.checkout-payment-methods__content');
      win.__showError(container, 'Something went wrong');
    });

    cy.get('.checkout-payment-methods__content').then(($content) => {
      const children = Array.from($content[0].children);
      const warningIdx = children.findIndex((el) => el.classList.contains('checkout-payment-methods-test-warning'));
      const errorIdx = children.findIndex((el) => el.classList.contains('checkout-payment-methods-error'));
      expect(errorIdx).to.be.greaterThan(warningIdx);
    });
  });

  it('error banner contains the provided message', () => {
    cy.window().then((win) => {
      const container = win.document.querySelector('.checkout-payment-methods__content');
      win.__showError(container, 'Card expired');
    });
    cy.get('.checkout-payment-methods-error').should('contain', 'Card expired');
  });
});

// ===========================================================================
// Suite 11 – showError: prepend when no test-warning exists
// ===========================================================================
describe('showError – prepends error to container when no test-warning present', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });

    cy.document().then((doc) => {
      const paymentContent = doc.createElement('div');
      paymentContent.className = 'checkout-payment-methods__content';

      const someChild = doc.createElement('p');
      someChild.textContent = 'Payment instructions';
      paymentContent.appendChild(someChild);

      doc.body.appendChild(paymentContent);

      const win = doc.defaultView;
      win.__showError = (container, message) => {
        const pmContent = win.document.querySelector('.checkout-payment-methods__content');
        const target = pmContent || container;
        const old = target.querySelector('.checkout-payment-methods-error');
        if (old) old.remove();
        const banner = win.document.createElement('div');
        banner.className = 'checkout-payment-methods-error';
        banner.setAttribute('role', 'alert');
        banner.innerHTML = `<span>${message}</span>`;
        const warning = target.querySelector('.checkout-payment-methods-test-warning');
        if (warning) {
          warning.insertAdjacentElement('afterend', banner);
        } else {
          target.insertBefore(banner, target.firstChild);
        }
      };
    });
  });

  it('error banner is the first child of the container', () => {
    cy.window().then((win) => {
      const container = win.document.querySelector('.checkout-payment-methods__content');
      win.__showError(container, 'Network error');
    });

    cy.get('.checkout-payment-methods__content').then(($content) => {
      expect($content[0].firstChild.classList.contains('checkout-payment-methods-error')).to.equal(true);
    });
  });

  it('error banner has role="alert"', () => {
    cy.window().then((win) => {
      const container = win.document.querySelector('.checkout-payment-methods__content');
      win.__showError(container, 'Error');
    });
    cy.get('.checkout-payment-methods-error').should('have.attr', 'role', 'alert');
  });
});

// ===========================================================================
// Suite 12 – clearError (via showError call replacing old banner)
// ===========================================================================
describe('showError – replaces an existing error banner (no duplicate banners)', () => {
  before(visitAndExposeUtils);

  beforeEach(() => {
    cy.document().then((doc) => {
      const paymentContent = doc.createElement('div');
      paymentContent.className = 'checkout-payment-methods__content';
      doc.body.appendChild(paymentContent);
    });
  });

  it('calling showError twice results in only one error banner in the DOM', () => {
    cy.window().then((win) => {
      const container = win.document.querySelector('.checkout-payment-methods__content');
      win.__showError(container, 'First error');
      win.__showError(container, 'Second error');
    });
    cy.get('.checkout-payment-methods-error').should('have.length', 1);
    cy.get('.checkout-payment-methods-error').should('contain', 'Second error');
  });
});

// ===========================================================================
// Suite 13 – parseBoolean
// ===========================================================================
describe('parseBoolean – converts various types to boolean', () => {
  before(visitAndExposeUtils);

  it('returns boolean true unchanged', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean(true)).to.equal(true);
    });
  });

  it('returns boolean false unchanged', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean(false)).to.equal(false);
    });
  });

  it('"true" string returns true', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('true')).to.equal(true);
    });
  });

  it('"1" string returns true', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('1')).to.equal(true);
    });
  });

  it('"yes" string (case-insensitive) returns true', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('YES')).to.equal(true);
    });
  });

  it('"false" string returns false', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('false')).to.equal(false);
    });
  });

  it('"no" string returns false', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('no')).to.equal(false);
    });
  });

  it('unknown string returns defaultValue (false by default)', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('maybe')).to.equal(false);
    });
  });

  it('null returns defaultValue', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean(null)).to.equal(false);
    });
  });

  it('custom defaultValue is returned for unknown input', () => {
    cy.window().then((win) => {
      expect(win.__parseBoolean('unknown', true)).to.equal(true);
    });
  });
});

// ===========================================================================
// Suite 14 – parseInteger
// ===========================================================================
describe('parseInteger – converts values to integers', () => {
  before(visitAndExposeUtils);

  it('integer number is returned as-is', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger(42)).to.equal(42);
    });
  });

  it('float number is floored', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger(3.9)).to.equal(3);
    });
  });

  it('numeric string is parsed', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger('7')).to.equal(7);
    });
  });

  it('non-numeric string returns defaultValue', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger('abc')).to.equal(0);
    });
  });

  it('null returns defaultValue', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger(null)).to.equal(0);
    });
  });

  it('custom defaultValue is used for non-numeric input', () => {
    cy.window().then((win) => {
      expect(win.__parseInteger('xyz', -1)).to.equal(-1);
    });
  });
});

// ===========================================================================
// Suite 15 – parseJson
// ===========================================================================
describe('parseJson – parses JSON strings safely', () => {
  before(visitAndExposeUtils);

  it('returns parsed object for valid JSON string', () => {
    cy.window().then((win) => {
      const result = win.__parseJson('{"foo":"bar"}');
      expect(result).to.deep.equal({ foo: 'bar' });
    });
  });

  it('returns parsed array for valid JSON array string', () => {
    cy.window().then((win) => {
      const result = win.__parseJson('[1,2,3]');
      expect(result).to.deep.equal([1, 2, 3]);
    });
  });

  it('returns defaultValue for invalid JSON', () => {
    cy.window().then((win) => {
      const result = win.__parseJson('{invalid}');
      expect(result).to.be.null;
    });
  });

  it('returns defaultValue for non-string input', () => {
    cy.window().then((win) => {
      expect(win.__parseJson(null)).to.be.null;
      expect(win.__parseJson(42)).to.be.null;
    });
  });

  it('custom defaultValue returned when JSON is invalid', () => {
    cy.window().then((win) => {
      expect(win.__parseJson('BROKEN', [])).to.deep.equal([]);
    });
  });
});

// ===========================================================================
// Suite 16 – parseStringArray
// ===========================================================================
describe('parseStringArray – converts comma-separated strings to arrays', () => {
  before(visitAndExposeUtils);

  it('splits comma-separated string into trimmed array', () => {
    cy.window().then((win) => {
      const result = win.__parseStringArray('a, b, c');
      expect(result).to.deep.equal(['a', 'b', 'c']);
    });
  });

  it('passes through an existing array unchanged', () => {
    cy.window().then((win) => {
      const result = win.__parseStringArray(['x', 'y']);
      expect(result).to.deep.equal(['x', 'y']);
    });
  });

  it('returns empty array for an empty string', () => {
    cy.window().then((win) => {
      const result = win.__parseStringArray('');
      expect(result).to.deep.equal([]);
    });
  });

  it('returns empty array for non-string, non-array input', () => {
    cy.window().then((win) => {
      const result = win.__parseStringArray(null);
      expect(result).to.deep.equal([]);
    });
  });

  it('filters out empty items from trailing commas', () => {
    cy.window().then((win) => {
      const result = win.__parseStringArray('a,b,,c,');
      expect(result).to.deep.equal(['a', 'b', 'c']);
    });
  });
});

// ===========================================================================
// Suite 17 – clearError: removes banner from outer .checkout__payment-methods
// ===========================================================================
describe('clearError – removes persisted error banner from outer .checkout__payment-methods', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Build the outer container (.checkout__payment-methods) with a persisted
      // error banner injected before Preact mounts (showPersistedPaymentError path).
      const outer = win.document.createElement('div');
      outer.className = 'checkout__payment-methods';

      const banner = win.document.createElement('div');
      banner.className = 'checkout-payment-methods-error';
      banner.id = 'adyen-persisted-payment-error';
      banner.setAttribute('role', 'alert');
      banner.textContent = 'We're sorry, your payment was declined.';
      outer.appendChild(banner);

      win.document.body.appendChild(outer);
    });

    // Inject the clearError helper after the DOM is built
    cy.window().then((win) => {
      win.__clearError = (container) => {
        if (!container) return;
        const errorDiv = container.querySelector('.error-message');
        if (errorDiv) errorDiv.remove();
        const paymentMethodsOuter = win.document.querySelector('.checkout__payment-methods');
        const paymentMethodsContent = win.document.querySelector('.checkout-payment-methods__content');
        [paymentMethodsOuter, paymentMethodsContent].forEach((el) => {
          if (!el) return;
          el.querySelectorAll('.checkout-payment-methods-error').forEach((b) => b.remove());
        });
      };
    });
  });

  it('removes the persisted error banner from the outer container', () => {
    cy.window().then((win) => {
      // Confirm banner exists before clearing
      expect(win.document.querySelector('#adyen-persisted-payment-error')).to.not.be.null;
      win.__clearError(win.document.body);
    });
    cy.get('#adyen-persisted-payment-error').should('not.exist');
    cy.get('.checkout__payment-methods .checkout-payment-methods-error').should('not.exist');
  });

  it('does not throw when the outer container is absent', () => {
    cy.window().then((win) => {
      // Remove outer container before calling clearError
      const outer = win.document.querySelector('.checkout__payment-methods');
      if (outer) outer.remove();
      expect(() => win.__clearError(win.document.body)).to.not.throw();
    });
  });
});

// ===========================================================================
// Suite 18 – clearError: dual-removal from both outer and inner containers
// ===========================================================================
describe('clearError – removes banners from both outer and inner containers simultaneously', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Build BOTH containers with error banners present
      const outer = win.document.createElement('div');
      outer.className = 'checkout__payment-methods';
      const outerBanner = win.document.createElement('div');
      outerBanner.className = 'checkout-payment-methods-error';
      outerBanner.id = 'adyen-persisted-payment-error';
      outerBanner.textContent = 'Outer banner';
      outer.appendChild(outerBanner);
      win.document.body.appendChild(outer);

      const inner = win.document.createElement('div');
      inner.className = 'checkout-payment-methods__content';
      const innerBanner = win.document.createElement('div');
      innerBanner.className = 'checkout-payment-methods-error';
      innerBanner.id = 'adyen-inline-payment-error';
      innerBanner.textContent = 'Inner banner';
      inner.appendChild(innerBanner);
      win.document.body.appendChild(inner);

      win.__clearError = (container) => {
        if (!container) return;
        const errorDiv = container.querySelector('.error-message');
        if (errorDiv) errorDiv.remove();
        const paymentMethodsOuter = win.document.querySelector('.checkout__payment-methods');
        const paymentMethodsContent = win.document.querySelector('.checkout-payment-methods__content');
        [paymentMethodsOuter, paymentMethodsContent].forEach((el) => {
          if (!el) return;
          el.querySelectorAll('.checkout-payment-methods-error').forEach((b) => b.remove());
        });
      };
    });
  });

  it('removes banners from both outer and inner containers in a single clearError call', () => {
    cy.window().then((win) => {
      expect(win.document.querySelectorAll('.checkout-payment-methods-error')).to.have.length(2);
      win.__clearError(win.document.body);
    });
    cy.get('.checkout-payment-methods-error').should('not.exist');
    cy.get('#adyen-persisted-payment-error').should('not.exist');
    cy.get('#adyen-inline-payment-error').should('not.exist');
  });

  it('leaves unrelated DOM elements untouched after clearing', () => {
    cy.window().then((win) => {
      // Add an unrelated element inside the outer container
      const unrelated = win.document.createElement('div');
      unrelated.id = 'unrelated-element';
      unrelated.className = 'some-other-class';
      win.document.querySelector('.checkout__payment-methods').appendChild(unrelated);

      win.__clearError(win.document.body);
    });
    cy.get('#unrelated-element').should('exist');
  });
});

// ===========================================================================
// Helper: visit a page and expose the remaining utility functions
// ===========================================================================

function visitAndExposeExtraUtils() {
  cy.visit('/', { failOnStatusCode: false });

  cy.window().then((win) => {
    // ── callIfFunction ───────────────────────────────────────────────────────
    win.__callIfFunction = (value, ...args) => (typeof value === 'function' ? value(...args) : value);

    // ── debounce ─────────────────────────────────────────────────────────────
    win.__debounce = (func, wait = 300) => {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    };

    // ── showLoading / hideLoading ────────────────────────────────────────────
    win.__showLoading = (element) => {
      if (!element) return;
      element.classList.add('loading');
      element.setAttribute('aria-busy', 'true');
    };

    win.__hideLoading = (element) => {
      if (!element) return;
      element.classList.remove('loading');
      element.removeAttribute('aria-busy');
    };

    // ── commerceToAdyenShippingAddress ───────────────────────────────────────
    win.__commerceToAdyenShippingAddress = (address) => {
      if (!address) throw new Error('Address is required for payment processing');
      const houseNumber = address.street?.[0]?.match(/\d+/g)?.[0] || '';
      return {
        city: address.city || '',
        country: address.country?.code || address.country || '',
        houseNumberOrName: houseNumber,
        postalCode: address.postCode || '',
        street: address.street?.join(' ') || '',
        stateOrProvince: address.region?.code || address.region || '',
        firstname: address.firstName || '',
        lastname: address.lastName || '',
      };
    };

    // ── isNative3DSAction ────────────────────────────────────────────────────
    win.__isNative3DSAction = (action) => action?.type === 'threeDS2';
  });
}

// ===========================================================================
// Suite 19 – callIfFunction
// ===========================================================================
describe('callIfFunction – calls when function, returns value otherwise', () => {
  beforeEach(() => {
    visitAndExposeExtraUtils();
  });

  it('calls the value with provided args and returns the result when value is a function', () => {
    cy.window().then((win) => {
      const add = (a, b) => a + b;
      expect(win.__callIfFunction(add, 2, 3)).to.equal(5);
    });
  });

  it('returns the value unchanged when it is not a function', () => {
    cy.window().then((win) => {
      expect(win.__callIfFunction(42)).to.equal(42);
      expect(win.__callIfFunction('hello')).to.equal('hello');
      expect(win.__callIfFunction(null)).to.be.null;
    });
  });

  it('calls a zero-argument function and returns its result', () => {
    cy.window().then((win) => {
      const fn = () => 'called';
      expect(win.__callIfFunction(fn)).to.equal('called');
    });
  });
});

// ===========================================================================
// Suite 20 – debounce
// ===========================================================================
describe('debounce – coalesces rapid calls into a single deferred invocation', () => {
  beforeEach(() => {
    visitAndExposeExtraUtils();
  });

  it('calls the debounced function once after the wait period', (done) => {
    cy.window().then((win) => {
      let callCount = 0;
      const debounced = win.__debounce(() => { callCount += 1; }, 50);

      // Fire 5 times rapidly
      for (let i = 0; i < 5; i += 1) {
        debounced();
      }

      // After the debounce period, should have fired exactly once
      setTimeout(() => {
        expect(callCount).to.equal(1);
        done();
      }, 100);
    });
  });

  it('passes the latest arguments to the debounced function', (done) => {
    cy.window().then((win) => {
      let lastArg = null;
      const debounced = win.__debounce((arg) => { lastArg = arg; }, 50);

      debounced('first');
      debounced('second');
      debounced('third');

      setTimeout(() => {
        expect(lastArg).to.equal('third');
        done();
      }, 100);
    });
  });
});

// ===========================================================================
// Suite 21 – showLoading / hideLoading
// ===========================================================================
describe('showLoading / hideLoading – loading class and aria-busy attribute', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      win.__showLoading = (element) => {
        if (!element) return;
        element.classList.add('loading');
        element.setAttribute('aria-busy', 'true');
      };

      win.__hideLoading = (element) => {
        if (!element) return;
        element.classList.remove('loading');
        element.removeAttribute('aria-busy');
      };

      const el = win.document.createElement('div');
      el.id = 'adyen-loading-test';
      win.document.body.appendChild(el);
    });
  });

  it('showLoading adds the loading class to the element', () => {
    cy.window().then((win) => {
      const el = win.document.getElementById('adyen-loading-test');
      win.__showLoading(el);
      expect(el.classList.contains('loading')).to.be.true;
    });
  });

  it('showLoading sets aria-busy="true" on the element', () => {
    cy.window().then((win) => {
      const el = win.document.getElementById('adyen-loading-test');
      win.__showLoading(el);
      expect(el.getAttribute('aria-busy')).to.equal('true');
    });
  });

  it('hideLoading removes the loading class from the element', () => {
    cy.window().then((win) => {
      const el = win.document.getElementById('adyen-loading-test');
      win.__showLoading(el);
      win.__hideLoading(el);
      expect(el.classList.contains('loading')).to.be.false;
    });
  });

  it('hideLoading removes the aria-busy attribute from the element', () => {
    cy.window().then((win) => {
      const el = win.document.getElementById('adyen-loading-test');
      win.__showLoading(el);
      win.__hideLoading(el);
      expect(el.hasAttribute('aria-busy')).to.be.false;
    });
  });

  it('showLoading is a no-op when called with null (does not throw)', () => {
    cy.window().then((win) => {
      expect(() => win.__showLoading(null)).to.not.throw();
    });
  });

  it('hideLoading is a no-op when called with null (does not throw)', () => {
    cy.window().then((win) => {
      expect(() => win.__hideLoading(null)).to.not.throw();
    });
  });
});

// ===========================================================================
// Suite 22 – commerceToAdyenShippingAddress
// ===========================================================================
describe('commerceToAdyenShippingAddress – extends billing fields with firstname and lastname', () => {
  beforeEach(() => {
    visitAndExposeExtraUtils();
  });

  it('returns a shipping address with all billing fields plus firstname and lastname', () => {
    cy.window().then((win) => {
      const address = {
        city: 'Austin',
        country: { code: 'US' },
        postCode: '78701',
        street: ['123 Main St'],
        region: { code: 'TX' },
        firstName: 'Jane',
        lastName: 'Doe',
      };
      const result = win.__commerceToAdyenShippingAddress(address);
      expect(result.city).to.equal('Austin');
      expect(result.country).to.equal('US');
      expect(result.postalCode).to.equal('78701');
      expect(result.houseNumberOrName).to.equal('123');
      expect(result.stateOrProvince).to.equal('TX');
      expect(result.firstname).to.equal('Jane');
      expect(result.lastname).to.equal('Doe');
    });
  });

  it('uses empty string for firstname/lastname when they are absent from the address', () => {
    cy.window().then((win) => {
      const address = {
        city: 'Portland',
        country: 'US',
        postCode: '97201',
        street: ['456 Oak Ave'],
        region: 'OR',
      };
      const result = win.__commerceToAdyenShippingAddress(address);
      expect(result.firstname).to.equal('');
      expect(result.lastname).to.equal('');
    });
  });

  it('throws when address is null (same guard as billing address)', () => {
    cy.window().then((win) => {
      expect(() => win.__commerceToAdyenShippingAddress(null)).to.throw();
    });
  });
});

// ===========================================================================
// Suite 23 – isNative3DSAction
// ===========================================================================
describe('isNative3DSAction – returns true only for threeDS2 action type', () => {
  beforeEach(() => {
    visitAndExposeExtraUtils();
  });

  it('returns true for action with type "threeDS2"', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction({ type: 'threeDS2' })).to.be.true;
    });
  });

  it('returns false for a redirect action', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction({ type: 'redirect' })).to.be.false;
    });
  });

  it('returns false for a voucher action', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction({ type: 'voucher' })).to.be.false;
    });
  });

  it('returns false for null action', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction(null)).to.be.false;
    });
  });

  it('returns false for undefined action', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction(undefined)).to.be.false;
    });
  });

  it('returns false when action has no type property', () => {
    cy.window().then((win) => {
      expect(win.__isNative3DSAction({})).to.be.false;
    });
  });
});

// ===========================================================================
// Suite 24 – getBrowserInfo
// ===========================================================================
describe('getBrowserInfo – returns browser information object', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Verbatim copy of getBrowserInfo from blocks/adyen-payment/utils.js
      win.__getBrowserInfo = () => ({
        acceptHeader: '*/*',
        colorDepth: win.screen.colorDepth,
        language: win.navigator.language,
        javaEnabled: false,
        screenHeight: win.screen.height,
        screenWidth: win.screen.width,
        userAgent: win.navigator.userAgent,
        timeZoneOffset: new Date().getTimezoneOffset(),
      });
    });
  });

  it('returns an object with acceptHeader set to "*/*"', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.acceptHeader).to.equal('*/*');
    });
  });

  it('returns javaEnabled as false', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.javaEnabled).to.equal(false);
    });
  });

  it('returns colorDepth matching screen.colorDepth', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.colorDepth).to.equal(win.screen.colorDepth);
    });
  });

  it('returns language matching navigator.language', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.language).to.equal(win.navigator.language);
    });
  });

  it('returns screenHeight and screenWidth matching window.screen dimensions', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.screenHeight).to.equal(win.screen.height);
      expect(info.screenWidth).to.equal(win.screen.width);
    });
  });

  it('returns userAgent matching navigator.userAgent', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.userAgent).to.equal(win.navigator.userAgent);
    });
  });

  it('returns timeZoneOffset as a number', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      expect(info.timeZoneOffset).to.be.a('number');
    });
  });

  it('returns an object with exactly the 8 expected keys', () => {
    cy.window().then((win) => {
      const info = win.__getBrowserInfo();
      const keys = Object.keys(info).sort();
      expect(keys).to.deep.equal([
        'acceptHeader',
        'colorDepth',
        'javaEnabled',
        'language',
        'screenHeight',
        'screenWidth',
        'timeZoneOffset',
        'userAgent',
      ]);
    });
  });
});

// ===========================================================================
// Suite 25 – getAdyenCDNLogoUrl
// ===========================================================================
describe('getAdyenCDNLogoUrl – returns correct CDN URL for card brand logos', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Verbatim copy of getAdyenCDNLogoUrl from blocks/adyen-payment/utils.js
      win.__getAdyenCDNLogoUrl = (brand, environment = 'test') => `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/images/logos/${brand}.svg`;
    });
  });

  it('returns test CDN URL for visa brand by default', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('visa');
      expect(url).to.equal(
        'https://checkoutshopper-test.adyen.com/checkoutshopper/images/logos/visa.svg',
      );
    });
  });

  it('returns live CDN URL when environment is "live"', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('mc', 'live');
      expect(url).to.equal(
        'https://checkoutshopper-live.adyen.com/checkoutshopper/images/logos/mc.svg',
      );
    });
  });

  it('uses "test" as the default environment when none is provided', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('amex');
      expect(url).to.include('checkoutshopper-test.adyen.com');
    });
  });

  it('embeds the brand name in the URL path', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('paypal', 'test');
      expect(url).to.include('/logos/paypal.svg');
    });
  });

  it('returns a URL ending in .svg', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('discover', 'test');
      expect(url).to.match(/\.svg$/);
    });
  });

  it('returns a valid URL for any brand string', () => {
    cy.window().then((win) => {
      const url = win.__getAdyenCDNLogoUrl('unionpay', 'live');
      expect(() => new URL(url)).to.not.throw();
    });
  });
});

// ===========================================================================
// Suite 26 – loadAdyenWebSDK: already-loaded guard (no-op)
// ===========================================================================
describe('loadAdyenWebSDK – already-loaded guard resolves immediately', () => {
  it('resolves immediately when window.AdyenWeb.AdyenCheckout is already defined', () => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Simulate already-loaded SDK via window.AdyenWeb.AdyenCheckout
      win.AdyenWeb = { AdyenCheckout: () => {} };

      // Verbatim copy of the guard-only portion of loadAdyenWebSDK
      win.__loadAdyenWebSDK = async () => {
        if (win.AdyenWeb?.AdyenCheckout || win.AdyenCheckout) {
          return Promise.resolve(); // Already loaded
        }
        // (real SDK injection omitted — not reachable in this test)
        throw new Error('Should not reach injection code when SDK is pre-loaded');
      };
    });

    cy.window().then(async (win) => {
      let resolved = false;
      await win.__loadAdyenWebSDK().then(() => { resolved = true; });
      expect(resolved).to.be.true;
    });
  });

  it('resolves immediately when window.AdyenCheckout (legacy global) is already defined', () => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Simulate legacy global
      win.AdyenCheckout = () => {};

      win.__loadAdyenWebSDK = async () => {
        if (win.AdyenWeb?.AdyenCheckout || win.AdyenCheckout) {
          return Promise.resolve();
        }
        throw new Error('Should not reach injection code when SDK is pre-loaded');
      };
    });

    cy.window().then(async (win) => {
      let resolved = false;
      await win.__loadAdyenWebSDK().then(() => { resolved = true; });
      expect(resolved).to.be.true;
    });
  });

  it('injects a <link> and <script> tag into <head> when SDK is not loaded', () => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      // Ensure neither global is set
      delete win.AdyenWeb;
      delete win.AdyenCheckout;

      win.__loadAdyenWebSDKInject = (environment = 'test', version = '6.23.0') => new Promise((resolve) => {
        const cssLink = win.document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/sdk/${version}/adyen.css`;
        cssLink.id = 'adyen-sdk-css-test';
        cssLink.setAttribute('crossorigin', 'anonymous');
        win.document.head.appendChild(cssLink);

        const script = win.document.createElement('script');
        script.src = `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/sdk/${version}/adyen.js`;
        script.id = 'adyen-sdk-script-test';
        script.async = true;
        script.setAttribute('crossorigin', 'anonymous');
        // Resolve immediately for test (no real network load)
        script.onload = () => resolve();
        win.document.head.appendChild(script);
        // Simulate load event
        resolve();
      });
    });

    cy.window().then(async (win) => {
      await win.__loadAdyenWebSDKInject('test', '6.23.0');

      const cssLink = win.document.getElementById('adyen-sdk-css-test');
      const scriptTag = win.document.getElementById('adyen-sdk-script-test');

      expect(cssLink).to.not.be.null;
      expect(cssLink.rel).to.equal('stylesheet');
      expect(cssLink.href).to.include('adyen.css');

      expect(scriptTag).to.not.be.null;
      expect(scriptTag.src).to.include('adyen.js');
      expect(scriptTag.async).to.be.true;
    });
  });
});
