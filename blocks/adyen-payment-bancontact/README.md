# Adyen Bancontact Block

Renders the Adyen Bancontact Web Component inside the EDS checkout. Integrates with the shared `adyen-payment` singleton and manages the component lifecycle across checkout updates.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Creates a `readyPromise` that resolves when the component fires `onReady`.
3. Instantiates `window.AdyenWeb.Bancontact` and mounts it.
4. Calls `setActiveComponent(paymentMethod)`.
5. Registers a `checkout/updated` listener (once per page) to handle payment method changes:
   - If the shopper switches away from `adyen_bcmc`, awaits `readyPromise` then calls `component.remove()` and deregisters the listener.
   - If the shopper stays on `adyen_bcmc`, calls `component.update()`.

## Block structure

```
blocks/adyen-payment-bancontact/
├── adyen-payment-bancontact.js   # Block entry point
└── README.md
```

## Checkout update lifecycle

Unlike simpler blocks, Bancontact explicitly manages component removal when another payment method is selected. This prevents stale Bancontact state from interfering with other payment flows.

```
checkout/updated event
  ├─ selectedPaymentMethod !== 'adyen_bcmc'
  │    └─ await readyPromise → remove component → deregister listener
  └─ selectedPaymentMethod === 'adyen_bcmc'
       └─ component.update()
```

## Configuration

No block-level `data-*` attributes are read. All configuration is managed by the shared `adyen-payment` module.

## Bancontact availability

Bancontact is available for shoppers in Belgium (`countryCode: 'BE'`). The payment method will not appear in the checkout if the backend does not return `bcmc` in the `payments-methods` response for the shopper's country.

## Error handling

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` | `<error.message>` or `An error occurred.` |

## Testing

Bancontact has a dedicated spec: `cypress/src/tests/e2eTests/verifyAdyenBancontact.spec.js` (6 suites).

| Suite | What it covers |
|---|---|
| Bancontact – container structure | Block mounts `#adyen-bancontact-container` |
| Bancontact – no error on successful initialization | No error UI rendered on clean init |
| Bancontact – error state when Adyen config request fails | Error message shown when `public-configuration` request fails |
| Bancontact – error state when payment-methods request fails | Error message shown when `payments-methods` request fails |
| Bancontact – checkout/updated unmounts component when another method is selected | `component.remove()` called when `selectedPaymentMethod !== 'adyen_bcmc'` |
| Bancontact – block present on checkout page | Block element exists in the DOM on the checkout page |

## References

- [Adyen Bancontact Web Component](https://docs.adyen.com/payment-methods/bancontact/web-component)
- Shared module: `blocks/adyen-payment/index.js`
