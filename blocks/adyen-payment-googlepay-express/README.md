# Adyen Google Pay Express Checkout Block

Renders a Google Pay button on Cart and PDP pages, enabling a full express checkout flow that bypasses the standard checkout form. Shoppers authorize payment in the Google Pay sheet with prefilled billing/shipping data, select a shipping method, and are redirected to order confirmation — all without leaving the current page.

## How it works

1. Resolves the active cart (`resolveCart()`). On PDP, first calls `addToCart(sku, qty)` using `data-sku` from the block element and the quantity selector value (defaults to 1).
2. Reads the backend URL from `getBackendIntegrationUrl(null)` (localStorage cache). Throws if unavailable.
3. Fetches Adyen public configuration and loads the Adyen Web SDK.
4. Fetches `paymentMethodsResponse` and creates its own `AdyenCheckout` instance (independent of the standard checkout dropin).
5. Creates `window.AdyenWeb.GooglePay` with `callbackIntents: ['SHIPPING_ADDRESS', 'SHIPPING_OPTION']` and authorization callbacks (see flow below).
6. Calls `isAvailable()` — mounts if the promise resolves. Hides the block silently if rejected.

## Block structure

```
blocks/adyen-payment-googlepay-express/
├── adyen-payment-googlepay-express.js   # Block entry point
└── README.md
```

## Checkout flow

Google Pay supports both guest and logged-in shoppers with distinct checkout paths. The key difference is **when** the shipping address is applied to the cart:

### Guest Checkout Flow (INITIALIZE callback applies address immediately)

```
Shopper taps Google Pay button
  └─ Google Pay sheet opens
       └─ onPaymentDataChanged fires (callbackTrigger: INITIALIZE)
            ├─ hideGPayClickLoader() — dismiss "Tap to pay" loader
            ├─ Guest address extracted from sheet (partial initial data)
            ├─ setShipping() called with guest address on cart ← CRITICAL for guests
            │  └─ This ensures Commerce has the address upfront for totals calculation
            ├─ estimateShipping() → Commerce shipping methods
            ├─ Return placeholder shipping if no methods available (guest fallback)
            └─ return { newShippingOptionParameters, newTransactionInfo }
                 └─ onPaymentDataChanged fires (callbackTrigger: SHIPPING_ADDRESS if shopper edits)
                      ├─ setShipping() called again with updated address
                      ├─ estimateShipping() re-run with new address
                      └─ return { newShippingOptionParameters, newTransactionInfo }
                           └─ onPaymentDataChanged fires (callbackTrigger: SHIPPING_OPTION)
                                ├─ Shopper selected a shipping method
                                ├─ Display total updated to include selected method cost
                                └─ return { newTransactionInfo }
                                     └─ Shopper authorizes
                                          └─ onAuthorized fires
                                               ├─ setShippingMethod (BEFORE payment) ← CRITICAL
                                               ├─ POST /payments → resultCode=Authorised
                                               ├─ resolve() — dismiss sheet
                                               ├─ setGuestEmail
                                               ├─ setBillingAddress (= shippingAddress)
                                               ├─ setShippingAddress
                                               ├─ placeOrder()
                                               └─ redirect to /order-confirmation
```

### Logged-in Checkout Flow (address resolved after authorization)

```
Shopper taps Google Pay button
  └─ Google Pay sheet opens
       └─ onPaymentDataChanged fires (callbackTrigger: INITIALIZE)
            ├─ hideGPayClickLoader()
            ├─ Partial address from sheet (no setShipping call for logged-in)
            │  └─ Logged-in shoppers rely on their Commerce account default address for shipping estimation
            ├─ estimateShipping() with partial address
            │  └─ Shipping methods returned (Commerce uses account default address)
            └─ return { newShippingOptionParameters, newTransactionInfo }
                 └─ onPaymentDataChanged fires (callbackTrigger: SHIPPING_OPTION)
                      ├─ Shopper selected a shipping method
                      ├─ Display total updated with method cost (same as guest)
                      └─ return { newTransactionInfo }
                           └─ Shopper authorizes
                                └─ onAuthorized fires
                                     ├─ setShippingMethod (BEFORE payment) ← CRITICAL
                                     ├─ POST /payments → resultCode=Authorised
                                     ├─ resolve() — dismiss sheet
                                     ├─ setBillingAddress (from paymentMethodData.info, fallback to sheet)
                                     ├─ setShippingAddress (from sheet data)
                                     ├─ placeOrder()
                                     └─ redirect to /order-confirmation
```

