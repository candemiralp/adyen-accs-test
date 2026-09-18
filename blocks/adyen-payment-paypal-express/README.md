# Adyen PayPal Express Checkout Block

Renders a PayPal button on Cart and PDP pages, enabling a full express checkout flow that bypasses the standard checkout form. Shoppers log in to their PayPal account in a popup, confirm their details, and are redirected to order confirmation without a separate review page.

## How it works

1. Resolves the active cart (`resolveCart()`). On PDP, first calls `addToCart(sku, qty)` using `data-sku` from the block element and the quantity selector value (defaults to 1).
2. Reads the backend URL from `getBackendIntegrationUrl(null)` (localStorage cache). Throws if unavailable.
3. Fetches Adyen public configuration and loads the Adyen Web SDK.
4. Fetches `paymentMethodsResponse` and creates its own `AdyenCheckout` instance (independent of the standard checkout dropin).
5. Creates `window.AdyenWeb.PayPal` with `showPayButton: true` and `userAction: 'pay'` (no PayPal review page).
6. Mounts directly — no `isAvailable()` check needed for PayPal.

## Block structure

```
blocks/adyen-payment-paypal-express/
├── adyen-payment-paypal-express.js   # Block entry point
└── README.md
```

## Checkout flow

PayPal supports two distinct flows:

### Standard flow (userAction: 'pay')
Shipping address comes from `onShopperDetails` (after popup login), not from a real-time shipping callback. Billing address is not provided by PayPal — shipping address is used as billing.

```
Shopper clicks PayPal button
  └─ PayPal popup opens (Adyen SDK handles redirect/lightbox)
       └─ Shopper logs in to PayPal
            └─ onShopperDetails fires (shipping address + shopper name available)
                 ├─ estimateShipping() → validate address + get methods
                 └─ actions.resolve(rawData) or actions.reject()
                      └─ Shopper confirms in popup (userAction: 'pay' — no review page)
                           └─ onSubmit fires with payment state
                                ├─ setShippingMethod (BEFORE payment) ← CRITICAL
                                ├─ POST /payments → resultCode=Authorised
                                ├─ actions.resolve() — dismiss popup
                                ├─ setGuestEmail (guest only)
                                ├─ setBillingAddress (= shippingAddress — PayPal provides no separate billing)
                                ├─ setShippingAddress
                                ├─ placeOrder()
                                └─ redirect to /order-confirmation
```

### Billing Agreement flow (BA- / vault / intent=tokenize)
For vault/billing agreement flows where PayPal's SDK doesn't provide shipping details in `onShopperDetails`, address is resolved from PayPal Orders API v2 via the backend `paypal-payer-info` action.

```
Shopper clicks PayPal button
  └─ PayPal popup opens (intent=tokenize for vault)
       └─ Shopper logs in to PayPal (no shipping selection in popup)
            └─ onApprove fires (details are empty in BA- flow)
                 ├─ POST /payments/details with billingToken (Adyen async BA step)
                 ├─ Parallel: fetch paypal-payer-info from backend
                 │   ├─ Backend calls PayPal Orders API v2 to get full payer details
                 │   ├─ Extracts shipping address + name from OrderUnit.shipping
                 │   └─ Returns { email, shipping: { name: { full_name }, address: {...} } }
                 ├─ onApprove BA- converts payer address to Commerce shape
                 ├─ estimateShipping() → validate address + get methods
                 ├─ setShippingMethod (BEFORE payment) ← CRITICAL
                 ├─ POST /payments → resultCode=Authorised
                 ├─ setGuestEmail (guest only)
                 ├─ setBillingAddress (= shippingAddress from payer-info)
                 ├─ setShippingAddress
                 ├─ placeOrder()
                 └─ redirect to /order-confirmation
```

### Why `setShippingMethod` is called BEFORE payment

The Adyen payment endpoint validates that the backend cart's `grandTotal` matches the payment amount submitted from the frontend. On PDP express checkout, the shipping method must be applied to the cart BEFORE payment submission to ensure the backend's cart includes shipping in its total validation.

**Without this fix:** Backend rejects with "Payment amount does not match cart total" (cart has only product cost, payment includes shipping).

**With this fix:** Backend cart includes shipping, validation passes, payment succeeds.

## Configuration

| `data-*` attribute | Required | Description |
|---|---|---|
| `data-sku` | PDP only | Product SKU to add to cart before starting the flow. Not set on Cart page. |

All Adyen configuration (client key, environment, country) is fetched from the OOPE backend.

## PayPal-specific behaviour

- **`userAction: 'pay'`** (Standard flow) — Shopper sees no PayPal review page; payment is confirmed immediately.
- **Billing address** — PayPal does not provide a separate billing address. The shipping address is used as the billing address.
- **Shipping method** — No real-time shipping option selection inside PayPal; the first available shipping method for the address is selected automatically.
- **Billing Agreement flow** — For vault/BA- flows (intent=tokenize), the block calls backend `paypal-payer-info` action to resolve payer address from PayPal Orders API v2 when `onShopperDetails` doesn't fire. The backend returns `{ email, shipping: { name: { full_name }, address: { address_line_1, address_line_2, admin_area_1, admin_area_2, postal_code, country_code } } }`, which the frontend converts to Commerce address shape.

## Guest vs Logged-in Specifics

### Guest Checkout (Standard flow)
- **Address source**: Retrieved from PayPal's `onShopperDetails` callback after shopper logs into PayPal and confirms their default shipping address.
- **Email source**: Retrieved from PayPal in `onShopperDetails` (for Standard flow) or via backend `paypal-payer-info` action (for BA- flow).
- **BA- flow special handling**: When `onShopperDetails` doesn't fire (intent=tokenize vault flow), the frontend fetches payer email and address from backend `paypal-payer-info` action, which queries PayPal Orders API v2 with OAuth credentials.

### Logged-in Checkout
- **Address source**: PayPal payer's selected address (NOT the Commerce account's saved address). This prevents mismatches when the payer's PayPal address is in a different country than the customer's saved address.
- **Email source**: Same as guest — from PayPal or backend `paypal-payer-info` action.
- **No account address fallback**: The BA- flow no longer falls back to the Commerce account's default address when PayPal doesn't provide data.billingAddress. This avoids region_id validation errors when the saved address is in a different country.

## Error handling

| Scenario | Handling |
|---|---|
| Backend URL unavailable (cold cache) | `showExpressError()` in block container |
| `estimateShipping` fails in `onShopperDetails` | `actions.reject()` — PayPal popup shows error |
| No shipping methods for address | `actions.reject()` — PayPal popup shows error |
| `/payments` returns non-Authorised | `showExpressError()` + `actions.reject(resultCode)` |
| `placeOrder` fails after payment | Log error + `showExpressError()` — do NOT retry |
| PDP: no quantity selector found | Default qty 1 |

## References

- [Adyen PayPal Web Component](https://docs.adyen.com/payment-methods/paypal/web-component)
- Shared helper module: `blocks/adyen-payment-express/`
- Design spec: `.agents/superpowers/specs/2026-04-14-express-checkout-design.md`
