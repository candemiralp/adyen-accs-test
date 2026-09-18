# Adyen Affirm Block

Renders the Adyen Affirm Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton. The component is configured to hide personal details, billing address, and delivery address fields — these are owned by the EDS checkout form.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.Affirm` with:
   - All personal detail, billing address, and delivery address sub-fields hidden (`visibility: 'hidden'`).
   - `showPayButton: false` — the checkout block owns the place-order button.
3. Mounts the component into the block container.
4. Calls `setActiveComponent(paymentMethod)` so the checkout block can validate and submit the payment.

## Block structure

```
blocks/adyen-payment-affirm/
├── adyen-payment-affirm.js   # Block entry point
└── README.md
```

## Component configuration

| Option | Value | Reason |
|---|---|---|
| `visibility.personalDetails` | `hidden` | Collected by the EDS checkout form |
| `visibility.billingAddress` | `hidden` | Collected by the EDS checkout form |
| `visibility.deliveryAddress` | `hidden` | Collected by the EDS checkout form |
| `showPayButton` | `false` | Checkout block owns the place-order button |

## Configuration

No block-level `data-*` attributes are read. All payment configuration (country, amount, shopper details) is managed by the shared `adyen-payment` module and passed to the OOPE backend.

## Affirm availability

Affirm is available for shoppers in the United States (`countryCode: 'US'`). The payment method will not appear in the checkout if the backend does not return `affirm` in the `payments-methods` response.

## Error handling

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Affirm is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 7: Alternative payment method blocks render their containers — stubs the Commerce REST endpoint (`/rest/*/V1/adyen/payment-methods`) and verifies the Affirm component mounts with `showPayButton: false` and all personal/address sub-fields set to `hidden`.

**`cypress/src/tests/e2eTests/verifyAdyenAltPayments.spec.js`**:
- Block container rendered with `showPayButton: false`
- All `visibility` sub-fields (`personalDetails`, `billingAddress`, `deliveryAddress`) set to `'hidden'`
- Error message rendered when `getAdyenCheckout()` rejects

## References

- [Adyen Affirm Web Component](https://docs.adyen.com/payment-methods/affirm/web-component)
- Shared module: `blocks/adyen-payment/index.js`
