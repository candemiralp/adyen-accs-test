# Adyen Apple Pay Express Checkout Block

Renders an Apple Pay button on Cart and PDP pages, enabling a full express checkout flow that bypasses the standard checkout form. Shoppers authorize payment in the native Apple Pay sheet with prefilled billing/shipping data, select a shipping method, and are redirected to order confirmation — all without leaving the current page.

## How it works

1. **Browser compatibility check** — Calls `isApplePaySupportedBrowser()` to check if the browser is Safari only (verified via `/Safari/` user agent pattern while excluding Chromium-based browsers). If not Safari, hides the block silently and exits. This early check prevents the block from being visible on unsupported browsers (Chrome, Firefox, Edge, Opera, etc.).
2. Resolves the active cart (`resolveCart()`). On PDP, first calls `addToCart(sku, qty)` using `data-sku` from the block element and the quantity selector value (defaults to 1).
3. Reads the backend URL from `getBackendIntegrationUrl(null)` (localStorage cache). Throws if unavailable.
4. Fetches Adyen public configuration and loads the Adyen Web SDK.
5. Fetches `paymentMethodsResponse` and creates its own `AdyenCheckout` instance (independent of the standard checkout dropin).
6. Locates the `applepay` entry in `paymentMethods`. Throws if not present.
7. Creates `window.AdyenWeb.ApplePay` with shipping and authorization callbacks (see flow below).
8. Calls `isAvailable()` — mounts if the promise resolves (HTTPS + Safari/WebKit required). Hides the block silently if rejected.

## Block structure

```
blocks/adyen-payment-applepay-express/
├── adyen-payment-applepay-express.js   # Block entry point
└── README.md
```

## Checkout flow

Apple Pay supports both guest and logged-in shoppers with slightly different email resolution:

### Standard Checkout Flow

```
Shopper taps Apple Pay button
  └─ Apple Pay sheet opens
       ├─ (PDP only) onShippingContactSelected fires immediately
       │  ├─ addToCart(sku, qty) deferred to first callback (not at initialization)
       │  │  └─ Awaits cart/data event to get updated cart total (3s timeout)
       │  │  └─ Fallback: refreshCartTotals() if event doesn't fire
       │  ├─ estimateShipping(contact) with partial address from sheet
       │  └─ return { newShippingMethods, newTotal }
       │       └─ onShippingMethodSelected fires
       │            ├─ Shopper selected a shipping method in sheet
       │            ├─ selectedShippingMethod captured
       │            └─ Shopper authorizes (Face ID / Touch ID)
       │
       └─ (Cart page) Shopper authorizes directly in sheet
            └─ onAuthorized fires
                 ├─ Email resolution: Commerce account email (logged-in) or sheet email (guest)
                 ├─ setShippingMethod (BEFORE payment) ← CRITICAL
                 ├─ POST /payments → resultCode=Authorised/Pending/Received
                 ├─ resolve() — dismiss sheet
                 ├─ setGuestEmail (guest only)
                 ├─ setBillingAddress (from billingContact, fallback to shippingContact)
                 ├─ setShippingAddress (from shippingContact)
                 ├─ placeOrder()
                 └─ redirect to /order-confirmation
```

### Why `setShippingMethod` is called BEFORE payment

The Adyen payment endpoint validates that the backend cart's `grandTotal` matches the payment amount submitted from the frontend. On PDP express checkout, the shipping method must be applied to the cart BEFORE payment submission to ensure the backend's cart includes shipping in its total validation.

**Without this fix:** Backend rejects with "Payment amount does not match cart total" (cart has only product cost, payment includes shipping).

**With this fix:** Backend cart includes shipping, validation passes, payment succeeds.

## PDP-Specific Behavior

On Product Detail Pages, the product is added to the cart during the **first `onShippingContactSelected` callback**, not at block initialization. This defers the cart mutation until the Apple Pay sheet is actually opened:

- **Add-to-cart timing**: `addToCart(sku, qty)` is called in `onShippingContactSelected`, retrieving the quantity from the page's quantity selector (`.pdp-product__quantity input` or `[name="quantity"]`). Falls back to qty=1 if selector not found.
- **Cart totals refresh**: The block awaits the `cart/data` event (3s timeout) to retrieve the updated cart total after the product is added. If the event doesn't fire, `refreshCartTotals()` is called as a fallback.
- **Shipping estimation**: Only after cart totals are confirmed does `estimateShipping()` run with the updated cart and selected contact address.
- **Email resolution**: Follows the same logic as Cart page — logged-in shoppers use their Commerce account email; guest shoppers use the Apple Pay sheet email.

## Guest Checkout Specifics

- **Email source**: Guest email comes from the Apple Pay sheet (`shippingContact.emailAddress`). It's set on the cart via `setGuestEmail()` after payment authorization.
- **Billing address**: No separate billing contact; uses the shipping address (`shippingContact`).
- **Total validation**: Cart total is validated before payment to ensure amounts match.

## Logged-in Checkout Specifics

- **Email source**: Logged-in customer email from the Commerce account is used instead of the sheet email. This enables backend `findCustomerByEmail` lookup.
- **Billing address**: Retrieved from `billingContact` in the authorization event (if provided by Apple Pay), falls back to `shippingContact`.
- **Total validation**: Same as guest — ensures backend cart total matches payment amount.

## Configuration

| `data-*` attribute | Required | Description |
|---|---|---|
| `data-sku` | PDP only | Product SKU to add to cart before starting the flow. Not set on Cart page. |

All Adyen configuration (client key, environment, country, Apple Pay merchant config) is fetched from the OOPE backend.

## Requirements

- **HTTPS only** — Apple Pay is unavailable on plain HTTP origins.
- **Safari / WebKit** — Apple Pay is only available in Safari on macOS/iOS and in WebKit-based browsers on iOS. The block performs early browser detection (`isApplePaySupported()`) and hides silently on Chrome, Firefox, Edge, and other non-Safari browsers.
- **Domain registration** — The storefront domain must be registered in Adyen Customer Area under Apple Pay domain registration.
- **Backend URL cache warm** — `getBackendIntegrationUrl(null)` must return a URL (cache is populated when a user visits the standard checkout page).

## Error handling

| Scenario | Handling |
|---|---|
| Wallet not available (`isAvailable()` rejects) | `block.style.display = 'none'` — hidden silently |
| `applepay` not in payment methods response | `showExpressError()` in block container |
| Backend URL unavailable (cold cache) | `showExpressError()` in block container |
| `estimateShipping` fails | `reject({ errors: [ApplePayError('addressUnserviceable')] })` — Apple Pay sheet shows native error |
| No shipping methods for address | `reject({ errors: [ApplePayError('shippingContactInvalid')] })` |
| `/payments` returns non-Authorised | `showExpressError()` + `reject()` to dismiss sheet |
| `placeOrder` fails after payment | Log error + `showExpressError()` — do NOT retry |
| PDP: no quantity selector found | Default qty 1 |

## References

- [Adyen Apple Pay Web Component](https://docs.adyen.com/payment-methods/apple-pay/web-component)
- [Apple Pay domain verification](https://docs.adyen.com/payment-methods/apple-pay/web-component#apple-pay-domain-registration)
- Shared helper module: `blocks/adyen-payment-express/`
- Design spec: `.agents/superpowers/specs/2026-04-14-express-checkout-design.md`
