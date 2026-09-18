# Adyen Payment Additional Action Block

Handles post-order additional actions required by certain payment methods. The block listens for the `order/data` event and, if the order's payment data contains an `additional_action`, renders the appropriate Adyen SDK action component.

## How it works

1. On mount, the block appends an `.adyen-additional-action-container` and subscribes to the `order/data` event bus event (with `{ eager: true }` to process any event already in the bus).
2. When `order/data` fires, the block extracts `additional_action` from `payments[].additional_informations`.
3. The action is parsed from JSON if stored as a string.
4. `checkout.createFromAction(action).mount(container)` delegates rendering to the Adyen SDK.
5. For `redirect` action types, `setPendingOrderData` is called first so the `adyen-payment-redirection` block can recover order state after the browser returns from the redirect URL.

## Supported action types

| Type | Description | Example payment methods |
|---|---|---|
| `voucher` | PDF/printable voucher | BACS Direct Debit, Boleto, OXXO, Doku |
| `qrCode` | QR code for scanning | WeChat Pay, Pix, Swish, Bancontact mobile |
| `await` | Pending action requiring shopper action outside the app | PayTo, bank transfers |
| `redirect` | Browser redirect to payment provider | 3DS, iDEAL issuer redirect, etc. |

## Block structure

```
blocks/adyen-payment-additional-action/
├── adyen-payment-additional-action.js   # Block entry point
└── README.md
```

## Exported API

The block exports `renderAction` as a named export for use by other modules:

```javascript
import { renderAction } from '../adyen-payment-additional-action/adyen-payment-additional-action.js';

await renderAction(containerElement, actionObject, orderData);
```

| Parameter | Type | Description |
|---|---|---|
| `container` | `HTMLElement` | Element to render the action into |
| `action` | `Object` | Adyen action object (must have a `type` field) |
| `orderData` | `Object` | Order data, used to persist state for redirect flows |

## Data flow

```
order/data event
  └─ getAdditionalAction(orderData)
       └─ orderData.payments[].additional_informations.additional_action
            └─ renderAction(container, action, orderData)
                 └─ checkout.createFromAction(action).mount(container)
```

## Placement

This block should be placed on the order confirmation page alongside `adyen-payment-redirection`. The confirmation page receives the `order/data` event from the commerce checkout drop-in after an order is placed.

## Testing

Additional Action handling is covered by two spec files:

**`cypress/src/tests/e2eTests/verifyAdyenCheckout.spec.js`**:
- Suite 13: Pending order cleared on `cart/reset` — verifies that `setPendingOrderData` state is cleared when the cart resets, covering the redirect action path.
- Suite 14: `fetchOrderResult` endpoint contract — verifies the backend response shape that triggers `additional_action` delivery to this block.

**`cypress/src/tests/e2eTests/verifyAdyenAdditionalAction.spec.js`** (13 suites):
- Container element created on block decoration
- No-op when `payments` array is absent or empty
- No-op when `additional_action` field is missing
- JSON string parsing — action stored as a serialised string is parsed correctly
- Object pass-through — action stored as a plain object is used directly
- `voucher` action type: `createFromAction` receives a voucher action object
- `qrCode` action type: `createFromAction` receives a qrCode action object
- `await` action type: `createFromAction` receives an await action object
- `redirect` action type: `setPendingOrderData` is called before `createFromAction`
- Malformed JSON string is handled safely without throwing
- Multiple `order/data` events clear the container before each render
- Action object with missing `type` field is skipped

## References

- [Adyen additional actions](https://docs.adyen.com/online-payments/build-your-integration/additional-use-cases/action-handling/)
- Shared module: `blocks/adyen-payment/index.js`
- Redirection block: `blocks/adyen-payment-redirection/`
