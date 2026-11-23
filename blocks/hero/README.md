# Hero Block

## Overview

The Hero block renders a full-width banner with a background image, a heading, optional copy and call-to-action buttons. It is styling-only (`hero.js` is empty); the markup comes from the authored content. A hero is also auto-built by `buildHeroBlock` in `scripts/scripts.js` when a page starts with a picture followed by an `h1`.

## Configuration Options

The block has no key/value configuration. Authored content (single cell):

1. Image (rendered as the background, `object-fit: cover`)
2. Heading (`h1`)
3. Optional paragraph(s)
4. Optional link(s); bold links become buttons via `decorateButtons`

### Variants

| Variant | Effect |
|---------|--------|
| `right` | On desktop (≥ 900px) aligns the copy to the right and flips the gradient overlay. Use it when the subject of the image is on the left. |

## Integration

### URL Parameters

This block does not read URL parameters.

### Local Storage

This block does not use localStorage.

### Events

This block does not listen to or emit events.

## Behavior Patterns

- The section wrapper is full width (`.hero-container .hero-wrapper` removes max-width and padding).
- A gradient overlay keeps white text readable over bright images.
- Minimum height is 360px on mobile and 520px on desktop.

## Error Handling

If no image is authored the block renders as a dark banner from the overlay only; text remains readable.
