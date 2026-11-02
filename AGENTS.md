# Tenant PWA wrapper

This repository contains a generated static frontend only. Shared application code,
API functions, database migrations, and scheduled jobs live in ivailo-iliev/pretty-pencil.
Regenerate public/ using that repository's scripts/package-frontends.mjs; do not
fork the shared admin application or add backend secrets here. Preserve the existing
manifest install identities, icons, personal-link paths, and same-origin worker.

Keep CI job `quality`. Run typecheck, test:unit, build and test:pwa for code changes.
The browser suite uses actual Apache .htaccess routing plus the pinned remote assets.
No production credentials or business-data writes are needed by wrapper tests.

Publish changes in a PR and obtain independent review of the exact head SHA and
passing quality check before merging. Production cutover additionally requires the
owner's explicit authorization and the Pretty Pencil plan's data reconciliation.
Preserve source history, prior deploys, and the source database for rollback.
