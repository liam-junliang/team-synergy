# UA reader adapter

This directory is the small, reviewable adapter around the upstream UA 2.9.8 dashboard. The renderer, layouts, structural/domain navigation, sidebar, search, tours, themes and filters come from upstream; the platform does not reimplement those features.

Build from an already installed upstream checkout, without installing packages or editing that checkout:

```powershell
node scripts/build-ua-reader.mjs --source F:/workspace/team-synergy-labs/code-understanding-20261027/understand-anything-tool
```

The script copies source to an ignored, unique `tmp` shadow directory, links its dependency directory to the existing upstream installation, applies explicit guarded patches, and bundles the reader into `apps/web/public/vendor/ua-reader/2.9.8/reader.js` and `reader.css`. It emits version/source/build provenance, asset hashes and bundled-package license notices. A changed upstream version fails rather than silently applying patches to incompatible code.

The parent inlines the trusted JS and CSS into an opaque-origin iframe with `sandbox="allow-scripts"`, setting `window.__TSP_UA_CHANNEL__` to a fresh random channel before executing the reader. Escape closing script/style delimiters when constructing `srcDoc`. No access token or service URL is passed to the reader.

Messages must have the matching `channel`. The child accepts only messages whose `source` is its parent:

* Parent → child `tsp.ua.load`: `graph`, optional `domain_graph`, optional `selected_node_id`, `locale`.
* Parent → child `tsp.ua.select`: `node_id` or `null`; this does not echo a selection event.
* Child → parent `tsp.ua.ready` and `tsp.ua.loaded` (node counts).
* Child → parent `tsp.ua.select`: `node_id` or `null`.
* Child → parent `tsp.ua.evidence`: `node_id`, relative `path` or `null`.
* Child → parent `tsp.ua.error`: graph validation error `message`.

The parent must also verify the iframe window, its opaque `null` origin, channel and selected run before handling messages. It authenticates and authorizes API reads itself, passes only sanitized UA graph metadata, resolves selected IDs against that graph, and retrieves codegraph relations/evidence through the existing platform API.

The shadow adapter exports `DashboardContent` and bypasses upstream token/network loaders. It disables first-run browser-storage onboarding, replaces persistent theme settings with iframe-memory state, replaces the full-source viewer with an evidence action, hides downloads unsupported by the sandbox, and omits the separate wiki graph renderer. It initializes UA's native Light Minimal theme with a teal accent and sans-serif headings before the loading screen is painted. Native theme controls remain available, and a selection persists for the lifetime of this reader iframe. The structural/domain renderer has no external layout worker. No full source, local filesystem path, credential or arbitrary code is accepted through the protocol.

License files in the generated vendor directory describe the bundled upstream and third-party components. UA is MIT; the bundle also contains ISC components and ELK under EPL-2.0. These licenses are preserved independently of the platform license.
