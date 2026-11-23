# Product Carousel Block

## Overview

The Product Carousel block shows a horizontally scrollable row of products on content pages such as the homepage. Products are fetched from Catalog Service (`productSearch`) through the shared `CS_FETCH_GRAPHQL` instance, either from a catalog category or from an explicit list of SKUs. Each card shows the product image, name, price and an add-to-cart button.

## Configuration Options

Block configuration is read via `readBlockConfig(block)`.

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `category` | string | — | Catalog category URL path (e.g. `gear/bags`). Adds a `categoryPath` filter. |
| `skus` | string | — | Comma separated SKUs. Adds a `sku` filter and renders products in the given order. Can be combined with `category`. |
| `limit` | number | `8` | Maximum number of products to render. Ignored for the request size when `skus` is set. |
| `rows` | number | `1` | Rows per slide (1-3). Each slide shows 4 columns on desktop and 2 on mobile, so `rows: 2` gives 4x2 slides. |

Example:

| Product Carousel | |
|---|---|
| category | gear/bags |
| limit | 8 |

## Integration

### URL Parameters

This block does not read URL parameters.

### Local Storage

This block does not use localStorage.

### Events

The block does not listen to or emit events. Add to cart calls `cartApi.addProductsToCart` from the cart dropin, which emits the usual cart events (mini cart updates). The heart button in the top-right corner of each card is the wishlist dropin's `WishlistToggle`.

## Behavior Patterns

- A visibility filter (`Catalog`, `Catalog, Search`) is always applied.
- Simple products get an add-to-cart button, disabled when out of stock. Complex products link to the PDP instead.
- Images are requested from the Commerce image CDN with `width`, `auto=webp` and `quality` parameters and are lazy loaded.
- Products are grouped into slides of `columns x rows` cards (4 columns from 900px, 2 below). Previous/next buttons (top right on desktop, below the slides on mobile) move one slide at a time and are hidden when everything fits on one slide; slides can also be swiped. Slides are rebuilt when crossing the 900px breakpoint.

## Error Handling

- If the request fails or returns no products, the block's section gets the `product-carousel-empty` class and is hidden, so authors do not see a broken row on the live site. Errors are logged with `console.warn`.
- Missing images render an empty placeholder tile; missing prices render an empty price line.
