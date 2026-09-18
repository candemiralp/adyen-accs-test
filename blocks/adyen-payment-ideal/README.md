# Adyen iDEAL Block

Renders the Adyen iDEAL Web Component inside the EDS checkout using the Adyen `Redirect` component with `type: 'ideal'`. Integrates with the shared `adyen-payment` singleton.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Instantiates `window.AdyenWeb.Redirect` with `type: 'ideal'` (the iDEAL issuer bank selection UI).
3. Mounts the component into an `.adyen-ideal-container` div.
4. Calls `setActiveComponent(card)` so the checkout block can validate and submit the payment.

When the shopper selects a bank and confirms, the Adyen SDK redirects the browser to the issuer's authentication page. After the shopper authenticates, the browser is redirected back to the configured `returnUrl`. The `adyen-payment-redirection` block on the return page handles the result.

## Block structure

```
blocks/adyen-payment-ideal/
├── adyen-payment-ideal.js   # Block entry point
└── README.md
```

## Configuration

No block-level `data-*` attributes are read. All configuration (country, amount, return URL) is managed by the shared `adyen-payment` module.

## iDEAL availability

iDEAL is available for shoppers in the Netherlands (`countryCode: 'NL'`). The payment method will not appear in the checkout if the backend does not return `ideal` in the `payments-methods` response for the shopper's country.

## Error handling

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

iDEAL is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 7: Alternative payment method blocks render their containers — verifies the `Redirect` component is mounted with `type: 'ideal'` (container mount check). Note: Suite 4 covers the `/adyen-redirect` page behaviour itself (post-redirect landing), not the iDEAL mounting step.

**`cypress/src/tests/e2eTests/verifyAdyenAltPayments.spec.js`**:
- `.adyen-ideal-container` div present after block decoration
- `window.AdyenWeb.Redirect` instantiated with `type: 'ideal'`
- Error message rendered when `getAdyenCheckout()` rejects

## References

- [Adyen iDEAL Web Component](https://docs.adyen.com/payment-methods/ideal/web-component)
- Shared module: `blocks/adyen-payment/index.js`
- Redirection block: `blocks/adyen-payment-redirection/`
