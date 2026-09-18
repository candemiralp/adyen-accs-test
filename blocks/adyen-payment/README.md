# Adyen Payment — Shared Module

The `adyen-payment/` directory is the singleton shared by every Adyen payment block. It is never decorated directly as a block — it is imported via `../adyen-payment/index.js`.

## Files

| File | Responsibility |
|---|---|
| `index.js` | Public API facade — singleton `AdyenCheckout` instance, event wiring, re-exports |
| `config.js` | Config fetching and builders |
| `handlers.js` | Payment lifecycle callbacks (onSubmit, onAdditionalDetails, onPaymentCompleted) |
| `state.js` | In-memory state store (payment result, pending order, checkout attempt IDs) |
| `storage.js` | localStorage abstraction with TTL support |
| `utils.js` | Pure utility functions and UI helpers |
| `adyen-payment.css` | Shared styles (3DS overlay modal) |

---

## `index.js` — Public API

### Exports

| Export | Description |
|---|---|
| `getAdyenCheckout()` | Returns a `Promise` resolving to the shared `AdyenCheckoutInstance`. Awaited by every payment block. |
| `getAdyenConfiguration()` | Returns the current Adyen checkout configuration object. |
| `isCustomerLoggedIn()` | Returns `true` if a shopper is logged in (used by Cards block for `enableStoreDetails`). |
| `triggerPlaceOrder()` | Programmatically clicks the Commerce "Place Order" button (used by Google Pay). |
| `fetchOrderResult(backendUrl, pendingOrder)` | Calls `{backendUrl}order-result` to fetch a pending order's final payment result after a redirect. |
| `fetchPreAuthPayment(baseUrl, body)` | Calls `{baseUrl}pre-auth-payments` with `authenticationOnly: true` before order creation. |
| `mountNative3DSComponent(action, options)` | Opens `.adyen-3ds-overlay` modal and mounts `createFromAction(action)`. Stores `options.onComplete` as `overlay.__onComplete`. |
| `registerBeforeCheckoutUpdate(callback)` | Registers a callback that runs (and must resolve) before the checkout instance is updated. Used by the Cards block to prevent race conditions during 3DS. |
| `getCartDataSnapshot()` | Returns the current `cartData` snapshot. |
| `getCheckoutDataSnapshot()` | Returns the current `checkoutData` snapshot. |
| `getScopeCode()` | Returns the current scope code from store config. |
| `recoverCart(incrementId, email, resultCode)` | POSTs to `{backendUrl}recover-cart` to provision a new Commerce cart after a 3DS2 payment decline. Writes the new masked cart token to the `DROPIN__CART__CART-ID` cookie. Returns the new cart ID string, or `null` on failure. |
| `saveInstanceSnapshot()` | Serialises `publicConfig`, `staticConfig`, `paymentMethodsResponse`, `amount`, and tracked state values to `localStorage` under `STORAGE_KEYS.INSTANCE_SNAPSHOT`. |
| `clearInstanceSnapshot()` | Removes the stored instance snapshot from `localStorage`. |
| `restoreFromSnapshot()` | Restores the Adyen checkout instance from a previously saved snapshot without requiring `cartData` or `checkoutData`. Returns `Promise<boolean>` — `true` if restored, `false` if no snapshot found. |
| `setRecoveryStartCallback(callback)` | Registers a callback fired immediately before `recoverCart` is awaited and the page navigates to `/checkout` after a 3DS2 payment failure. Useful for showing a loading spinner. Pass `null` to unregister. Returns an unregister function. |
| All of `state.js` | Re-exported: `setPaymentResult`, `getPaymentResult`, `getPaymentResultSync`, `clearPaymentResult`, `setPendingOrderData`, `getPendingOrderData`, `clearPendingOrderData`, `getCheckoutAttemptId`, `clearCheckoutAttemptId`, `setPaymentResultFetchPromise`, `setActiveComponent`, `getActiveComponent`, `getPreviousOrderData` |

### Initialization flow

