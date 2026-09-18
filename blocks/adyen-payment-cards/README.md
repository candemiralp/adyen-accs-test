# Adyen Payment Cards Block

Renders the Adyen Card Web Component inside the EDS checkout. Supports new card entry and stored cards (for logged-in shoppers). Integrates with the shared `adyen-payment` singleton — no standalone network calls are made.

## How it works

1. Awaits the shared `getAdyenCheckout()` singleton from `../adyen-payment/index.js`.
2. Reads stored payment methods from `checkout.paymentMethodsResponse.storedPaymentMethods`.
3. If stored cards exist, renders a `Picker` dropdown so the shopper can choose between saved cards and entering a new card.
4. Mounts `window.AdyenWeb.Card` for the selected option.
5. Registers a `beforeCheckoutUpdate` callback so checkout data updates wait until the card's secure fields are fully configured (prevents race conditions during 3DS flows).
6. Exposes an `activeComponent` proxy to `setActiveComponent` so the checkout block can call `isValid`, `data`, and `showValidation()` at place-order time.

## Block structure

```
blocks/adyen-payment-cards/
├── adyen-payment-cards.js   # Block entry point
└── README.md
```

## DOM structure

The block injects:

```html
<div class="adyen-stored-cards-selector"><!-- hidden unless stored cards present --></div>
<div id="adyen-card-container"><!-- Adyen Card component mounts here --></div>
```

## Stored cards

When a logged-in shopper has saved cards, a `Picker` dropdown appears above the card form. Options:

| Value | Label |
|---|---|
| `new` | Use new card |
| `<storedId>` | `<brand> •••• <lastFour>` |

Switching the picker unmounts the current component and mounts a new one without re-initialising the full checkout.

## Configuration

No block-level `data-*` attributes are read. All configuration (client key, environment, country, payment methods) is managed by the shared `adyen-payment` module.

Card component options passed at mount time:

| Option | Value | Description |
|---|---|---|
| `hasHolderName` | `true` | Shows cardholder name field |
| `holderNameRequired` | `true` | Validates cardholder name |
| `enableStoreDetails` | `isCustomerLoggedIn()` | Shows "Save card" checkbox for logged-in shoppers |
| `showPayButton` | `false` | Pay button is owned by the checkout block |

## Checkout update race condition

The card block registers a `registerBeforeCheckoutUpdate` callback that waits for `cardReadyPromise` before allowing the checkout instance to be updated. This prevents the checkout from sending a payment request before the card's secure fields (iframe) are configured.

The callback is automatically unregistered when:
- The shopper switches to a different payment method (`checkout/updated` event).
- Initialization fails.

## Place Order (manualSubmit) flow

When the Commerce "Place Order" button is clicked, `manualSubmit` in `handlers.js` is called. It:

1. Validates all visible checkout forms (email, shipping address, billing address, shipping method).
2. Calls `setPaymentMethod` on the Commerce checkout API.
3. Resolves the Adyen submit with `actions.resolve({ resultCode: 'Backend' })` — this tells the Adyen SDK to hand off to the backend (OOPE webhook) rather than submitting directly.

If validation fails at any step, `actions.reject(message)` is called and the order is not placed.

## Error handling

Errors are displayed via `showError(block, message)` from `../adyen-payment/utils.js`. Common error states:

| Situation | Message |
|---|---|
| `getAdyenCheckout()` rejects | `Failed to load payment form. Please refresh the page.` |
| `onPaymentFailed` callback | `Payment failed. Please try again.` |
| Component `onError` after configuration | `<error.message>` or `An error occurred.` |
| Stored card mount failure | `Failed to load stored card. Please try again.` |

## Testing

Adyen Cards is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 1: Adyen initialization with Cards payment method
- Suite 2: Card component rendering and secure field loading
- Suite 6: Guest checkout end-to-end — includes the `manualSubmit` validation flow (form validation rejection)

**`cypress/src/tests/e2eTests/verifyAdyenPaymentCards.spec.js`** (12 suites):
- Container structure and DOM ids
- Guest shopper: no picker rendered, single card form
- Logged-in shopper: `Picker` dropdown with all stored cards + "Use new card"
- Picker selection switches between stored card and new card components
- `checkout/updated` event unmounts the component and unregisters the `beforeCheckoutUpdate` callback
- Debounce: rapid picker changes only mount once
- Error state when `getAdyenCheckout()` rejects
- Loading state cleared after successful mount

## References

- [Adyen Card Web Component](https://docs.adyen.com/payment-methods/cards/web-component)
- [Adyen stored payment methods](https://docs.adyen.com/payment-methods/tokenization/create-and-use-tokens)
- Shared module: `blocks/adyen-payment/index.js`
