const HERO_WIDTHS = [750, 1200, 1600, 2000, 2800, 3840];

/**
 * Hero block: full-width banner. The default AEM picture tops out at 2000px, which looks soft on
 * wide or high-density screens, so offer a full srcset and let the browser pick.
 * @param {Element} block The block element
 */
export default function decorate(block) {
  const picture = block.querySelector('picture');
  const img = picture?.querySelector('img');
  if (!img) return;

  const url = new URL(img.getAttribute('src'), window.location.href);
  if (!url.pathname.includes('/media_')) return;

  const rendition = (width) => {
    const u = new URL(url.pathname, url.origin);
    u.searchParams.set('width', width);
    u.searchParams.set('format', 'webply');
    u.searchParams.set('optimize', 'medium');
    return u.pathname + u.search;
  };

  picture.querySelectorAll('source').forEach((source) => source.remove());
  img.srcset = HERO_WIDTHS.map((w) => `${rendition(w)} ${w}w`).join(', ');
  img.sizes = '100vw';
  img.src = rendition(2000);
  img.fetchPriority = 'high';
}
