/* eslint-disable import/no-unresolved */
import { ProgressSpinner, provider as UI } from '@dropins/tools/components.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
import { ORDER_DETAILS_PATH, rootLink } from '../../scripts/commerce.js';
import { getUserTokenCookie } from '../../scripts/initializers/index.js';
import createModal from '../modal/modal.js';

/**
 * Displays an overlay spinner in the specified container
 * @param {Object} loaderRef - Ref object to store the spinner component
 * @param {HTMLElement} $loader - DOM element to render the spinner in
 */
export const displayOverlaySpinner = async (loaderRef, $loader) => {
  const timestamp = new Date().toISOString();
  console.info(`[displayOverlaySpinner] CALLED at ${timestamp}`, {
    alreadyDisplayed: !!loaderRef.current,
    loaderElementExists: !!$loader,
    loaderClass: $loader?.className,
    loaderParentClass: $loader?.parentElement?.className,
    loaderGrandparentClass: $loader?.parentElement?.parentElement?.className,
    loaderDOMPath: $loader ? Array.from($loader.parentElement?.classList || []).join('.') : 'N/A',
  });

  if (loaderRef.current) {
    console.warn('[displayOverlaySpinner] Spinner already displayed, skipping');
    return;
  }

  // Insert a placeholder synchronously so $loader is never empty while we
  // await UI.render. The :empty CSS rule hides $loader when it has no
  // children, which causes a visible flicker if the placeholder is absent.
  const placeholder = document.createElement('span');
  $loader.appendChild(placeholder);

  console.debug('[displayOverlaySpinner] Placeholder inserted, rendering ProgressSpinner...');
  loaderRef.current = await UI.render(ProgressSpinner, {
    className: '.checkout__overlay-spinner',
  })($loader);

  // CRITICAL: After rendering, the ProgressSpinner may have empty innerHTML initially.
  // This is likely because the component is still hydrating or the Preact VDOM hasn't
  // been fully rendered to the DOM yet. Let's wait a brief moment and check again.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  // DETAILED INSPECTION: What actually got rendered?
  const renderedElement = loaderRef.current;
  const renderedHTML = $loader.innerHTML.substring(0, 500);
  const allChildren = Array.from($loader.children).map((child, idx) => ({
    index: idx,
    tagName: child.tagName,
    className: child.className,
    id: child.id,
    childCount: child.children.length,
    textContent: child.textContent?.substring(0, 50),
  }));

  console.info(`[displayOverlaySpinner] Component rendered, detailed inspection at ${new Date().toISOString()}`, {
    renderedElement: renderedElement ? 'exists' : 'null',
    renderedElementType: renderedElement?.constructor?.name,
    loaderChildCount: $loader.children.length,
    loaderChildren: allChildren,
    loaderInnerHTML: renderedHTML,
  });

  // Log visual/CSS state after rendering
  const computedStyle = window.getComputedStyle($loader);
  const spinnerElement = $loader.querySelector('[class*="progress-spinner"]') || $loader.querySelector('[class*="ProgressSpinner"]') || $loader.firstChild;
  const spinnerComputedStyle = spinnerElement ? window.getComputedStyle(spinnerElement) : null;

  console.info('[displayOverlaySpinner] CSS DEBUG - $loader container', {
    display: computedStyle.display,
    visibility: computedStyle.visibility,
    opacity: computedStyle.opacity,
    zIndex: computedStyle.zIndex,
    position: computedStyle.position,
    width: computedStyle.width,
    height: computedStyle.height,
    backgroundColor: computedStyle.backgroundColor,
    overflow: computedStyle.overflow,
    pointerEvents: computedStyle.pointerEvents,
  });

  if (spinnerElement) {
    // CHECK FOR SHADOW DOM
    const hasShadowRoot = spinnerElement.shadowRoot !== null;
    console.info('[displayOverlaySpinner] Spinner element found', {
      tagName: spinnerElement.tagName,
      className: spinnerElement.className,
      id: spinnerElement.id,
      innerHTML: spinnerElement.innerHTML.substring(0, 100),
      textContent: spinnerElement.textContent?.substring(0, 50),
      childCount: spinnerElement.children.length,
      allDescendants: spinnerElement.querySelectorAll('*').length,
      hasShadowRoot,
      shadowRootInnerHTML: hasShadowRoot ? spinnerElement.shadowRoot.innerHTML.substring(0, 200) : 'N/A',
    });
    console.info('[displayOverlaySpinner] CSS DEBUG - spinner element', {
      display: spinnerComputedStyle.display,
      visibility: spinnerComputedStyle.visibility,
      opacity: spinnerComputedStyle.opacity,
      zIndex: spinnerComputedStyle.zIndex,
      position: spinnerComputedStyle.position,
      width: spinnerComputedStyle.width,
      height: spinnerComputedStyle.height,
      pointerEvents: spinnerComputedStyle.pointerEvents,
    });

    // Log all child elements recursively to find where the SVG/content might be
    const logChildren = (el, depth = 0) => {
      if (depth > 5) return; // Limit recursion
      Array.from(el.children).forEach((child) => {
        console.debug(`[displayOverlaySpinner] Spinner descendant L${depth}`, {
          tag: child.tagName,
          class: child.className,
          id: child.id,
          innerHTML: child.innerHTML.substring(0, 50),
          hasShadowRoot: child.shadowRoot !== null,
        });
        logChildren(child, depth + 1);
      });
    };
    logChildren(spinnerElement);

    // If shadow DOM exists, log its contents too
    if (hasShadowRoot) {
      console.info('[displayOverlaySpinner] SHADOW DOM DETECTED - Contents:', {
        shadowHTML: spinnerElement.shadowRoot.innerHTML.substring(0, 500),
      });
    }
  } else {
    console.warn('[displayOverlaySpinner] No spinner element found in DOM!', {
      loaderHTML: $loader.innerHTML.substring(0, 200),
      loaderChildren: $loader.children.length,
    });
  }

  // Set up a MutationObserver to track DOM changes to the loader
  const observer = new MutationObserver((mutations) => {
    console.debug('[displayOverlaySpinner] MUTATION DETECTED', {
      mutationCount: mutations.length,
      firstMutation: {
        type: mutations[0]?.type,
        addedNodes: mutations[0]?.addedNodes?.length,
        removedNodes: mutations[0]?.removedNodes?.length,
      },
      currentLoaderHTML: $loader.innerHTML.substring(0, 100),
      currentLoaderChildren: $loader.children.length,
    });
  });

  observer.observe($loader, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'display', 'opacity'],
    characterData: false,
  });

  loaderRef.loaderObserver = observer; // Store for later cleanup

  console.info(`[displayOverlaySpinner] SUCCESS - ProgressSpinner rendered at ${new Date().toISOString()}`, {
    loaderRef: !!loaderRef.current,
    loaderElementHTML: $loader.innerHTML.substring(0, 100),
  });

  // UI.render replaces $loader's content, so the placeholder is gone now.
};

