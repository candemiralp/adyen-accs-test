/* eslint-disable import/no-unresolved */

// Tools and initializers
import { Button, provider as UI } from '@dropins/tools/components.js';
import { initializers } from '@dropins/tools/initializer.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
import { events } from '@dropins/tools/event-bus.js';

// Order Dropin API
import * as orderApi from '@dropins/storefront-order/api.js';
import { render as OrderProvider } from '@dropins/storefront-order/render.js';
import OrderHeader from '@dropins/storefront-order/containers/OrderHeader.js';
import OrderStatus from '@dropins/storefront-order/containers/OrderStatus.js';
import ShippingStatus from '@dropins/storefront-order/containers/ShippingStatus.js';
import CustomerDetails from '@dropins/storefront-order/containers/CustomerDetails.js';
import OrderCostSummary from '@dropins/storefront-order/containers/OrderCostSummary.js';
import OrderProductList from '@dropins/storefront-order/containers/OrderProductList.js';

// Checkout API/utils used for header and DOM
import * as checkoutApi from '@dropins/storefront-checkout/api.js';
import {
  createFragment,
  createScopedSelector,
} from '@dropins/storefront-checkout/lib/utils.js';

// Cart (for gift options within order confirmation)
import { render as CartProvider } from '@dropins/storefront-cart/render.js';
import GiftOptions from '@dropins/storefront-cart/containers/GiftOptions.js';

// Auth (for sign-up modal in header)
import { render as AuthProvider } from '@dropins/storefront-auth/render.js';
import SignUp from '@dropins/storefront-auth/containers/SignUp.js';

// Commerce helpers
import {
  fetchPlaceholders,
  rootLink,
  SUPPORT_PATH,
  authPrivacyPolicyConsentSlot,
} from '../../scripts/commerce.js';

// Ensure order drop-in initializer side effects are applied
import '../../scripts/initializers/order.js';

// Local modal helper
import createModal from '../modal/modal.js';
import { loadCSS } from '../../scripts/aem.js';

// Import Adyen additional action renderer
import { getPaymentResult } from '../adyen-payment/index.js';
import { renderAction } from '../adyen-payment-additional-action/adyen-payment-additional-action.js';

// ----------------------------------------------------------------------------
// Local selectors and fragments (order confirmation only)
// ----------------------------------------------------------------------------

const selectors = Object.freeze({
  orderConfirmation: {
    header: '.order-confirmation__header',
    orderStatus: '.order-confirmation__order-status',
    shippingStatus: '.order-confirmation__shipping-status',
    customerDetails: '.order-confirmation__customer-details',
    orderCostSummary: '.order-confirmation__order-cost-summary',
    giftOptions: '.order-confirmation__gift-options',
    orderProductList: '.order-confirmation__order-product-list',
    footer: '.order-confirmation__footer',
    continueButton: '.order-confirmation-footer__continue-button',
    donation: '.order-confirmation__donation',
    additionalAction: '.order-confirmation__additional_action',
  },
});

function createOrderConfirmationFragment() {
  return createFragment(`
    <div class="order-confirmation">
      <div class="order-confirmation__main">
        <div class="order-confirmation__header order-confirmation__block"></div>
        <div class="order-confirmation__block order-confirmation__additional_action"></div>
        <div class="order-confirmation__order-status order-confirmation__block"></div>
        <div class="order-confirmation__block order-confirmation__donation"></div>        
        <div class="order-confirmation__shipping-status order-confirmation__block"></div>
        <div class="order-confirmation__customer-details order-confirmation__block"></div>
      </div>
      <div class="order-confirmation__aside">
        <div class="order-confirmation__order-cost-summary order-confirmation__block"></div>
        <div class="order-confirmation__gift-options order-confirmation__block"></div>
        <div class="order-confirmation__order-product-list order-confirmation__block"></div>
        <div class="order-confirmation__footer order-confirmation__block"></div>
      </div>
    </div>
  `);
}

