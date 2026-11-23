# Newsletter Block

## Overview

The Newsletter block renders authored intro text next to an email form. Submitting the form subscribes the address to the Commerce newsletter with the `subscribeEmailToNewsletter` GraphQL mutation (through the shared `CORE_FETCH_GRAPHQL` instance), so it works for guests and signed-in customers. It can be used on any page or in the footer fragment.

## Configuration Options

The block has no key/value configuration. All cells are treated as intro content (for example a heading and a short paragraph):

| Newsletter |
|---|
| ### Join our newsletter<br>Be the first to hear about new arrivals and offers. |

## Integration

### URL Parameters

This block does not read URL parameters.

### Local Storage

This block does not use localStorage.

### Events

This block does not listen to or emit events.

## Behavior Patterns

- The email is validated in the browser before the request is sent.
- The submit button is disabled while the request is in flight.
- `SUBSCRIBED` shows a thank-you message and clears the form; `NOT_ACTIVE` (Commerce requires double opt-in) asks the shopper to confirm by email.
- Messages are announced through an `aria-live` region.

## Error Handling

- GraphQL errors (for example "This email address is already subscribed", or guest subscriptions disabled in Commerce) are shown to the shopper as returned by Commerce.
- Network failures show a generic "try again later" message.
- Guest subscription must be allowed in Commerce Admin (Stores > Configuration > Customers > Newsletter) for guests to subscribe.
