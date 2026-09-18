# Adyen BACS Direct Debit Block

Renders the Adyen BACS Direct Debit Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.BacsDirectDebit` with `showPayButton: false` (the checkout block owns the place-order button).
3. Mounts the component into the block container.
4. Calls `setActiveComponent(paymentMethod)` so the checkout block can validate and submit the payment.

## Block structure

```
blocks/adyen-payment-bacs/
├── adyen-payment-bacs.js   # Block entry point
└── README.md
```

## Shopper experience

The BACS Direct Debit component collects the shopper's bank account number and sort code. After the shopper confirms and the order is placed, Adyen sends a confirmation email and processes the debit according to the BACS Direct Debit scheme timelines (typically 3 working days). A voucher action may be returned in the order's `additional_informations` — the `adyen-payment-additional-action` block on the confirmation page will render it automatically.

## Configuration

No block-level `data-*` attributes are read. All configuration is managed by the shared `adyen-payment` module.

## BACS availability

BACS Direct Debit is available for shoppers in the United Kingdom (`countryCode: 'GB'`). The payment method will not appear in the checkout if the backend does not return `directdebit_GB` in the `payments-methods` response.

## Error handling

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Adyen sandbox test values for BACS:
- Sort code: `23-14-70`
- Account number: `55779911`

BACS is also covered by `cypress/src/tests/e2eTests/verifyAdyenAltPayments.spec.js`:
- Block container rendered with `showPayButton: false`
- `window.AdyenWeb.BacsDirectDebit` instantiated correctly
- Error message rendered when `getAdyenCheckout()` rejects

## References

- [Adyen BACS Direct Debit Web Component](https://docs.adyen.com/payment-methods/bacs-direct-debit/web-component)
- Shared module: `blocks/adyen-payment/index.js`
- Additional action block: `blocks/adyen-payment-additional-action/`
