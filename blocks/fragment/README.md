# Fragment Block

The Fragment block enables reusable content composition by loading and embedding external HTML fragments into pages. It supports dynamic content injection and automatic decoration of loaded content.

## Purpose

Fragments allow modular content authoring by:
- Breaking large pages into smaller, reusable content units
- Loading content from external paths into parent pages
- Automatically decorating and initializing loaded blocks
- Supporting both inline fragments and fragment references

## Configuration

Fragments are configured via `_fragment.json`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | String | Yes | Path to the fragment content relative to the site root |

## Usage

### Via Block

Create a fragment block in your page content:

```
Fragment
/fragments/header-banner
```

The block will load content from `/fragments/header-banner.plain.html` and embed it on the current page.

### Via Link

Fragment references can also be embedded as links:

```html
<a href="/fragments/reusable-section">Load Fragment</a>
```

## Behavior

1. **URL Construction**: Fragment paths are converted to `.plain.html` format
   - Input: `/fragments/my-content`
   - Requests: `/fragments/my-content.plain.html`

2. **Content Decoration**: Loaded fragments are automatically decorated with:
   - Block decoration and initialization
   - Icon decoration
   - Section styling
   - Any custom decorators from the main page

3. **Media Base Path**: Fragment images and media are resolved relative to the fragment's path:
   ```
   Fragment media: ./media_xyz123 
   Resolved to: /fragments/media_xyz123
   ```

4. **Replacement**: The fragment block element is replaced with the fragment's content (not wrapped)

## Error Handling

- **Fragment Not Found**: Returns `null` if the `.plain.html` file doesn't exist or returns non-200 status
- **Network Errors (429)**: Retried with exponential backoff up to 3 times with delays of 100ms, 200ms, 400ms
- **Failed Loads**: Logged to console but don't block page rendering

### Retry Logic

Network requests that return 429 (Too Many Requests) are automatically retried with exponential backoff:
- Initial delay: 100ms
- Max delay: 5 seconds
- Max attempts: 3 retries
- Respects Retry-After headers if provided

## Files

- `fragment.js` - Block decoration and loading logic
- `fragment.css` - Optional styling
- `_fragment.json` - Block model configuration
- `README.md` - This file

## Technical Details

- Fragments are loaded via `fetchWithRetry()` which handles rate limiting gracefully
- Content is parsed and decorated before insertion
- Fragment paths must be absolute (start with `/`)
- Fragment filenames cannot contain double slashes (`//`)
