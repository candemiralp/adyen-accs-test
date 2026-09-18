import { events } from '@dropins/tools/event-bus.js';
import { initializers } from '@dropins/tools/initializer.js';
import { initialize, setEndpoint } from '@dropins/storefront-order/api.js';
import { initializeDropin } from './index.js';
import {
  CORE_FETCH_GRAPHQL,
  fetchPlaceholders,
  checkIsAuthenticated,
  CUSTOMER_ORDER_DETAILS_PATH,
  ORDER_DETAILS_PATH,
  CUSTOMER_RETURN_DETAILS_PATH,
  RETURN_DETAILS_PATH,
  CUSTOMER_CREATE_RETURN_PATH,
  CREATE_RETURN_PATH,
  CUSTOMER_ORDERS_PATH,
  ORDER_STATUS_PATH,
  CUSTOMER_PATH,
  SALES_GUEST_VIEW_PATH,
  SALES_ORDER_VIEW_PATH,
  rootLink,
} from '../commerce.js';

await initializeDropin(async () => {
  // Set Fetch GraphQL (Core)
  setEndpoint(CORE_FETCH_GRAPHQL);

  const { pathname, searchParams } = new URL(window.location.href);
  if (pathname.includes(CUSTOMER_ORDERS_PATH)) {
    return;
  }
  const isAccountPage = pathname.includes(CUSTOMER_PATH);
  const orderRef = searchParams.get('orderRef');
  const returnRef = searchParams.get('returnRef');
  const orderNumber = searchParams.get('orderNumber');
  const isTokenProvided = orderRef && orderRef.length > 20;

  // Fetch placeholders
  const labels = await fetchPlaceholders('placeholders/order.json');
  const langDefinitions = {
    default: {
      ...labels,
    },
  };

  const pathsRequiringRedirects = [
    ORDER_DETAILS_PATH,
    CUSTOMER_ORDER_DETAILS_PATH,
    RETURN_DETAILS_PATH,
    CUSTOMER_RETURN_DETAILS_PATH,
    CREATE_RETURN_PATH,
    CUSTOMER_CREATE_RETURN_PATH,
    SALES_GUEST_VIEW_PATH,
    SALES_ORDER_VIEW_PATH,
  ];

  if (pathsRequiringRedirects.includes(pathname)) {
    await handleUserOrdersRedirects(
      pathname,
      isAccountPage,
      orderRef,
      returnRef,
      isTokenProvided,
      langDefinitions,
      orderNumber,
    );
    return;
  }

  // Initialize order
  await initializers.mountImmediately(initialize, {
    langDefinitions,
    orderRef,
    returnRef,
    models: {
      OrderModel: {
        transformer: (data) => ({
          payment_methods: data?.payment_methods,
        }),
      },
    },
  });
})();

async function handleUserOrdersRedirects(
  pathname,
  isAccountPage,
  orderRef,
  returnRef,
  isTokenProvided,
  langDefinitions,
  orderNumber,
) {
  let targetPath = null;

  events.on('order/error', () => {
    if (checkIsAuthenticated()) {
      window.location.href = rootLink(CUSTOMER_ORDERS_PATH);
    } else if (isTokenProvided) {
      window.location.href = orderNumber ? rootLink(`${ORDER_STATUS_PATH}?orderRef=${orderNumber}`) : rootLink(ORDER_STATUS_PATH);
    } else {
      window.location.href = rootLink(`${ORDER_STATUS_PATH}?orderRef=${orderRef}`);
    }
  });

  if (checkIsAuthenticated()) {
    if (!orderRef) {
      targetPath = CUSTOMER_ORDERS_PATH;
    } else if (isAccountPage) {
      targetPath = isTokenProvided
        ? `${ORDER_DETAILS_PATH}?orderRef=${orderRef}`
        : null;
    } else {
      targetPath = isTokenProvided
        ? null
        : `${CUSTOMER_ORDER_DETAILS_PATH}?orderRef=${orderRef}`;
    }
  } else {
    targetPath = !orderRef ? ORDER_STATUS_PATH : null;
  }

  if (targetPath) {
    window.location.href = rootLink(targetPath);
  } else {
    // Check for cached order data written by express checkout redirect.
    // If present, pass it directly to initialize so it short-circuits the
    // GraphQL fetch (avoiding an order/error → /order-status redirect when
    // guestOrderByToken returns no data).
    let cachedOrderData = null;
    try {
      const raw = sessionStorage.getItem('recent_order_data');
      if (raw) {
        cachedOrderData = JSON.parse(raw);
        sessionStorage.removeItem('recent_order_data');
      }
    } catch {
      // Ignore sessionStorage/JSON errors
    }

    await initializers.mountImmediately(initialize, {
      langDefinitions,
      orderRef,
      returnRef,
      ...(cachedOrderData ? { orderData: cachedOrderData } : {}),
    });

    // ponytail: sections hidden during init, ensure they display after order dropin loads
    document.querySelectorAll('div.section').forEach((section) => {
      if (section.style.display === 'none') {
        section.style.display = null;
      }
    });
  }
}
