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

// Product page: show the description full width below the gallery and add to cart section.
if (window.location.pathname.includes('/products/')) {
  const moveDescription = () => {
    const wrapper = document.querySelector('.product-details .product-details__wrapper');
    const description = wrapper?.querySelector('.product-details__right-column .product-details__description');
    if (!description) return Boolean(wrapper);
    wrapper.after(description);
    return true;
  };
  if (!moveDescription()) {
    const observer = new MutationObserver(() => {
      if (moveDescription()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
