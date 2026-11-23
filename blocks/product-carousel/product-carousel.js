import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import * as cartApi from '@dropins/storefront-cart/api.js';
import { readBlockConfig } from '../../scripts/aem.js';
import { CS_FETCH_GRAPHQL, fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';

import '../../scripts/initializers/cart.js';

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
  const li = document.createElement('li');
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
    variant: 'secondary',
    size: 'medium',
    ...(isComplex
      ? { href: link }
      : {
        disabled: !product.inStock,
        onClick: () => cartApi.addProductsToCart([{ sku: product.sku, quantity: 1 }]),
      }),
  })(action);

  li.append(imageLink, name, price, action);
  return li;
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
      list.scrollBy({ left: sign * list.clientWidth * 0.9, behavior: 'smooth' });
    });
    return button;
  };
  const prev = make('prev', 'Previous products');
  const next = make('next', 'Next products');
  nav.append(prev, next);

  const update = () => {
    prev.disabled = list.scrollLeft <= 1;
    next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  };
  list.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  block.append(nav);
  requestAnimationFrame(update);
}

/**
 * Product Carousel block
 * Config rows: `category` (catalog URL path, e.g. gear/bags), `skus` (comma separated),
 * `limit` (max number of products, default 8).
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const config = readBlockConfig(block);
  const limit = parseInt(config.limit, 10) || 8;
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

  list.append(...products.slice(0, limit).map((p) => renderCard(p, labels)));
  setupNavigation(block, list);
}
