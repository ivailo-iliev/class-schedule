# Class Scheduler PWA wrapper

This repository hosts the Class Scheduler frontend. The shared scheduler, admin UI,
API functions, migrations and scheduled keep-alive live in
[Pretty Pencil](https://github.com/ivailo-iliev/pretty-pencil).
The API is https://pretty-pencil.netlify.app.

`public/release.json` pins the shared admin assets to an immutable release with
SHA-384 integrity checks. No per-tenant application build is needed. Icons,
manifest, worker and hosting rules stay on this origin.

The original owl icons and root install identity are preserved. Existing `/access#token`
links boot the shared app on this origin. The same-origin worker replaces the old
Workbox cache and provides an offline notice; it never caches API data or clears
personal credentials. The shared scheduler requires connectivity.

## Verify and host

```sh
npm ci
npm run typecheck
npm run test:unit
npm run build
# Apache 2.4 and Playwright Chromium are needed for the generic-host browser tests.
npx playwright install chromium
npm run test:pwa
```

Netlify builds `dist/` using netlify.toml. There are no local functions. The generated
_redirects preserve historical /api/* URLs through the central service. Netlify
reserves /.netlify/functions/*, so integrations must use the public /api/* contract. No Supabase
keys or privileged environment variables are required on this frontend host.
Remove obsolete site environment variables after the authorized production cutover.

For Apache, enable mod_rewrite/mod_headers and AllowOverride All, serve dist/ over
HTTPS, and keep its .htaccess files. Normal app traffic calls the central API
absolutely. Historical API paths use 307 redirects on Apache; third-party clients
that cannot preserve Authorization across hosts need an HTTPS reverse proxy instead
(e.g. mod_proxy/mod_proxy_http). Never forward API requests to the SPA fallback.
Add any new frontend origin to the central APP_ORIGINS registry before deployment.
Origins control browser transport; they never substitute for authentication.

## Regenerate

Build and deploy a Pretty Pencil release with VITE_API_ORIGIN set to
https://pretty-pencil.netlify.app, then run there:

```sh
node scripts/package-frontends.mjs https://pretty-pencil.netlify.app https://DEPLOY-ID--pretty-pencil.netlify.app
```

Replace public/ with the corresponding artifacts/frontends/ directory (or unpack
its ZIP). Keep both arguments and release.json together. Run this repository's tests
before opening a PR. The wrapper tooling template lives in Pretty Pencil's
frontends/wrapper-template; application fixes belong only in Pretty Pencil.

## Production transition and rollback

Merging this change can trigger production deployment. Obtain owner authorization,
freeze old Class Scheduler writes, import/reconcile the final delta, verify teacher
links and both tenant workflows, and retain the original source database and prior
Netlify deploys. This PR does not perform the data cutover. Do not delete Supabase
projects. The shared project remains the original Figure Skating database. Restore
the prior Netlify deploy or pre-wrapper commit if the release needs rollback.
Only the central project should run scheduled keep-alive after cutover.