1. `getAdyenCheckout()` returns a shared promise that blocks all payment method blocks until ready.
2. The module listens on `checkout/initialized`, `checkout/values`, `checkout/updated`, `cart/data`, `cart/reset`, and `order/placed` events from the drop-in event bus.
3. Once cart data, checkout data (with `availablePaymentMethods`), and a country code are all present, initialization proceeds.
4. Country code priority: billing address → shipping address → cached public config → store default country → `'US'` fallback.
5. Subsequent data changes trigger a debounced `updateCheckoutInstance` which re-fetches payment methods if country, amount, or shopper email changed.

---

## `config.js` — Configuration

### Key functions

| Function | Description |
|---|---|
| `getBackendIntegrationUrl(checkoutData)` | Extracts the OOPE backend URL from `availablePaymentMethods[].oope_payment_method_config.backend_integration_url` and caches it in localStorage for 24 h. |
| `fetchPublicConfiguration(backendUrl, scope)` | POSTs to `{backendUrl}public-configuration`. Result is cached in localStorage for 24 h. |
| `fetchPaymentMethods(backendUrl, body)` | POSTs to `{backendUrl}payments-methods`. Not cached. |
| `buildStaticConfig()` | Builds the client-side Adyen checkout config object (locale, analytics, risk, session callbacks). |
| `buildBaseConfiguration(...)` | Merges `buildStaticConfig()` output with handler callbacks into the full config passed to `new AdyenCheckout()`. |

---

## `handlers.js` — Payment Lifecycle Callbacks

### Exports

| Export | Description |
|---|---|
| `createDefaultOnSubmit(baseUrl, getCartData, getCheckoutData, scope)` | Factory returning an `onSubmit` callback. Used by all blocks except Cards. Posts to `{backendUrl}payments` and stores `checkoutAttemptId` + `lineItems` in the request body. |
| `createDefaultOnAdditionalDetails(baseUrl, getCartData, recoverCartFn = null, options = {})` | Factory returning an `onAdditionalDetails` callback. Posts to `{backendUrl}payments-details`. On terminal failure codes (`FAILURE_RESULT_CODES = ['Refused', 'Error', 'Cancelled']`): cancels the Magento order, calls `recoverCartFn(incrementId, email, resultCode)` (if provided), fires `options.onRecoveryStart`, and redirects to `/checkout`. In **pre-auth mode** (when `overlay.__onComplete` is set): only tears down the modal and calls the callback on terminal result codes; intermediate chained actions are forwarded via `actions.resolve({ action })` so the SDK mounts the next step inside the existing modal. |
| `createDefaultOnPaymentCompleted(baseUrl, getCartData, options = {})` | Factory returning an `onPaymentCompleted` callback. Used by wallet methods (PayPal, Apple Pay). Places the order on `Authorised`; on decline (`Refused`, `Error`, `Cancelled`) calls `options.recoverCartFn` (if provided) for cart recovery, persists the decline message and guest fields to sessionStorage, calls `onError`, and redirects to `/checkout`. On `placeOrder` failure calls `refund-or-cancel` and `onError`. |
| `manualSubmit(state, component, actions)` | Used by the Cards block. Validates Commerce checkout forms, calls `setPaymentMethod`, then resolves with `{ resultCode: 'Backend' }` to hand off to the OOPE webhook. |

---

## `state.js` — In-Memory State

All state is module-level variables with getter/setter functions. No class instances.

