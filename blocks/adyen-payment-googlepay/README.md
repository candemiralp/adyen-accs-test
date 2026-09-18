# Adyen Google Pay Block

Renders the Adyen Google Pay Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton. Because Google Pay authorizes payments directly on the client, this block triggers the checkout form's place-order action immediately after the shopper confirms in the Google Pay sheet.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.GooglePay` with `showPayButton: true` (Google Pay renders its own branded button).
3. In the `onSubmit` callback, calls `triggerPlaceOrder()` to programmatically click the checkout's place-order button, then immediately resolves the action with `{ resultCode: 'Backend' }` to signal that the backend handles the result.
4. Calls `setActiveComponent(paymentMethod)` so the checkout block can orchestrate the flow.

## Block structure

```
blocks/adyen-payment-googlepay/
├── adyen-payment-googlepay.js   # Block entry point
└── README.md
```

## Submission flow

Google Pay differs from other payment methods in that authorization happens inside the Google Pay sheet before `onSubmit` fires. The flow is:

```
Shopper clicks Google Pay button
  └─ Google Pay sheet opens (handled by Adyen SDK)
       └─ Shopper authenticates in sheet
            └─ onSubmit fires with authorized payment data
                 └─ triggerPlaceOrder() → place-order button click
                      └─ Commerce checkout submits order with Google Pay token
                           └─ Backend processes payment
```

The `checkout__place-order` button is hidden by the shared module for `adyen_googlepay` (the Google Pay button acts as the submit trigger).

## Configuration

No block-level `data-*` attributes are read. All configuration is managed by the shared `adyen-payment` module.

## Error handling

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Google Pay has a dedicated spec: `cypress/src/tests/e2eTests/verifyAdyenGooglePay.spec.js` (7 suites).

| Suite | What it covers |
|---|---|
| Google Pay – container structure | Block mounts `#adyen-googlepay-container` with `showPayButton: true` |
| Google Pay – no error on successful initialization | No error UI rendered on clean init |
| Google Pay – error state when Adyen config request fails | Error message shown when `public-configuration` request fails |
| Google Pay – error state when payment-methods request fails | Error message shown when `payments-methods` request fails |
| Google Pay – onSubmit resolves with Backend result code | `onSubmit` calls `triggerPlaceOrder()` and resolves `{ resultCode: 'Backend' }` |
| Google Pay – shared module hides the place-order button | `checkout__place-order--hidden` applied when `adyen_googlepay` is active |
| Google Pay – block present on checkout page | Block element exists in the DOM on the checkout page |

## References

- [Adyen Google Pay Web Component](https://docs.adyen.com/payment-methods/google-pay/web-component)
- Shared module: `blocks/adyen-payment/index.js`
