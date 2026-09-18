# Adyen PayPal Block

Renders the Adyen PayPal Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton — no standalone configuration attributes or direct endpoint calls are needed.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.PayPal` with `showPayButton: true` (PayPal renders its own branded button).
3. Mounts the component into a `#paypal-container` div.
4. Calls `setActiveComponent(paymentMethod)` so the checkout block can orchestrate submission.

The PayPal component handles the shopper redirect/lightbox flow internally via the Adyen SDK. No additional submit or `onAdditionalDetails` wiring is needed in this block.

## Block structure

```
blocks/adyen-payment-paypal/
├── adyen-payment-paypal.js   # Block entry point
└── README.md
```

## Configuration

No block-level `data-*` attributes are read. All configuration (client key, environment, country, amount, return URL, shopper details) is managed by the shared `adyen-payment` module via the OOPE backend integration.

## Error handling

Errors are displayed via `showError(container, message)` from `../adyen-payment/utils.js`.

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

PayPal is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 7: Alternative payment method blocks render their containers — stubs the Commerce REST endpoint (`/rest/*/V1/adyen/payment-methods`) and verifies the PayPal component mounts with `showPayButton: true`.

**`cypress/src/tests/e2eTests/verifyAdyenAltPayments.spec.js`**:
- `#paypal-container` div present after block decoration
- `showPayButton: true` verified
- Error message rendered when `getAdyenCheckout()` rejects

## References

- [Adyen PayPal Web Component](https://docs.adyen.com/payment-methods/paypal/web-component)
- Shared module: `blocks/adyen-payment/index.js`