| Function | Description |
|---|---|
| `setPaymentResult(result)` / `getPaymentResult()` / `getPaymentResultSync()` / `clearPaymentResult()` | Stores the final payment result. `getPaymentResult()` is async — waits for any pending fetch promise to settle first. |
| `setPaymentResultFetchPromise(p)` / `getPaymentResultFetchPromise()` | Stores the in-flight fetch promise so concurrent callers await the same request. |
| `setPendingOrderData(data)` / `getPendingOrderData()` / `clearPendingOrderData()` | Order data for server-side flows (set before redirect, consumed on return). Passing `null` clears the entry. |
| `getCheckoutAttemptId(cartId)` | Returns the attempt ID for the given cart. Generates a new UUID if none exists; writes both the cart-specific key (`adyen_checkout_attempt_{cartId}`) and the fallback key (`adyen_last_checkout_attempt`). Passes `null` as `cartId` to use only the fallback key. |
| `clearCheckoutAttemptId(cartId)` | Removes the cart-specific key; preserves the fallback key. |
| `setActiveComponent(component)` / `getActiveComponent()` | Tracks the currently mounted payment component (used by `manualSubmit`). |
| `getPreviousOrderData()` | Deprecated alias for `getPaymentResult()` — kept for backward compatibility. |

---

## `storage.js` — localStorage Abstraction

### Storage keys (`STORAGE_KEYS`)

| Constant | Key | TTL |
|---|---|---|
| `PAYMENT_RESULT` | `adyen_payment_result` | Session (no expiry) |
| `PENDING_ORDER` | `adyen_pending_order` | Session (no expiry) |
| `INTEGRATION_URL` | `adyen_integration_url` | 24 h |
| `PUBLIC_CONFIG` | `adyen_public_configuration` | 24 h |
| `CHECKOUT_ATTEMPT_PREFIX` | `adyen_checkout_attempt_` | Session (per cart) |
| `LAST_CHECKOUT_ATTEMPT` | `adyen_last_checkout_attempt` | Session (fallback) |
| `INSTANCE_SNAPSHOT` | `adyen_instance_snapshot` | No TTL (manually cleared via `clearInstanceSnapshot()`) |
| `PAYMENT_ERROR` | `adyen_payment_error` | Session (`sessionStorage`, cleared after display by `showPersistedPaymentError`) |

### Key functions

| Function | Description |
|---|---|
| `getWithExpiry(key)` | Reads a JSON-encoded `{ value, ':expiry' }` object. Returns `null` if missing or past expiry (and removes the stale key). |
| `setWithExpiry(key, value, ttlMs)` | Writes `{ value, ':expiry': Date.now() + ttlMs }` as JSON. |
| `getJSON(key)` / `setJSON(key, value)` | Plain JSON get/set with no TTL. Returns `null` on malformed JSON. |
| `getItem(key)` / `setItem(key, value)` / `removeItem(key)` | Raw string get/set/remove. Never throws. |

---

## `utils.js` — Utilities

### Amount helpers

| Function | Description |
|---|---|
| `formatAmount(amount, currency)` | Converts a decimal amount to Adyen minor units (integer). |
| `parseAmount(minorUnits, currency)` | Converts Adyen minor units back to a decimal amount. |

### Payment result helpers

| Function | Description |
|---|---|
| `isValidPaymentResult(result)` | Returns `true` if the result object has a `resultCode` string. |
| `isPaymentSuccessful(result)` | Returns `true` for `Authorised`, `Pending`, `Received`. |
| `needsAdditionalAction(result)` | Returns `true` if the result includes an `action` object. |

### URL helpers

| Function | Description |
|---|---|
| `getReturnUrl()` | Returns the current page URL (used as the return URL for redirect flows). |

### Address helpers

| Function | Description |
|---|---|
| `commerceToAdyenBillingAddress(address)` | Maps a Commerce address object to Adyen's `billingAddress` shape (`street`, `houseNumberOrName`, `city`, `stateOrProvince`, `postalCode`, `country`). |

### UI helpers

| Function | Description |
|---|---|
| `showError(block, message)` | Renders an error message in the block's `.adyen-error-container`. |
| `clearError(block)` | Removes the error message. |
| `loadAdyenWebSDK()` | Dynamically loads the Adyen Web SDK script and stylesheet. |
| `getAdyenCheckoutFactory()` | Constructs `new window.AdyenWeb.AdyenCheckout(config)`. |

### Parse helpers (for block `data-*` attributes)

