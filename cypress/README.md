# Running E2E tests

Note - Following commands expects local server is running at <http://localhost:3000/>.

1. Clone the repo and change directory to `cypress`
2. Run `npm install`
3. Run `npm run cypress:open`
4. Click on E2E Testing in cypress UI window.
5. Click on Start E2E Testing on Chrome button.
6. Now select respective test to Run from Cypress UI.
7. To run all tests use `npm run cypress:run`

## SaaS vs PaaS

By default, the `cypress:open` and `cypress:run` commands run tests targeting the PaaS commerce environment created for the boilerplate.

You can run tests against the SaaS environment with `cypress:saas:open` or `cypress:saas:run`.

Both sets of commands are used during the boilerplate CICD workflows to ensure that any change to the boilerplate works against either type of environment.

Both commands use a base config, defined in `cypress.base.config.js` and extend in the corresponding config, either `cypress.paas.config.js` or `cypress.saas.config.js`. This allows us to use variables for things which differ in the environments, such as gift card codes, product option uids, etc.

### Skipping Tests

For various reasons, certain tests fail against certain environments. Eventually these will issues will be fixed. But for now, if a test is _expected_ to fail on a specific environment, you can assign a tag to it.

- `{ tags: '@skipSaas' }` skips the test when run with `cypress:saas:run`
- `{ tags: '@skipPaas' }` skips the test when run with `cypress:run`.

| Skipped Tests | Backend Env | Notes |
| ------------- | ------------- | -------- |
| `verifyStoreSwitcher.spec`  | SaaS, PaaS | Story to re-configire multi store <https://jira.corp.adobe.com/browse/USF-2253> |
| `verifyUserAccount.spec` | SaaS, PaaS | Task <https://jira.corp.adobe.com/browse/USF-2310> |
| `recs.spec` | SaaS | Epic <https://jira.corp.adobe.com/browse/COMOPT-81> |
| `search-product-click.spec` | SaaS | Epic <https://jira.corp.adobe.com/browse/COMOPT-81> |
| `search-request-sent.spec` | SaaS | Epic <https://jira.corp.adobe.com/browse/COMOPT-81> |
| `search-results-view.spec` | SaaS | Epic <https://jira.corp.adobe.com/browse/COMOPT-81> |

## Adyen Payment Tests

Adyen-specific E2E tests live in `cypress/src/tests/e2eTests/`. **18 spec files · 227 suites · 396 tests** _(as of 2026-04-02)_.

See `docs/test-coverage.md` for the full annotated table. Summary:

| Spec file | Suites | Coverage area |
|---|---|---|
| `verifyAdyenCheckout.spec.js` | 18 | Initialization, Cards/wallet rendering, localStorage lifecycle, `payments-details` contract, `recoverCart` contract + idempotency, `handleOrderPlaced` recover-cart on failure codes, `onAdditionalDetails` refusal recover-cart |
| `verifyAdyenRedirectBehaviors.spec.js` | 15 | Redirect URL building, resultCode handling (`Pending`/`Received` as success), error UI, `adyen_payment_result` persistence; client-side redirect flow; `placeOrder` failure → `/checkout`; server-side `Pending` treated as success |
| `verifyAdyenPaymentCards.spec.js` | 12 | Container structure, guest/logged-in picker, stored card selection, `checkout/updated` unmount, debounce, error states |
| `verifyAdyenDonation.spec.js` | 12 | Campaign fetch, donation POST (happy path + pending), cancel, round-up, sessionStorage fallback, missing backendUrl |
| `verifyAdyenAdditionalAction.spec.js` | 13 | Voucher/qrCode/await/redirect action types, JSON string parsing, `setPendingOrderData`, malformed JSON safety |
| `verifyAdyenAltPayments.spec.js` | 18 | Affirm, BACS, iDEAL, Klarna, PayPal: container structure, DOM ids/classes, pay button, errors, `onPaymentFailed`, cross-block presence |
| `verifyAdyenGooglePay.spec.js` | 7 | Google Pay container structure, init errors, `onSubmit` Backend result code, place-order button hidden |
| `verifyAdyenApplePay.spec.js` | 7 | Apple Pay container structure, init errors, `applepay` absent from PM response, place-order button hidden |
| `verifyAdyenBancontact.spec.js` | 6 | Bancontact container structure, init errors, `checkout/updated` component removal on method switch |
| `verifyAdyenRedirectionBlock.spec.js` | 7 | Block presence, `.adyen-payment-redirection__loader` on `document.body`, `paymentFailed=true` error UI, order number/support link/order-details link, idle path |
| `verifyAdyenPreAuth.spec.js` | 8 | 3DS2 pre-auth flow: frictionless Authorised, fingerprint→AuthenticationFinished, fingerprint→ChallengeShopper, Refused error, modal dismiss, stored card skip, non-scheme skip, backend 500 |
| `verifyAdyenUtils.spec.js` | 23 | All `utils.js` pure functions — 98 tests |
| `verifyAdyenState.spec.js` | 10 | All `state.js` functions — 31 tests |
| `verifyAdyenStorage.spec.js` | 9 | All `storage.js` functions — 15 tests |
| `verifyAdyenConfig.spec.js` | 13 | All `config.js` functions — 17 tests |
| `verifyAdyenHandlers.spec.js` | 23 | All `handlers.js` factory functions — 37 tests; wallet decline cart recovery, guest fields to sessionStorage, `placeOrder` GraphQL error → `refund-or-cancel`, server-side Pending/Received, client-side Pending |
| `verifyAdyenManualSubmit.spec.js` | 5 | `manualSubmit` form-validation paths — 5 tests; login/shipping/billing/shipping-method invalid (blocked), happy path |
| `verifyAdyenCommerceCheckout.spec.js` | 16 | `commerce-checkout.js` 3DS2 decline recovery, guest email restore, `firstAuthEventReceived` guard — 41 tests |

### Test patterns

Most Adyen tests use:

- **`cy.intercept`** to stub backend responses — a live Adyen backend is not required for most suites
- **`localStorage` / `sessionStorage` seeding** to simulate post-redirect state without an actual redirect
- **`@skipSaas` / `@skipPaas`** tags to skip tests that require a specific backend environment

### Adyen Cypress env variables

| Variable | Required for | Description |
|---|---|---|
| `adyenBackendUrl` | Suite 4 in `verifyAdyenCheckout.spec.js` (redirect flow) | Base URL of the Adyen OOPE backend; used for `payments-details` intercept matching |

Set these in `cypress.paas.config.js` or `cypress.saas.config.js` under the `env` key, or pass them via `--env` on the command line.
