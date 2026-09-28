# Wallpaper search in Tempo

Updated: 28 September 2026.

## Providers and credentials

| Provider | Current implementation | Credentials | Native filters |
| --- | --- | --- | --- |
| Wallhaven | Public API v1 | No key for SFW. NSFW requires an API key. | Category, color, minimum dimensions, orientation, page, exact purity. |
| Pinterest | Public website guest search with its own anonymous session | No API key or user login for the verified guest route. | Search text, local minimum dimensions and orientation. No exact category, color or adult-content filter. |
| Konachan | Public `konachan.net/post.json`; SFW by default, optional explicit-only toggle | None for read-only search. | Tags, minimum dimensions, local orientation and page. No dedicated color filter. |

Safebooru is not included. Commons and Art Institute are removed from the search UI; previously selected backgrounds remain usable.

[Wallhaven API documentation](https://www.whvn.cc/help/api) documents 24 results per page and a limit of 45 API calls per minute. Requests pass the key through `X-API-Key`, not the URL, and explicitly set purity and categories so account defaults do not silently change filters. The documented rate limit does not identify whether its bucket is per IP, account or key.

[Konachan API documentation](https://konachan.net/help/api) describes public GET searches, tags, pagination and a maximum of 100 posts per request. Tempo uses its safe domain, defaults to safe images, and offers an 18+ toggle for explicit-rated images only. Search text cannot override the selected rating. Color search is tag-based; there is no dedicated dominant-color filter. Unsupported Wallhaven filters are not shown for this provider.

Pinterest's guest endpoint is unofficial and may change or stop accepting anonymous searches. Its official API uses OAuth with an app ID, app secret and endpoint-specific scopes. Official account Pin search is not global catalogue search; the global partner search endpoint has restricted beta access. See the [Pinterest implementation note](../../notes/pinterest-background-search.md), [official OpenAPI specification](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml) and [OAuth documentation](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/).

## Local and CI configuration

Create `.env` at the repository root using `.env.example` and set:

```dotenv
WALLHAVEN_API_KEY=your_key
```

The real `.env` is ignored by Git. Rust's build script reads the value; a build environment variable takes precedence over the file. Do not use a `VITE_` variable: those values become part of frontend assets. Changing `.env` triggers a rebuild.

GitHub's release workflow accepts the optional repository Actions secret `WALLHAVEN_API_KEY`. That secret must be configured separately for a GitHub-built release to include authenticated Wallhaven access. Adding the workflow reference does not create or transmit a repository secret.

A key included in a desktop executable can be recovered from that executable. `.env` keeps it out of source control; it does not make a shared client credential secret. A server would be required to keep a shared key away from clients.

## Interface

The background settings contain three provider tabs, a search row, provider-specific categories and color swatches, a compact content filter, and a three-column image grid. Cards show the apply button and dimensions on hover or keyboard focus; touch devices retain an accessible apply action. Resolution and orientation live in a compact filter popover. The existing selected-background preview remains the place to adjust blur and dimming.

Search pages expose an explicit next-page flag. Filtering out all images on one page must not hide subsequent provider pages. Pinterest cursors are cached with the corresponding results, and concurrent replies must use the canonical cached page.

Failed direct thumbnails retry through the native provider-specific image loader. Image URLs and redirects are restricted to provider CDNs; downloaded images are bounded, decoded and resized before local storage.

## Verified network observations

Only SFW requests were used during development. Results depend on the network and the services' current catalogue.

- Wallhaven search returned HTTP 200 and 24 entries. Portrait search returned 24 portrait entries. Configured-key authentication through `X-API-Key` returned 200; an invalid key returned 401. Thumbnail JPEG and original PNG URLs returned 200.
- Konachan's safe search and minimum-size query returned 200; preview and JPEG source URLs returned 200.
- Pinterest's correctly formed guest request returned 200 with 23 Pins on page one and 25 on page two, with no overlapping IDs. Its first tested preview and original image returned 200. See the linked Pinterest note for query and dimensions.

Manual interface checking is left to the user at their request.
