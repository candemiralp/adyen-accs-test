# Adyen Apple Pay Block

Renders the Adyen Apple Pay Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton and is only mounted when Apple Pay is available on the current device and browser.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton and `getAdyenConfiguration()` from `../adyen-payment/index.js`.
2. Looks up the `applepay` entry in `configuration.paymentMethodsResponse.paymentMethods`. If not found, throws — Apple Pay is not configured for this merchant or country.
3. Instantiates `window.AdyenWeb.ApplePay` with the merchant configuration from the payment methods response.
4. Calls `paymentMethod.isAvailable()` to check device and browser support (requires HTTPS and a Safari/WebKit context). Only mounts if the promise resolves.
5. Calls `setActiveComponent(paymentMethod)` so the checkout block can orchestrate submission.

## Block structure

```
blocks/adyen-payment-applepay/
├── adyen-payment-applepay.js   # Block entry point
└── README.md
```

## Requirements

- **HTTPS only**: Apple Pay is unavailable on plain HTTP origins.
- **Safari / WebKit**: Apple Pay is only available in Safari on macOS/iOS and in other browsers on iOS via WebKit.
- **Domain registration**: The storefront domain must be registered in Adyen Customer Area under Apple Pay domain registration.
- **Merchant configuration**: The `applepay` payment method must be returned by the backend `payments-methods` endpoint for the shopper's country.

## Configuration

No block-level `data-*` attributes are read. The Apple Pay merchant configuration (merchant identifier, merchant name, etc.) is returned by the OOPE backend inside `paymentMethods[].configuration` and passed directly to the SDK.

## Error handling

| Situation | Message |
|---|---|
| `applepay` not in payment methods response | Block throws; checkout block hides this payment option |
| `isAvailable()` rejects (wrong browser/device) | `Failed to load payment form. Please refresh the page.` |
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Apple Pay has a dedicated spec: `cypress/src/tests/e2eTests/verifyAdyenApplePay.spec.js` (7 suites).

| Suite | What it covers |
|---|---|
| Apple Pay – container structure | Block mounts `#adyen-applepay-container` |
| Apple Pay – no error on successful initialization | No error UI rendered on clean init |
| Apple Pay – error when Apple Pay not in paymentMethodsResponse | Block throws; no component mounted, no error surfaced to shopper |
| Apple Pay – error state when Adyen config request fails | Error message shown when `public-configuration` request fails |
| Apple Pay – error state when payment-methods request fails | Error message shown when `payments-methods` request fails |
| Apple Pay – shared module hides the place-order button | `checkout__place-order--hidden` applied when `adyen_applepay` is active |
| Apple Pay – block present on checkout page | Block element exists in the DOM on the checkout page |

## References

- [Adyen Apple Pay Web Component](https://docs.adyen.com/payment-methods/apple-pay/web-component)
- [Apple Pay domain verification](https://docs.adyen.com/payment-methods/apple-pay/web-component#apple-pay-domain-registration)
- Shared module: `blocks/adyen-payment/index.js`
