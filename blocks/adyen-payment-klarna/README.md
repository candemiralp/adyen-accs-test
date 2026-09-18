# Adyen Payment Klarna Block

Renders the Adyen Klarna Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton — no direct endpoint calls or standalone configuration attributes are needed.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.Klarna` with `showPayButton: false` (the checkout block owns the place-order button).
3. Mounts the component, passing the Klarna type and widget mode from optional block dataset attributes.
4. Calls `setActiveComponent(klarna)` so the checkout block can validate and submit the payment.

## Block structure

```
blocks/adyen-payment-klarna/
├── adyen-payment-klarna.js   # Block entry point
└── README.md
```

## Authoring attributes

Two optional `data-*` attributes can be set on the block element:

| Attribute | Default | Description |
|---|---|---|
| `data-type` | `klarna_paynow` | Klarna product type: `klarna`, `klarna_paynow`, or `klarna_account` |
| `data-use-klarna-widget` | `true` | Whether to render the Klarna native widget (`true`) or fall back to redirect (`false`) |

All other payment configuration (client key, environment, country, amount, shopper details) is managed by the shared `adyen-payment` module.

## Configuration

No standalone API base URL, merchant account, or shopper data attributes are required. The shared module fetches payment methods and builds the `AdyenCheckout` configuration automatically based on checkout and cart events.

## Error handling

Errors are displayed via `showError(container, message)` from `../adyen-payment/utils.js`.

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load Klarna. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Klarna is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 7: Alternative payment method blocks render their containers — stubs the Commerce REST endpoint (`/rest/*/V1/adyen/payment-methods`) and verifies the Klarna component mounts with `showPayButton: false` and the correct `data-type` attribute value.

**`cypress/src/tests/e2eTests/verifyAdyenAltPayments.spec.js`**:
- Container structure and CSS class (`adyen-klarna-container--<type>` reflects `data-type`)
- `showPayButton: false` verified
- Error message rendered when `getAdyenCheckout()` rejects

## References

- [Adyen Klarna Web Component](https://docs.adyen.com/payment-methods/klarna/web-component)
- Shared module: `blocks/adyen-payment/index.js`
