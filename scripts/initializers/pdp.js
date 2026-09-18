import { initializers } from '@dropins/tools/initializer.js';
import { Image, provider as UI } from '@dropins/tools/components.js';
import { initialize, setEndpoint, fetchProductData } from '@dropins/storefront-pdp/api.js';
import { isAemAssetsEnabled, tryGenerateAemAssetsOptimizedUrl } from '@dropins/tools/lib/aem/assets.js';
import { initializeDropin } from './index.js';
import {
  CS_FETCH_GRAPHQL,
  fetchPlaceholders,
  getOptionsUIDsFromUrl,
  getProductSku,
  IS_UE,
  loadErrorPage,
  preloadFile,
} from '../commerce.js';
import { getMetadata } from '../aem.js';

export const IMAGES_SIZES = {
  width: 960,
  height: 1191,
};

/**
 * Extracts the main product image URL from JSON-LD or meta tags
 * @returns {string|null} The image URL or null if not found
 */
function extractMainImageUrl() {
  // Cache DOM query to avoid repeated lookups
  const jsonLdScript = document.querySelector('script[type="application/ld+json"]');

  if (!jsonLdScript?.textContent) {
    return getMetadata('og:image') || getMetadata('image');
  }

  try {
    const jsonLd = JSON.parse(jsonLdScript.textContent);

    // Verify this is product structured data before extracting image
    if (jsonLd?.['@type'] === 'Product' && jsonLd?.image) {
      return jsonLd.image;
    }

    return getMetadata('og:image') || getMetadata('image');
  } catch (error) {
    console.debug('Failed to parse JSON-LD:', error);
    return getMetadata('og:image') || getMetadata('image');
  }
}

/**
 * Validates if a URL is valid and safe to preload
 * @param {string} url The URL to validate
 * @returns {boolean} True if the URL is valid
 */
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return false;
  }

  // Reject URLs that have been rewritten by AEM image optimization
  // These URLs have ?width=, &format=, &optimize= query params and cause SSL protocol errors
  if (url.includes('?width=') || url.includes('&format=') || url.includes('&optimize=')) {
    return false;
  }

  // Reject fallback/placeholder URLs
  if (url.includes('default-meta-image')) {
    return false;
  }

  // Check if it's a valid HTTP(S) URL or an absolute path
  try {
    // Try to parse as URL for absolute HTTP(S) URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // eslint-disable-next-line no-unused-vars
      const parsedUrl = new URL(url);
      return true;
    }
    // Allow absolute paths like /images/...
    if (url.startsWith('/')) {
      return true;
    }
    // Allow protocol-relative URLs like //example.com/image.png
    if (url.startsWith('//')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Preloads PDP Dropins assets for optimal performance
 */
function preloadPDPAssets() {
  // Preload PDP Dropins assets
  preloadFile('/scripts/__dropins__/storefront-pdp/api.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/render.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductHeader.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductPrice.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductShortDescription.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductOptions.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductQuantity.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductDescription.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductAttributes.js', 'script');
  preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductGallery.js', 'script');

  // Extract and preload main product image
  const imageUrl = extractMainImageUrl();
  const isValid = isValidImageUrl(imageUrl);
  console.warn(`[pdp] Image URL extraction: url="${imageUrl}" valid=${isValid}`);

  // Validate image URL before preloading to avoid 404 errors and protocol mismatches
  if (isValid) {
    console.warn(`[pdp] Preloading image: ${imageUrl}`);
    preloadFile(imageUrl, 'image');
  } else if (imageUrl) {
    console.warn(`[pdp] Skipping preload of invalid image URL: "${imageUrl}"`);
  } else {
    console.warn('[pdp] No image URL to preload (empty/null)');
  }
}

await initializeDropin(async () => {
  // Inherit Fetch GraphQL Instance (Catalog Service)
  setEndpoint(CS_FETCH_GRAPHQL);

  // Preload PDP assets immediately when this module is imported
  preloadPDPAssets();

  // Fetch product data
  const sku = getProductSku();
  const optionsUIDs = getOptionsUIDsFromUrl();

  // If we cannot find a sku, and we are not in UE, there's a problem.
  if (!sku && !IS_UE) {
    return loadErrorPage();
  }

  const [product, labels] = await Promise.all([
    fetchProductData(sku, { optionsUIDs, skipTransform: true }).then(preloadImageMiddleware),
    fetchPlaceholders('placeholders/pdp.json'),
  ]);

  const langDefinitions = {
    default: {
      ...labels,
    },
  };

  const models = {
    ProductDetails: {
      initialData: { ...product },
    },
  };

  // Initialize Dropins
  return initializers.mountImmediately(initialize, {
    sku,
    optionsUIDs,
    langDefinitions,
    models,
    acdl: true,
    persistURLParams: true,
  });
})();

async function preloadImageMiddleware(data) {
  const image = data?.images?.[0]?.url?.replace(/^https?:/, '');

  if (image) {
    let url = image;
    let imageParams = {
      ...IMAGES_SIZES,
    };
    if (isAemAssetsEnabled) {
      url = tryGenerateAemAssetsOptimizedUrl(image, data.sku, {});
      imageParams = {
        ...imageParams,
        crop: undefined,
        fit: undefined,
        auto: undefined,
      };
    }
    await UI.render(Image, {
      src: url,
      ...IMAGES_SIZES.mobile,
      params: imageParams,
      loading: 'eager',
    })(document.createElement('div'));
  }
  return data;
}
