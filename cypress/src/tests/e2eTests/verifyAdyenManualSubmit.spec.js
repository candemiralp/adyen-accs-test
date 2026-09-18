/**
 * Adyen manualSubmit – Cypress E2E Tests
 *
 * Covers the form-validation and happy-path branches of `manualSubmit`
 * (blocks/adyen-payment/handlers.js lines 48–112).
 *
 * The function is inlined verbatim onto `window` via `cy.window().then()` so
 * Cypress can call it in the browser context without cross-origin ES module
 * issues.  Named forms are built with `checkValidity`/`reportValidity` stubs.
 * No network intercepts are needed because the only external call on the happy
 * path is `checkoutApi.setPaymentMethod`, which we also stub on `window`.
 *
 * Scenarios covered:
 *
 *  Suite 1 – Login form invalid → actions.reject + reportValidity called
 *  Suite 2 – Shipping form invalid → actions.reject + reportValidity called
 *  Suite 3 – Billing form invalid → actions.reject + reportValidity called
 *  Suite 4 – No shipping method selected → actions.reject
 *  Suite 5 – All validations pass → setPaymentMethod called + actions.resolve('Backend')
 */

// ---------------------------------------------------------------------------
// Helper: expose a self-contained manualSubmit onto window
//
// The implementation is a verbatim copy of handlers.js so changes there
// require a corresponding update here.
// ---------------------------------------------------------------------------
function exposeManualSubmit(win, opts = {}) {
  const {
    setPaymentMethodShouldFail = false,
  } = opts;

  // Track calls for assertions
  win.__manualSubmitCalls = {
    setPaymentMethod: [],
    reportValidity: [],
  };

  // Stub checkoutApi.setPaymentMethod
  win.__checkoutApi = {
    setPaymentMethod: async (args) => {
      win.__manualSubmitCalls.setPaymentMethod.push(args);
      if (setPaymentMethodShouldFail) throw new Error('setPaymentMethod failed');
    },
  };

  // Inline manualSubmit matching handlers.js
  win.__manualSubmit = async (state, component, actions) => {
    try {
      const { forms } = win.document;
      const isFormVisible = (form) => form && form.offsetParent !== null;

      // 1. Login form
      const loginForm = forms['login-form'];
      if (isFormVisible(loginForm) && !loginForm.checkValidity()) {
        loginForm.reportValidity();
        actions.reject('Please fill in your email address');
        return;
      }

      // 2. Shipping address form
      const shippingForm = forms['checkout-shipping-address-form'];
      if (isFormVisible(shippingForm) && !shippingForm.checkValidity()) {
        shippingForm.reportValidity();
        actions.reject('Please complete the shipping address');
        return;
      }

      // 3. Billing address form
      const billingForm = forms['checkout-billing-address-form'];
      if (isFormVisible(billingForm) && !billingForm.checkValidity()) {
        billingForm.reportValidity();
        actions.reject('Please complete the billing address');
        return;
      }

      // 4. Shipping method selection
      const shippingMethodsContainer = win.document.querySelector(
        '.checkout-shipping-methods__methods',
      );
      if (
        shippingMethodsContainer
        && shippingMethodsContainer.offsetParent !== null
      ) {
        const selectedShipping = shippingMethodsContainer.querySelector(
          'input[type="radio"]:checked',
        );
        if (!selectedShipping) {
          actions.reject('Please select a shipping method');
          return;
        }
      }

      // All validations passed
      await win.__checkoutApi.setPaymentMethod({
        code: `adyen_${state.data.paymentMethod.type}`,
        additional_data: [{ key: 'state', value: JSON.stringify(state.data) }],
      });

      actions.resolve({ resultCode: 'Backend' });
    } catch (error) {
      if (component.props?.onError) component.props.onError(error);
      actions.reject();
    }
  };
}

// ---------------------------------------------------------------------------
// Helper: create a named form element and attach it to document
// ---------------------------------------------------------------------------
function createForm(win, name, { visible = true, valid = true } = {}) {
  const form = win.document.createElement('form');
  form.name = name;
  form.id = name; // ensures document.forms[name] resolves

  // Visibility: offsetParent is null for display:none; use a block element in
  // the live document to get a non-null offsetParent.
  if (!visible) {
    form.style.display = 'none';
  }

  // checkValidity stub
  form.checkValidity = () => valid;
  // reportValidity stub – record invocations
  form.reportValidity = () => {
    win.__manualSubmitCalls.reportValidity.push(name);
    return valid;
  };

  win.document.body.appendChild(form);
  return form;
}

// ---------------------------------------------------------------------------
// Helper: build mock actions
// ---------------------------------------------------------------------------
function buildActions() {
  const calls = { resolve: null, reject: undefined };
  return {
    resolve: (data) => { calls.resolve = data; },
    reject: (reason) => { calls.reject = reason; },
    _calls: calls,
  };
}

// ---------------------------------------------------------------------------
// Helper: build mock component
// ---------------------------------------------------------------------------
function buildComponent() {
  const errors = [];
  return {
    props: { onError: (err) => errors.push(err.message) },
    _errors: errors,
  };
}

const PAYMENT_STATE = {
  data: {
    paymentMethod: { type: 'paypal' },
    details: {},
  },
};

