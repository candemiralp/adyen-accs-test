# Commerce Checkout Block

## Overview

The Commerce Checkout block provides a comprehensive **one-page checkout** experience with dynamic form handling, payment processing, address management, and order placement. It integrates multiple dropin containers for authentication, cart management, payment services, and order processing with dynamic UI state management and validation.

## Integration

<!-- ### Block Configuration

No block configuration is read via `readBlockConfig()`. -->

### URL Parameters

No URL parameters are directly read, but the block uses `window.location.href` for meta tag management and page title updates.

<!-- ### Local Storage

This block uses no localStorage keys. -->

### Session Storage

| Key                     | Description                                                                                                                                                                                                                    |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `adyen_payment_error`   | Transient decline message written after a 3DS2 failure redirect. Read and cleared by `showPersistedPaymentError()` IIFE on the next `/checkout` load. Its presence at `decorate()` start sets `isPaymentErrorRecovery = true`. |
| `adyen_guest_email`     | Guest shopper email written before the post-decline redirect. Read and cleared by `restoreGuestFields` IIFE; triggers `setGuestEmailOnCart` via `handleCheckoutUpdated`.                                                       |
| `adyen_guest_firstname` | Guest shopper first name — same lifecycle as `adyen_guest_email`.                                                                                                                                                              |
| `adyen_guest_lastname`  | Guest shopper last name — same lifecycle as `adyen_guest_email`.                                                                                                                                                               |
| `recent_order_data`     | Guest checkout order data cached before redirect to order-details. Used by order initializer to fetch order details. Cleared after order page completes render.                                                                 |

### Window Globals

| Key | Description |
|-----|-------------|
| `window.__adyenCheckoutLastCartId` | Cart ID from the most recent successful order placement. Used by donation component to access order context. Cleared after order success page renders completely. |

### Payment Result Lifecycle (Guest Checkout - Non-Express)

**Problem**: In guest checkout, the pre-authorization payment result (with `pspReference` and `resultCode`) was persisting in localStorage across multiple checkout sessions. If a user started checkout #1, authorized payment, but abandoned checkout, then started checkout #2, checkout #2 would incorrectly reuse the old `pspReference` from checkout #1 instead of requesting a new authorization from Adyen.

**Solution**: Clear the payment result from state when a new checkout session begins (detected by `cart/initialized` event with a different cart ID).

**Implementation**:
- Listen to `cart/initialized` event in `decorate()`
- Compare `newCartData.id` with `lastPlacedOrderCartId` (the cart from the previous successful order)
- Only clear payment result if the cart ID has changed (new checkout session, not a page reload of the same cart)
- Clear synchronously (no defer) to prevent data being available during subsequent component initialization

**Related Code**:
- `handleOrderPlaced()` stores `lastPlacedOrderCartId` after order placement
- `cart/initialized` listener (lines ~1360) performs the conditional clear
- Export function `getLastPlacedOrderCartId()` allows donation component to verify cart context

### Events

#### Event Listeners

- `events.on('authenticated', callback)` - Handles user authentication state changes
- `events.on('cart/initialized', callback)` - Handles cart initialization with eager loading
- `events.on('checkout/initialized', callback)` - Handles checkout initialization with eager loading
- `events.on('checkout/updated', callback)` - Handles checkout data updates
- `events.on('checkout/values', callback)` - Handles checkout form value changes
- `events.on('order/placed', callback)` - Handles successful order placement

#### Event Emitters

- `events.emit('checkout/addresses/shipping', values)` - Emits shipping address form values with debouncing
- `events.emit('checkout/addresses/billing', values)` - Emits billing address form values with debouncing

## Behavior Patterns

### Page Context Detection

- **Checkout Flow**: Renders full checkout interface with shipping, billing, payment, and order summary
- **Empty Cart**: When the cart is empty, redirects to the cart page
- **Server Errors**: When server errors occur, shows the error state and hides checkout forms
- **Out of Stock**: When items are out of stock, shows an out-of-stock message with cart update options
- **Order Confirmation**: After successful order placement, transitions to order confirmation view

### User Interaction Flows

