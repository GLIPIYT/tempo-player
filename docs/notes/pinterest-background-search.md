# Pinterest background search

Research and live checks: 28 September 2026.

## API credentials

Pinterest's official API uses OAuth access tokens. An application needs an app ID and app secret, access approval, and an access token with the scopes required by its endpoint. These are not interchangeable with a simple public image-search API key.

- `GET /v5/search/pins` searches the operation account's Pins, normally the account represented by the token. It is not a global image search.
- `GET /v5/search/partner/pins` provides search by term but is a restricted beta endpoint, unavailable to many apps; the documented response has up to ten top Pins. It requires OAuth with `boards:read` and `pins:read`.
- The official API is therefore not an automatic global-search substitute obtained by registering any ordinary API token.

Sources: [Pinterest's OpenAPI specification](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml), [authentication and authorization](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/), [connect an app](https://developer.pinterest.com/docs/getting-started/connect-app/).

## Working guest route

Tempo uses public website search through `BaseSearchResource`, without an API key or an account login. This is an unofficial website endpoint and may stop working when Pinterest changes it or restricts guest access.

The verified request sequence is:

1. Request `https://www.pinterest.com/search/pins/?q=landscape+wallpaper` in a new anonymous session. The HTML itself contains a shell with empty `pins` and `resources`; incidental `pinimg` URLs in that shell are not search results.
2. Reuse only the cookies Pinterest issued to that new anonymous session in a `BaseSearchResource/get/` request. Use the website's `source_url`, JSON `options`, and ordinary resource headers: `X-Requested-With: XMLHttpRequest`, `X-Pinterest-AppState: active`, `X-Pinterest-PWS-Handler: www/search/[scope].js`, `X-Pinterest-Source-Url`, and the matching `Referer`.
3. Read actual Pins from `resource_response.data.results`. The server supplies original image URLs, thumbnail variants, dimensions, pin IDs, and a next-page bookmark.

The first incomplete resource request returned HTTP 403 (`Invalid Resource Request`). The correctly formed guest request returned HTTP 200. No account cookies, CAPTCHA solver, or challenge bypass was used.

Live results for `landscape wallpaper`:

| Check | Result |
| --- | --- |
| Page one | HTTP 200, 23 Pins, about 198 KB JSON |
| Page two with returned bookmark | HTTP 200, 25 Pins, about 172 KB JSON |
| Duplicate IDs between those pages | 0 |
| Page-one Pins with original URL and dimensions | 23 |
| Page-one landscape images at least 1280 × 720 | 10 |
| First thumbnail | HTTP 200, JPEG, about 20 KB |
| First original image | HTTP 200, PNG, 1672 × 941, about 1.87 MB |

These observations depend on the network, Pinterest's guest access, and current ranking. They are not a result-count or availability guarantee.

## Implementation constraints

`src-tauri/src/pinterest_backgrounds.rs` keeps anonymous cookie jars and pagination in memory. There are at most eight search sessions, each expires after ten minutes, and a search has at most ten sequential pages. Bookmarks come from the server; repeated pages reuse cached results. A late response cannot add its page to a replaced session. Concurrent requests for the same page return the winning cached images and that page's own cursor.

The response includes `images`, `page`, and `hasMore`. Filtering every image out of a page does not terminate pagination when Pinterest provides a valid next bookmark. Requested page size is a server hint: Tempo returns the full matched server page, rather than discarding images that the next cursor would skip. Raw pages over 100 entries fail explicitly. A failed request or changed response format invalidates only that guest session generation, so a restarted search creates a fresh anonymous session.

Each request has a fifteen-second timeout, a six-second connection timeout, a four-megabyte response cap, and HTTPS redirects restricted to Pinterest's search host. Search results accept only validated numeric pin IDs and JPEG/PNG images on `i.pinimg.com`; dimensions must pass Tempo's selected minimum and orientation. Ads and unsupported media are omitted. No cookies or tokens are written to logs or repository files.

Pinterest has no equivalent to Wallhaven's exact category or color parameters in this guest contract. Tempo adds semantic terms such as `anime`, `people`, or a color name to the query; minimum dimensions and orientation are applied exactly to returned image metadata. Pinterest also has no supported adult-content filter here. The provider should keep the 18+ control disabled and search public general content.

On access denial, rate limiting, or a changed schema, Tempo reports the provider error. It does not silently substitute a different provider or static sample images.