// ===========================================================================
// Suite 1 – Login form invalid
// ===========================================================================
describe('manualSubmit – login form invalid', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeManualSubmit(win);
      createForm(win, 'login-form', { visible: true, valid: false });
    });
  });

  it('calls actions.reject with email message and invokes reportValidity on login form', () => {
    cy.window().then(async (win) => {
      const actions = buildActions();
      const component = buildComponent();

      await win.__manualSubmit(PAYMENT_STATE, component, actions);

      expect(actions._calls.reject).to.equal('Please fill in your email address');
      expect(win.__manualSubmitCalls.setPaymentMethod).to.have.length(0);
      expect(win.__manualSubmitCalls.reportValidity).to.include('login-form');
    });
  });
});

// ===========================================================================
// Suite 2 – Shipping address form invalid
// ===========================================================================
describe('manualSubmit – shipping form invalid', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeManualSubmit(win);
      // Login form passes, shipping form fails
      createForm(win, 'login-form', { visible: true, valid: true });
      createForm(win, 'checkout-shipping-address-form', { visible: true, valid: false });
    });
  });

  it('calls actions.reject with shipping message and invokes reportValidity on shipping form', () => {
    cy.window().then(async (win) => {
      const actions = buildActions();
      const component = buildComponent();

      await win.__manualSubmit(PAYMENT_STATE, component, actions);

      expect(actions._calls.reject).to.equal('Please complete the shipping address');
      expect(win.__manualSubmitCalls.reportValidity).to.include('checkout-shipping-address-form');
      expect(win.__manualSubmitCalls.setPaymentMethod).to.have.length(0);
    });
  });
});

// ===========================================================================
// Suite 3 – Billing address form invalid
// ===========================================================================
describe('manualSubmit – billing form invalid', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeManualSubmit(win);
      // Login + shipping pass, billing fails
      createForm(win, 'login-form', { visible: true, valid: true });
      createForm(win, 'checkout-shipping-address-form', { visible: true, valid: true });
      createForm(win, 'checkout-billing-address-form', { visible: true, valid: false });
    });
  });

  it('calls actions.reject with billing message and invokes reportValidity on billing form', () => {
    cy.window().then(async (win) => {
      const actions = buildActions();
      const component = buildComponent();

      await win.__manualSubmit(PAYMENT_STATE, component, actions);

      expect(actions._calls.reject).to.equal('Please complete the billing address');
      expect(win.__manualSubmitCalls.reportValidity).to.include('checkout-billing-address-form');
      expect(win.__manualSubmitCalls.setPaymentMethod).to.have.length(0);
    });
  });
});

// ===========================================================================
// Suite 4 – No shipping method selected
// ===========================================================================
describe('manualSubmit – no shipping method selected', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeManualSubmit(win);
      // All forms pass
      createForm(win, 'login-form', { visible: true, valid: true });
      createForm(win, 'checkout-shipping-address-form', { visible: true, valid: true });
      createForm(win, 'checkout-billing-address-form', { visible: true, valid: true });

      // Add a visible shipping methods container with no checked radio
      const container = win.document.createElement('div');
      container.className = 'checkout-shipping-methods__methods';
      // No checked radio inside
      const radio = win.document.createElement('input');
      radio.type = 'radio';
      radio.name = 'shipping';
      // NOT checked
      container.appendChild(radio);
      win.document.body.appendChild(container);
    });
  });

  it('calls actions.reject with shipping-method message when no radio is checked', () => {
    cy.window().then(async (win) => {
      const actions = buildActions();
      const component = buildComponent();

      await win.__manualSubmit(PAYMENT_STATE, component, actions);

      expect(actions._calls.reject).to.equal('Please select a shipping method');
      expect(win.__manualSubmitCalls.setPaymentMethod).to.have.length(0);
    });
  });
});

// ===========================================================================
// Suite 5 – Happy path: all validations pass
// ===========================================================================
describe('manualSubmit – all validations pass (happy path)', () => {
  beforeEach(() => {
    cy.visit('/', { failOnStatusCode: false });
    cy.window().then((win) => {
      exposeManualSubmit(win);
      // All forms pass
      createForm(win, 'login-form', { visible: true, valid: true });
      createForm(win, 'checkout-shipping-address-form', { visible: true, valid: true });
      createForm(win, 'checkout-billing-address-form', { visible: true, valid: true });

      // Shipping methods container with a checked radio
      const container = win.document.createElement('div');
      container.className = 'checkout-shipping-methods__methods';
      const radio = win.document.createElement('input');
      radio.type = 'radio';
      radio.name = 'shipping';
      radio.checked = true;
      container.appendChild(radio);
      win.document.body.appendChild(container);
    });
  });

  it('calls setPaymentMethod with adyen_paypal code and resolves with Backend resultCode', () => {
    cy.window().then(async (win) => {
      const actions = buildActions();
      const component = buildComponent();

      await win.__manualSubmit(PAYMENT_STATE, component, actions);

      // setPaymentMethod should have been called with the correct code
      expect(win.__manualSubmitCalls.setPaymentMethod).to.have.length(1);
      expect(win.__manualSubmitCalls.setPaymentMethod[0].code).to.equal('adyen_paypal');

      // actions.resolve called with Backend resultCode
      expect(actions._calls.resolve).to.deep.equal({ resultCode: 'Backend' });
      expect(actions._calls.reject).to.be.undefined;
    });
  });
});
