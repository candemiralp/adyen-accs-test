# Adyen Payment Donation Block

Renders the Adyen Giving Campaign component on the order confirmation page, allowing shoppers to make a post-payment donation. Integrates with the shared `adyen-payment` singleton — no standalone configuration attributes or direct Adyen SDK initialization are needed.

## How it works

1. `mountDonationComponent(container, orderData)` is called from `commerce-checkout.js` after a successful order.
2. Reads `donationToken` and `pspReference` from `getPaymentResult()` — which reads the `adyen_payment_result` localStorage key set during the payment flow. Falls back to `sessionStorage` for `donationToken` and `pspReference`.
3. If no `donationToken` or `pspReference` is found, exits silently (non-Adyen payment, or Adyen method that does not support donations).
4. Fetches active donation campaigns from `{backendUrl}donationCampaigns`.
5. If a campaign is found, mounts `window.AdyenWeb.Donation` to the container element.
6. On `onDonate`, sends a POST to `{backendUrl}donations` with the campaign ID, donation amount, payment method, PSP reference, and donation token.
7. Sets component status to `'success'` or `'error'` based on the response; auto-unmounts after 3 seconds on success.

## Block structure

```
blocks/adyen-payment-donation/
├── adyen-payment-donation.js   # Block entry point + mountDonationComponent export
├── adyen-payment-donation.css  # Component styles
└── README.md
```

## donationToken sourcing

The `donationToken` is populated by Adyen in the `/payments` or `/payments-details` response when donations are enabled for the merchant account. It is stored in `adyen_payment_result` (localStorage) by `setPaymentResult()` in `state.js`, which is called from `handlers.js` on payment completion. `commerce-checkout.js` calls `fetchOrderResult()` after order placement, which also populates this value via the `order-result` backend endpoint before the donation block renders.

## Backend endpoints

| Endpoint | Method | Description |
|---|---|---|
| `{backendUrl}donationCampaigns` | POST | Returns the first active donation campaign |
| `{backendUrl}donations` | POST | Submits a donation against the original payment |

### `donationCampaigns` request body

```json
{ "currency": "EUR", "locale": "en-US", "scope": "<store-view-code>" }
```

### `donations` request body

```json
{
  "request": {
    "amount": { "currency": "EUR", "value": 200 },
    "donationCampaignId": "<campaign-id>",
    "paymentMethod": { "type": "scheme" },
    "donationOriginalPspReference": "<psp-reference>",
    "donationToken": "<donation-token>",
    "reference": "<orderNumber>-donation",
    "merchantAccount": "<merchant-account>"
  },
  "scope": "<store-view-code>"
}
```

## Supported payment methods

Adyen Giving supports donations via:
- Credit/debit cards (`scheme`)
- Apple Pay
- Google Pay
- iDEAL
- SEPA Direct Debit

For SEPA, the payment method type is passed as `sepadirectdebit`; all others default to `scheme`.

## Adyen Customer Area setup

1. Assign the `Donation campaigns manager` role to your API user.
2. Create and activate a donation campaign.
3. Enable the "Adyen Giving merchant webhook" and subscribe to `DONATION` events.

## Error handling

| Situation | Behavior |
|---|---|
| No `donationToken` or `pspReference` | Silent exit — donation block not shown |
| `donationCampaigns` returns 404/405 | Silent exit — backend endpoint not implemented |
| `donationCampaigns` returns empty campaign list | Silent exit — no active campaigns configured |
| `donationCampaigns` returns other error | Silent exit — `console.error` logged |
| `donations` request fails | Component status set to `'error'` |
| `getAdyenCheckout()` rejects | `console.error` — donation not shown |

## Testing

Donation is covered by `cypress/src/tests/e2eTests/verifyAdyenDonation.spec.js` (12 suites):

- No `donationToken` → silent exit, donation block not shown
- 404/405 from `donationCampaigns` → silent exit
- Empty campaign list → silent exit
- Campaign request body shape (currency, locale, scope)
- Donation POST happy path — component status set to `'success'`
- Donation POST with `Pending` resultCode treated as success
- Donation POST failure — component status set to `'error'`
- Cancel button hides the donation block
- Round-up campaign: amount rounded to nearest unit
- Missing `backendUrl` → silent exit
- `sessionStorage` fallback for `donationToken` and `pspReference`
- Block decoration creates correct container structure

## References

- [Adyen Giving Web Component](https://docs.adyen.com/online-payments/donations/web-component)
- Shared module: `blocks/adyen-payment/index.js`
- State: `blocks/adyen-payment/state.js` — `getPaymentResult`, `setPaymentResult`