| Function | Description |
|---|---|
| `parseBoolean(value)` | Returns `true` for `'true'` (case-insensitive), `false` otherwise. |
| `parseInteger(value, defaultValue)` | Parses to integer; returns `defaultValue` on `NaN`. |
| `parseJson(value)` | Parses JSON string; returns `null` on invalid input. |
| `parseStringArray(value)` | Parses a comma-separated string into a trimmed array; returns `[]` on falsy input. |

---

## Testing

The shared module has dedicated Cypress unit-style spec files. All module logic is inlined verbatim onto `window` via `cy.window().then()` to avoid cross-origin ES module import issues in Cypress.

| Spec file | Suites | Coverage |
|---|---|---|
| `verifyAdyenUtils.spec.js` | 26 | All functions in `utils.js` — 106 tests; includes `callIfFunction`, `debounce`, `showLoading`/`hideLoading`, `commerceToAdyenShippingAddress`, `isNative3DSAction`, `getBrowserInfo`, `getAdyenCDNLogoUrl`, `loadAdyenWebSDK` |
| `verifyAdyenState.spec.js` | 10 | All functions in `state.js` — 31 tests; includes `setRedirectPaymentCode`/`getRedirectPaymentCode`/`clearRedirectPaymentCode`, `setActiveComponent`/`getActiveComponent`, `setPaymentResultFetchPromise`/`getPaymentResultFetchPromise` |
| `verifyAdyenStorage.spec.js` | 9 | All functions in `storage.js` — 15 tests |
| `verifyAdyenConfig.spec.js` | 13 | All functions in `config.js` — 17 tests |
| `verifyAdyenHandlers.spec.js` | 25 | All factory functions in `handlers.js` — 41 tests; includes wallet decline cart recovery, guest fields to sessionStorage on wallet decline, client-side `placeOrder` GraphQL error → `refund-or-cancel`, server-side Pending/Received clears pending order, client-side Pending calls `placeOrder`, client-side Authorised, chained native 3DS resolve, guest email/name to sessionStorage, post-order chained `threeDS2` action resolves with action, `createDefaultOnPaymentCompleted` cartId guard (no recovery when cartId absent) |
| `verifyAdyenIndex.spec.js` | 9 | `index.js` shared utilities — 38 tests; `mountNative3DSComponent` (modal DOM structure, `onMounted` callback, close button teardown+`onDismiss`, duplicate overlay guard), `recoverCart` (HTTP error returns null, extra fields forwarded, `DROPIN__CART__CART-ID` cookie on newCartId), `saveInstanceSnapshot`/`clearInstanceSnapshot` localStorage round-trip, `restoreFromSnapshot` returns false when no snapshot |
| `verifyAdyenManualSubmit.spec.js` | 5 | `manualSubmit` form-validation paths in `handlers.js` — 5 tests; login/shipping/billing form invalid (submit blocked), no shipping method selected (blocked), happy path (`setPaymentMethod` called + `actions.resolve('Backend')`) |
| `verifyAdyenCommerceCheckout.spec.js` | 16 | `commerce-checkout.js`: `isPaymentErrorRecovery` flag, `handleAuthenticated` first-call skip + reload guard, `firstAuthEventReceived` guard (Suite 16), `showPersistedPaymentError` IIFE (banner injection, attributes, text, sessionStorage clear), `setRecoveryStartCallback` (register/unregister/replace), `handleOrderPlaced` guest field persistence (!newCartId + newCartId paths), `restoreGuestFields` IIFE, `handleCheckoutUpdated` restore path — 41 tests |

**Important:** The inline copies of module logic inside the spec files are verbatim snapshots. If you change logic in any source file above, update the corresponding inline copy in the spec file too.

---

## References

- [Adyen Web SDK v6](https://docs.adyen.com/online-payments/web-drop-in/)
- Architecture overview: `docs/adyen-integration-handbook.md`
- Failure catalog: [`doc/ORDER_FLOW_FAILURES.md`](../../../doc/ORDER_FLOW_FAILURES.md)