/**
 * Removes the overlay spinner and cleans up references
 * @param {Object} loaderRef - Ref object containing the spinner component
 * @param {HTMLElement} $loader - DOM element containing the spinner
 */
export const removeOverlaySpinner = (loaderRef, $loader) => {
  const timestamp = new Date().toISOString();
  const stackTrace = new Error().stack;

  console.info(`[removeOverlaySpinner] CALLED at ${timestamp}`, {
    loaderRefExists: !!loaderRef.current,
    loaderElementHTML: $loader?.innerHTML?.substring(0, 100),
  });

  if (!loaderRef.current) {
    console.warn('[removeOverlaySpinner] loaderRef.current is null/undefined, skipping removal');
    return;
  }

  // Log CSS state before removal
  const computedStyle = window.getComputedStyle($loader);
  const spinnerElement = $loader.querySelector('[class*="progress-spinner"]') || $loader.firstChild;
  const spinnerComputedStyle = spinnerElement ? window.getComputedStyle(spinnerElement) : null;

  console.debug('[removeOverlaySpinner] CSS DEBUG BEFORE REMOVAL - $loader container', {
    display: computedStyle.display,
    visibility: computedStyle.visibility,
    opacity: computedStyle.opacity,
    zIndex: computedStyle.zIndex,
    position: computedStyle.position,
    width: computedStyle.width,
    height: computedStyle.height,
  });

  if (spinnerComputedStyle) {
    console.debug('[removeOverlaySpinner] CSS DEBUG BEFORE REMOVAL - spinner element', {
      display: spinnerComputedStyle.display,
      visibility: spinnerComputedStyle.visibility,
      opacity: spinnerComputedStyle.opacity,
      zIndex: spinnerComputedStyle.zIndex,
    });
  }

  console.debug('[removeOverlaySpinner] Removing spinner from DOM...');
  loaderRef.current.remove();
  loaderRef.current = null;
  $loader.innerHTML = '';

  console.info(`[removeOverlaySpinner] SUCCESS - Spinner removed at ${new Date().toISOString()}`, {
    calledFrom: stackTrace.split('\n')[2]?.trim(),
  });
};

// Modal state management
let modal;

/**
 * Shows a modal with the specified content
 * @param {HTMLElement} content - DOM element to display in the modal
 */
export const showModal = async (content) => {
  modal = await createModal([content]);
  modal.showModal();
};

/**
 * Removes the currently displayed modal and cleans up references
 */
export const removeModal = () => {
  if (!modal) return;
  modal.removeModal();
  modal = null;
};

/**
 * Renders AEM asset images for gift option swatches
 * @param {Object} ctx - The context object containing imageSwatchContext and defaultImageProps
 */
export function swatchImageSlot(ctx) {
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

/**
 * Builds the order details URL based on authentication status
 * @param {Object} orderData - Order data containing number and token
 * @param {string} orderDetailsPath - Path to the order details page
 * @returns {string} The constructed order details URL
 */
export function buildOrderDetailsUrl(orderData, orderDetailsPath = ORDER_DETAILS_PATH) {
  const token = getUserTokenCookie();
  const orderRef = token ? orderData.number : orderData.token;
  const orderNumber = orderData.number;
  const encodedOrderRef = encodeURIComponent(orderRef);
  const encodedOrderNumber = encodeURIComponent(orderNumber);

  return token
    ? rootLink(`${orderDetailsPath}?orderRef=${encodedOrderRef}`)
    : rootLink(`${orderDetailsPath}?orderRef=${encodedOrderRef}&orderNumber=${encodedOrderNumber}`);
}