function createOrderConfirmationFooter(supportPath) {
  return `
    <div class="order-confirmation-footer__continue-button"></div>
    <div class="order-confirmation-footer__contact-support">
      <p>
        Need help?
        <a
          href="${supportPath}"
          rel="noreferrer"
          class="order-confirmation-footer__contact-support-link"
          data-testid="order-confirmation-footer__contact-support-link"
        >
          Contact us
        </a>
      </p>
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Local utility slots (swatch and modal)
// ----------------------------------------------------------------------------

function swatchImageSlot(ctx) {
  const { imageSwatchContext, defaultImageProps } = ctx;
  tryRenderAemAssetsImage(ctx, {
    alias: imageSwatchContext.label,
    imageProps: defaultImageProps,
    wrapper: document.createElement('span'),
    params: {
      width: defaultImageProps.width,
      height: defaultImageProps.height,
    },
  });
}

let signUpModal;

const handleAuthenticated = (authenticated) => {
  if (authenticated) {
    window.location.reload();
  }
};

// ----------------------------------------------------------------------------
// Local renderers (order confirmation only)
// ----------------------------------------------------------------------------

async function renderOrderHeader(container, options = {}) {
  const handleSignUpClick = async ({
    inputsDefaultValueSet,
    addressesData,
  }) => {
    const signUpForm = document.createElement('div');
    AuthProvider.render(SignUp, {
      inputsDefaultValueSet,
      addressesData,
      routeSignIn: () => rootLink('/customer/login'),
      routeRedirectOnEmailConfirmationClose: () => rootLink('/customer/account'),
      slots: { ...authPrivacyPolicyConsentSlot },
    })(signUpForm);
    signUpModal = await createModal([signUpForm]);
    signUpModal.showModal();
  };

  return OrderProvider.render(OrderHeader, {
    handleEmailAvailability: checkoutApi.isEmailAvailable,
    handleSignUpClick,
    ...options,
  })(container);
}

async function renderOrderStatus(container) {
  return OrderProvider.render(OrderStatus, {
    slots: { OrderActions: () => null },
  })(container);
}

async function renderShippingStatus(container) {
  return OrderProvider.render(ShippingStatus)(container);
}

async function renderCustomerDetails(container) {
  return OrderProvider.render(CustomerDetails)(container);
}

async function renderOrderCostSummary(container) {
  return OrderProvider.render(OrderCostSummary)(container);
}

async function renderOrderProductList(container) {
  return OrderProvider.render(OrderProductList, {
    slots: {
      Footer: (ctx) => {
        const giftOptions = document.createElement('div');
        CartProvider.render(GiftOptions, {
          item: ctx.item,
          view: 'product',
          dataSource: 'order',
          isEditable: false,
          slots: {
            SwatchImage: swatchImageSlot,
          },
        })(giftOptions);
        ctx.appendChild(giftOptions);
      },
      CartSummaryItemImage: (ctx) => {
        const { data, defaultImageProps } = ctx;
        tryRenderAemAssetsImage(ctx, {
          alias: data.product.sku,
          imageProps: defaultImageProps,
          params: {
            width: defaultImageProps.width,
            height: defaultImageProps.height,
          },
        });
      },
    },
  })(container);
}

async function renderOrderGiftOptions(container) {
  return CartProvider.render(GiftOptions, {
    view: 'order',
    dataSource: 'order',
    isEditable: false,
    readOnlyFormOrderView: 'secondary',
    slots: {
      SwatchImage: swatchImageSlot,
    },
  })(container);
}

async function renderOrderConfirmationFooterButton(container) {
  return UI.render(Button, {
    children: 'Continue shopping',
    'data-testid': 'order-confirmation-footer__continue-button',
    className: 'order-confirmation-footer__continue-button',
    size: 'medium',
    variant: 'primary',
    type: 'submit',
    href: rootLink('/'),
  })(container);
}

async function renderCheckoutSuccessContent(container, { orderData } = {}) {
  // Register event handler for authenticated event
  events.on('authenticated', handleAuthenticated);

  // Scroll to top on success view
  window.scrollTo(0, 0);

  // BUGFIX: Guest checkout from non-express payment (e.g., credit card) needs orderData
  // cached in sessionStorage before the order initializer runs. Without this, the order
  // dropin will try to fetch order details via GraphQL with NO query params (no orderRef,
  // no auth token), which fails silently and leaves the loader stuck indefinitely.
  // This mirrors caching already done in express checkout (adyen-payment-express/order.js).
  if (orderData && !sessionStorage.getItem('recent_order_data')) {
    try {
      sessionStorage.setItem('recent_order_data', JSON.stringify(orderData));
      console.debug('[commerce-checkout-success] Cached orderData in sessionStorage for order initializer', {
        orderNumber: orderData.number,
        hasToken: !!orderData.token,
        hasEmail: !!orderData.email,
      });
    } catch (err) {
      console.warn('[commerce-checkout-success] Failed to cache orderData:', err);
    }
  }

  // Create order confirmation layout using local fragments
  const orderConfirmationFragment = createOrderConfirmationFragment();

  // Scoped selector for the fragment
  const getOrderElement = createScopedSelector(orderConfirmationFragment);

  // Query all required elements using local selectors
  const $orderConfirmationHeader = getOrderElement(
    selectors.orderConfirmation.header,
  );
  const $orderStatus = getOrderElement(selectors.orderConfirmation.orderStatus);
  const $shippingStatus = getOrderElement(
    selectors.orderConfirmation.shippingStatus,
  );
  const $customerDetails = getOrderElement(
    selectors.orderConfirmation.customerDetails,
  );
  const $orderCostSummary = getOrderElement(
    selectors.orderConfirmation.orderCostSummary,
  );
  const $orderGiftOptions = getOrderElement(
    selectors.orderConfirmation.giftOptions,
  );
  const $orderProductList = getOrderElement(
    selectors.orderConfirmation.orderProductList,
  );
  const $orderConfirmationFooter = getOrderElement(
    selectors.orderConfirmation.footer,
  );
  // Added by Adyen
  const $orderConfirmationDonation = getOrderElement(
    selectors.orderConfirmation.donation,
  );
  const $orderConfirmationAdditionalAction = getOrderElement(
    selectors.orderConfirmation.additionalAction,
  );

  container.replaceChildren(orderConfirmationFragment);

  // Mount order drop-in with localized placeholders (and optional order data)
  const labels = await fetchPlaceholders();
  const langDefinitions = { default: { ...labels } };
  const initOptions = orderData
    ? { langDefinitions, orderData }
    : { langDefinitions };
  await initializers.mountImmediately(orderApi.initialize, initOptions);

  /// Added by Adyen
  const paymentResult = await getPaymentResult();

  // Import and mount donation component if available
  try {
    const { mountDonationComponent } = await import(
      '../adyen-payment-donation/adyen-payment-donation.js'
    );
    await mountDonationComponent($orderConfirmationDonation, orderData);
  } catch (error) {
    console.error('[commerce-checkout-success] Failed to load donation component:', error);
  }

  // If additional action is required, render it
  try {
    if (paymentResult?.action) {
      await renderAction(
        $orderConfirmationAdditionalAction,
        paymentResult.action,
        orderData,
      );
    }
  } catch (error) {
    console.error('[commerce-checkout-success] Failed to render additional action:', error);
  }
  /// Adyen

  // Render all order confirmation containers using local renderers
  await Promise.all([
    renderOrderHeader($orderConfirmationHeader, { orderData }),
    renderOrderStatus($orderStatus),
    renderShippingStatus($shippingStatus),
    renderCustomerDetails($customerDetails),
    renderOrderCostSummary($orderCostSummary),
    renderOrderProductList($orderProductList),
    renderOrderGiftOptions($orderGiftOptions),
  ]);

  // Footer content and continue button
  $orderConfirmationFooter.innerHTML = createOrderConfirmationFooter(
    rootLink(SUPPORT_PATH),
  );
  const $continueBtn = $orderConfirmationFooter.querySelector(
    selectors.orderConfirmation.continueButton,
  );
  await renderOrderConfirmationFooterButton($continueBtn);

  // ACH Direct Debit: inform the shopper that bank settlement takes 3–5 business days.
  // orderData.payments[0].code is the Commerce payment method code (e.g. 'adyen_ach').
  // Confirmed shape: OrderDataModel.payments is { code: string; name: string }[]
  // per scripts/__dropins__/storefront-order/data/models/order-details.d.ts lines 207–210.
  const paymentCode = orderData?.payments?.[0]?.code;
  if (paymentCode === 'adyen_ach') {
    const notice = document.createElement('p');
    notice.className = 'ach-pending-notice';
    notice.textContent = 'Your payment is pending bank verification and may take 3\u20135 business days to clear. '
      + 'You will receive an email confirmation once the payment has been processed.';
    orderConfirmationFragment.appendChild(notice);
  }

  // SEPA Direct Debit: inform the shopper that bank settlement is asynchronous and may take
  // several business days. The AUTHORISATION webhook will confirm settlement.
  if (paymentCode === 'adyen_sepadirectdebit') {
    const notice = document.createElement('p');
    notice.className = 'sepa-pending-notice';
    notice.textContent = 'Your SEPA Direct Debit payment has been submitted and is pending settlement. '
      + 'You will receive an email confirmation once the payment has been processed.';
    orderConfirmationFragment.appendChild(notice);
  }
}

export function preloadCheckoutSuccess() {
  return loadCSS(
    `${window.hlx.codeBasePath}/blocks/commerce-checkout-success/commerce-checkout-success.css`,
  );
}

export async function renderCheckoutSuccess(container, { orderData } = {}) {
  return renderCheckoutSuccessContent(container, { orderData });
}

export default async function decorate(block) {
  await renderCheckoutSuccessContent(block);
}
