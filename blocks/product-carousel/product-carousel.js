import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import * as cartApi from '@dropins/storefront-cart/api.js';
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';
import { readBlockConfig } from '../../scripts/aem.js';
import { CS_FETCH_GRAPHQL, fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';

import '../../scripts/initializers/cart.js';
import '../../scripts/initializers/wishlist.js';

const PRODUCTS_QUERY = `
  query ProductCarousel($filter: [SearchClauseInput!], $pageSize: Int) {
    productSearch(phrase: "", page_size: $pageSize, filter: $filter, sort: [{ attribute: "position", direction: DESC }]) {
      items {
        productView {
          __typename
          sku
          name
          urlKey
          inStock
          images(roles: ["image"]) { url label }
          ... on SimpleProductView {
            price { final { amount { value currency } } }
          }
          ... on ComplexProductView {
            priceRange { minimum { final { amount { value currency } } } }
          }
        }
      }
    }
  }
`;

const DESKTOP = window.matchMedia('(min-width: 900px)');
const IMAGE_SIZE = 300;
const IMAGE_WIDTHS = [IMAGE_SIZE, IMAGE_SIZE * 2];

function formatPrice(product) {
  const amount = product.price?.final?.amount ?? product.priceRange?.minimum?.final?.amount;
  if (!amount?.currency) return '';
  return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
    style: 'currency',
    currency: amount.currency,
  }).format(amount.value);
}

function imageUrl(url, width) {
  const u = new URL(url, window.location.href);
  u.searchParams.set('width', width);
  u.searchParams.set('auto', 'webp');
  u.searchParams.set('quality', 80);
  return u.toString();
}

function renderCard(product, labels) {
  const link = getProductLink(product.urlKey, product.sku);
  const li = document.createElement('div');
  li.className = 'product-carousel-item';

  const image = product.images?.[0];
  const imageLink = document.createElement('a');
  imageLink.className = 'product-carousel-image';
  imageLink.href = link;
  imageLink.tabIndex = -1;
  if (image?.url) {
    const img = document.createElement('img');
    img.src = imageUrl(image.url, IMAGE_SIZE);
    img.srcset = IMAGE_WIDTHS.map((w) => `${imageUrl(image.url, w)} ${w}w`).join(', ');
    img.sizes = '(min-width: 900px) 25vw, 50vw';
    img.alt = image.label || product.name;
    img.loading = 'lazy';
    img.width = IMAGE_SIZE;
    img.height = IMAGE_SIZE;
    imageLink.append(img);
  }

  const name = document.createElement('a');
  name.className = 'product-carousel-name';
  name.href = link;
  name.textContent = product.name;

  const price = document.createElement('p');
  price.className = 'product-carousel-price';
  price.textContent = formatPrice(product);

  const action = document.createElement('div');
  action.className = 'product-carousel-action';
  const isComplex = product.__typename === 'ComplexProductView';
  UI.render(Button, {
    children: labels.Global?.AddProductToCart,
    icon: Icon({ source: 'Cart' }),
    variant: 'primary',
    size: 'medium',
    ...(isComplex
      ? { href: link }
      : {
        disabled: !product.inStock,
        onClick: () => cartApi.addProductsToCart([{ sku: product.sku, quantity: 1 }]),
      }),
  })(action);

  const wishlist = document.createElement('div');
  wishlist.className = 'product-carousel-wishlist';
  wishlistRender.render(WishlistToggle, {
    product: {
      sku: product.sku,
      name: product.name,
      urlKey: product.urlKey,
      inStock: product.inStock,
      images: product.images,
    },
    variant: 'tertiary',
  })(wishlist);

  li.append(imageLink, wishlist, name, price, action);
  return li;
}

function renderPages(list, cards, rows) {
  const perPage = (DESKTOP.matches ? 4 : 2) * rows;
  const pageCount = Math.ceil(cards.length / perPage);
  const pages = Array.from({ length: pageCount }, (_, i) => {
    const page = document.createElement('li');
    page.className = 'product-carousel-page';
    page.setAttribute('aria-label', `${i + 1} of ${pageCount}`);
    page.append(...cards.slice(i * perPage, (i + 1) * perPage));
    return page;
  });
  list.replaceChildren(...pages);
  list.scrollLeft = 0;
}

function setupNavigation(block, list) {
  const nav = document.createElement('div');
  nav.className = 'product-carousel-nav';
  const make = (direction, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `product-carousel-${direction}`;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      const sign = direction === 'next' ? 1 : -1;
      list.scrollBy({ left: sign * list.clientWidth, behavior: 'smooth' });
    });
    return button;
  };
  const prev = make('prev', 'Previous products');
  const next = make('next', 'Next products');
  nav.append(prev, next);

  const update = () => {
    nav.hidden = list.scrollWidth <= list.clientWidth + 1;
    prev.disabled = list.scrollLeft <= 1;
    next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  };
  list.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  block.append(nav);
  requestAnimationFrame(update);
  return update;
}

/**
 * Product Carousel block
 * Config rows: `category` (catalog URL path, e.g. gear/bags), `skus` (comma separated),
 * `limit` (max number of products, default 8), `rows` (rows per slide, default 1).
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const config = readBlockConfig(block);
  const limit = parseInt(config.limit, 10) || 8;
  const rows = Math.min(Math.max(parseInt(config.rows, 10) || 1, 1), 3);
  const skus = (config.skus || '').split(',').map((s) => s.trim()).filter(Boolean);
  const filter = [{ attribute: 'visibility', in: ['Catalog', 'Catalog, Search'] }];
  if (skus.length) filter.push({ attribute: 'sku', in: skus });
  if (config.category) filter.push({ attribute: 'categoryPath', eq: config.category });

  block.textContent = '';
  const list = document.createElement('ul');
  list.className = 'product-carousel-list';
  block.append(list);

  const [labels, response] = await Promise.all([
    fetchPlaceholders(),
    CS_FETCH_GRAPHQL.fetchGraphQl(PRODUCTS_QUERY, {
      method: 'GET',
      variables: { filter, pageSize: skus.length || limit },
    }).catch((error) => ({ errors: [error] })),
  ]);

  let products = response?.data?.productSearch?.items?.map((i) => i.productView) ?? [];
  if (response?.errors?.length) console.warn('product-carousel: failed to load products', response.errors);
  if (skus.length) {
    products = skus.map((sku) => products.find((p) => p.sku === sku)).filter(Boolean);
  }

  if (!products.length) {
    block.closest('.section')?.classList.add('product-carousel-empty');
    return;
  }

  const cards = products.slice(0, limit).map((p) => renderCard(p, labels));
  renderPages(list, cards, rows);
  const updateNavigation = setupNavigation(block, list);
  DESKTOP.addEventListener('change', () => {
    renderPages(list, cards, rows);
    updateNavigation();
  });
}