1. **Initialization**: Block sets up meta tags, renders checkout layout, and initializes all containers
2. **Authentication**: Users can sign in/out via modal with form validation and success callbacks
3. **Address Management**: Users can enter shipping/billing addresses with real-time validation and cart updates
4. **Payment Processing**: Users can select payment methods and enter credit card information with validation
5. **Order Placement**: Users can place orders with comprehensive form validation and payment processing
6. **Error Handling**: Block shows appropriate error states and recovery options for various failure scenarios

### Payment Method Browser Compatibility

The checkout block conditionally renders payment methods based on browser capabilities:

#### Apple Pay
- **Supported**: Safari only (verified via user agent detection)
- **Hidden on**: Chrome, Firefox, Edge, Opera (WebKit/Webkit-like browsers that don't support native Apple Pay)
- **Implementation**: `isApplePaySupportedBrowser()` checks for `/Safari/` in user agent while excluding Chromium-based browsers

#### Google Pay
- **Supported**: Chrome, Edge, Android browsers only
- **Hidden on**: Safari, Firefox (these browsers lack Google Pay support)
- **Implementation**: `isGooglePaySupportedBrowser()` excludes Safari and Firefox via user agent detection

#### Mechanism
- Payment method slots are conditionally **included** with full render functions on supported browsers
- On unsupported browsers, payment method slots are explicitly set with `enabled: false` to prevent the dropin from rendering them from the backend response
- This dual-layer approach ensures payment methods never render on incompatible browsers:
  1. Slot definition layer — conditionally includes render function or explicit disable
  2. Backend filtering layer — `adyen-payment/index.js` also filters the backend payment methods response

### Error Handling

- **Form Validation Errors**: Individual form validation with scroll-to-error functionality
- **Payment Processing Errors**: Credit card validation and payment service error handling
- **Server Errors**: Server error display with retry functionality
- **Cart Errors**: Empty cart and out-of-stock item handling
- **Network Errors**: Graceful handling of network failures with user feedback
- **Fallback Behavior**: Always falls back to appropriate error states with recovery options

### Dynamic Payment Method Import Resilience (containers.js)

Payment methods are dynamically imported during checkout (e.g., Adyen Cards, Klarna). When CDN or backend rate-limiting triggers a 429 status or network failure, the checkout would previously fail to render the payment method.

#### Exponential Backoff Retry Strategy

- **Scope**: `queueDynamicImport()` wraps all `import()` calls with automatic retry logic
- **Mechanism**:
  - Detects network errors: 429 status, "Failed to fetch", or "ERR_*" messages
  - Retries up to 3 times with exponential backoff delays: 500ms → 1s → 2s
  - On final retry failure, throws the error and blocks render
  - Successful import resolves immediately; no retries needed on cache hits
- **Error Recovery**: 
  - `createSafePaymentRender()` wraps payment method render functions
  - If import fails after retries or render throws, displays user-friendly error: *"Unable to load [Method]. Please try again or use another payment method."*
  - Block continues to render other payment methods; failed methods are excluded
- **Logging**: Console warnings logged for each retry with attempt count and retry delay
- **Example**: Cards form fails to import with 429 → queueDynamicImport retries 3x with backoff → On 3rd failure, `createSafePaymentRender` catches and shows error message → Klarna and other methods still render normally

### Reload Guards (`handleAuthenticated`)

The `authenticated` event is emitted by `storefront-auth` on every page init (not only on sign-in). Two guards prevent unintended page reloads:

1. **`firstAuthEventReceived`** — The very first `authenticated` event on any page load is always the initial auth state. The handler skips it unconditionally and sets the flag. Only the second and later events (genuine mid-session sign-in) proceed to reload logic. This prevents an infinite reload loop for registered customers on the checkout page.

2. **`isPaymentErrorRecovery`** — Set to `true` at `decorate()` start when `adyen_payment_error` is present in sessionStorage (indicating a 3DS2 post-decline redirect). Even if a second `authenticated` event fires, the reload is suppressed so the decline error banner can be displayed.

A `window.location.reload()` fires **only when** both guards are satisfied: `firstAuthEventReceived` is already `true` AND `authenticated` is `true` AND `isPaymentErrorRecovery` is `false`.