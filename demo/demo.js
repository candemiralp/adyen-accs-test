/*
 * MyStore demo behaviour.
 * Lives outside blocks/, scripts/ and styles/ on purpose: those folders are synced into the
 * Adyen extension (sync-frontend), demo-only tweaks must not be.
 */
import { CORE_FETCH_GRAPHQL } from '../scripts/commerce.js';

// Address attributes Commerce still returns but the demo checkout should not ask for.
const HIDDEN_CHECKOUT_ADDRESS_ATTRIBUTES = ['vat_id'];

if (window.location.pathname.startsWith('/checkout')) {
  CORE_FETCH_GRAPHQL.addAfterHook((requestInit, response) => {
    const items = response?.data?.attributesForm?.items;
    if (!Array.isArray(items)) return response;
    return {
      ...response,
      data: {
        ...response.data,
        attributesForm: {
          ...response.data.attributesForm,
          items: items.filter((item) => !HIDDEN_CHECKOUT_ADDRESS_ATTRIBUTES.includes(item.code)),
        },
      },
    };
  });
}

// Shrink the sticky header once the page scrolls (styles in demo/theme.css).
const updateHeader = () => document.body.classList.toggle('header-scrolled', window.scrollY > 24);
window.addEventListener('scroll', updateHeader, { passive: true });
updateHeader();

// Product page: full-width description below the gallery, delivery info under add to cart.
const DISPATCH_CUTOFF_HOUR = 22;

function addWorkingDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) added += 1;
  }
  return result;
}

function buildDeliveryInfo() {
  const now = new Date();
  const days = now.getHours() < DISPATCH_CUTOFF_HOUR ? 1 : 2;
  const deliveryDate = addWorkingDays(now, days).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const items = [
    ['usp-delivery', `Get it by ${deliveryDate}`, `Order before ${DISPATCH_CUTOFF_HOUR}:00 for same-day dispatch`],
    ['pdp-package', 'Free shipping over €50', 'Otherwise a flat €5 delivery fee'],
    ['pdp-returns', 'Free 30-day returns', 'Not quite right? Send it back for free'],
  ];
  const list = document.createElement('ul');
  list.className = 'product-details__delivery';
  list.innerHTML = items.map(([icon, title, text]) => `
    <li>
      <img src="${window.hlx?.codeBasePath ?? ''}/icons/${icon}.svg" alt="" width="24" height="24" loading="lazy">
      <div><strong>${title}</strong><span>${text}</span></div>
    </li>`).join('');
  return list;
}

if (window.location.pathname.includes('/products/')) {
  let descriptionMoved = false;
  let deliveryAdded = false;
  const enhanceProductPage = () => {
    const wrapper = document.querySelector('.product-details .product-details__wrapper');
    if (!wrapper) return false;
    if (!descriptionMoved) {
      const description = wrapper.querySelector(
        '.product-details__right-column .product-details__description',
      );
      if (description) wrapper.after(description);
      descriptionMoved = true;
    }
    if (!deliveryAdded) {
      wrapper.querySelector('.product-details__configuration')?.after(buildDeliveryInfo());
      deliveryAdded = true;
    }
    return true;
  };
  if (!enhanceProductPage()) {
    const observer = new MutationObserver(() => {
      if (enhanceProductPage()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