### Why `setShippingMethod` is called BEFORE payment

The Adyen payment endpoint validates that the backend cart's `grandTotal` matches the payment amount submitted from the frontend. On PDP express checkout, the shipping method must be applied to the cart BEFORE payment submission to ensure the backend's cart includes shipping in its total validation.

**Without this fix:** Backend rejects with "Payment amount does not match cart total" (cart has only product cost, payment includes shipping).

**With this fix:** Backend cart includes shipping, validation passes, payment succeeds.

### Cart total synchronization (logged-in checkout)

After `setShippingMethod()` completes, the cart is refetched to get the updated grand total (which now includes the applied shipping method). This fresh total is used to calculate the final payment amount submitted to the backend, ensuring frontend and backend totals match exactly.

## Guest Checkout Specifics

Guest checkouts have special handling to ensure Adobe Commerce has a complete address before calculating totals:

- **Address applied early**: During `onPaymentDataChanged` INITIALIZE callback, the guest address is immediately set on the cart via `setShipping()`. This ensures Commerce includes the address in its shipping cost calculation.
- **Placeholder shipping**: If no shipping methods are available for the guest's address, a placeholder shipping option is created and returned to the Google Pay sheet. This prevents "No shipping methods" errors and allows checkout to proceed.
- **Email source**: Guest email comes from the Google Pay sheet (`shippingContact.emailAddress`). It's set on the cart via `setGuestEmail()` during order finalization.
- **Billing address fallback**: For guests, billing address equals shipping address (Google Pay doesn't provide separate billing data).
- **Total calculation**: Shipping cost is included in the modal total from INITIALIZE onwards, as the address was already applied to the cart.

## Logged-in Checkout Specifics

Logged-in shoppers follow a simpler path:

- **Address resolution**: The shopper's account default shipping address is used for the initial shipping estimate. The sheet address is only collected for update scenarios (SHIPPING_ADDRESS callback).
- **Email source**: Logged-in customer email from the Commerce account is used instead of the sheet email. This enables backend `findCustomerByEmail` lookup to succeed.
- **Billing address**: Retrieved from `paymentMethodData.info` in the authorization event (if available), falls back to the sheet's shipping address.
- **No placeholder shipping**: All available shipping methods are returned. If none available for the address, the sheet shows a native error.
- **Total calculation**: Same as guest — shipping included in modal total after method selection.

## Configuration

| `data-*` attribute | Required | Description |
|---|---|---|
| `data-sku` | PDP only | Product SKU to add to cart before starting the flow. Not set on Cart page. |

All Adyen configuration (client key, environment, country) is fetched from the OOPE backend.

## Error handling

| Scenario | Handling |
|---|---|
| Wallet not available (`isAvailable()` rejects) | `block.style.display = 'none'` — hidden silently |
| Backend URL unavailable (cold cache) | `showExpressError()` in block container |
| `estimateShipping` fails | Returns `{ error: { reason: 'OTHER_ERROR' } }` — Google Pay sheet shows native error |
| No shipping methods for address | Returns `{ error: { reason: 'SHIPPING_ADDRESS_UNSERVICEABLE' } }` |
| `/payments` returns non-Authorised | `showExpressError()` in block container |
| `placeOrder` fails after payment | Log error + `showExpressError()` — do NOT retry |
| PDP: no quantity selector found | Default qty 1 |

## References

- [Adyen Google Pay Web Component](https://docs.adyen.com/payment-methods/google-pay/web-component)
- Shared helper module: `blocks/adyen-payment-express/`
- Design spec: `.agents/superpowers/specs/2026-04-14-express-checkout-design.md`
