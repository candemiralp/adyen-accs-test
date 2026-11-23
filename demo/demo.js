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
