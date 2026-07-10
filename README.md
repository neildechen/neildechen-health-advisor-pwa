# Health Advisor — logging PWA

Phone-first gym logging client for a private Google Sheet, served from GitHub Pages.
This repo holds **only the generic app shell** — no endpoint, no token, no health data,
ever. Spec and design cards live in the (private) `gym-programmer` repo; the visual
truth is the Claude Design project "Health Advisor — Logging UI".

## Security model

- On first run the app asks for the Apps Script `EXEC_URL` and `TOKEN` and stores both
  in `localStorage` **only**. They are never committed, never cached by the service
  worker, and never placed in a URL for POSTs.
- GET reads carry the token as a query param over HTTPS — an Apps Script constraint,
  same as every existing caller of this API.
- Rotating the sheet-side token (Sheet ▸ Setup ▸ Set API token…) invalidates every
  device at once.
- Grep discipline: nothing matching the token or `script.google.com/macros` deployment
  path may ever appear in this repo's history.

## Apps Script CORS realities (why the client looks like this)

- **Reads** are plain `GET` — simple requests, no custom headers, no preflight.
- **Writes** are `fetch` POSTs with `Content-Type: text/plain;charset=utf-8` and a JSON
  string body. `application/json` would trigger a CORS preflight that Apps Script
  cannot answer. The server parses `e.postData.contents` and does not gate on MIME.
- **Redirects**: Apps Script 302s to `googleusercontent.com`; `redirect: "follow"` is
  required and browsers switch the redirected POST to GET (that is fine — the write
  already landed at the first hop).
- A large POST can occasionally return an HTML page instead of JSON **after the write
  landed**. The client treats any non-JSON response as "verify by GET": refetch
  `view=open` and reconcile. Never retry blind.

## Files

- `index.html` / `app.css` / `app.js` — the whole app; no framework, no build step.
  `app.css` starts from the design cards' `_shared.css` tokens.
- `sw.js` — caches the shell only; cross-origin (API) requests are not intercepted.
- `manifest.webmanifest` + `icons/` — installable, standalone, slate-blue `#3A66A0`.

## Dev loop

Serve statically (`python3 -m http.server`) and iterate with headless-Chromium
screenshots compared against the design cards — that comparison is the acceptance
mechanism for every UI change.
