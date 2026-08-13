# YoussHub

A personal download hub: one white page with a neural graph on it. Youss is the
centre node, each project branches off him, and clicking a node opens a small
card with that project's download.

Everything lives in `index.html` — markup, styles and script. No build step, no
dependencies, no package manager. Double-click the file to open it locally, or
drop it at the root of any static host.

## Adding or editing a project

Edit the `PROJECTS` array at the top of the `<script>` block in `index.html`.
That is the only thing you ever need to touch — positions, edges, labels and
cards are all derived from it.

```js
{
  id: "debloat",        // stable key; also seeds this node's position
  name: "Debloat",      // node label and card title
  tagline: "Strip Windows down to what you actually use.",
  kind: "exe",          // "exe" | "web" | "soon"
  version: "1.0.0",
  size: "4.2 MB",
  url: "https://github.com/…/releases/download/v1.0.0/Debloat-Setup.exe",
  updated: "Aug 2026"
}
```

- **Any field left as `""` is simply not rendered.** No blank rows, no "n/a".
- **`kind` decides the button.** `exe` gets a *Download .exe* link, `web` gets an
  *Open app* link that opens in a new tab, and `soon` draws a dashed node with a
  `soon` tag and a card that just says it's in development.
- **`url` for an `exe` must be a direct-download link** — a GitHub Releases asset
  URL is the intended source. A page that merely *links* to the installer will
  open in the browser instead of downloading.
- **While `url` is `""`,** the button renders disabled as *link coming*, so it is
  safe to add a project before its installer exists.
- **`version` and `size` are never shown for `web` projects**, even if filled in.
- **Changing an `id` moves that node**, since the layout jitter is seeded from it.
  Rename freely, but expect the graph to reshuffle.

Adding a fifth project just works — nodes are distributed around the circle from
the array length. Order in the array sets the order around the graph, going
clockwise from the upper right.

**Don't commit the `.exe` files to this repo.** They belong on GitHub Releases;
this page only links out to them. The whole deployment should stay a few KB.

## Deploying

The site is a single static file at the repo root, so Vercel serves it as-is:

1. Import the repository at [vercel.com/new](https://vercel.com/new).
2. Framework preset **Other**. Leave the build command and output directory
   empty.
3. Deploy. Every push to the default branch redeploys.

There is intentionally **no `vercel.json`** — a bare `index.html` at the root
needs no configuration, and an empty config file would only be noise.

The same file works unchanged on GitHub Pages or Netlify (drop it at the root),
and over `file://` by double-clicking it.
