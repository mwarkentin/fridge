# AGENTS.md

The fridge: a private gallery of the kids' scanned art, served by one
Cloudflare Worker behind Cloudflare Access. README.md explains how it fits
together and how to set it up.

## This repo is public. The family isn't.

The code is public; everything about the family lives in Cloudflare, behind
the sign-in. Keep these out of every file, test, fixture, screenshot, issue,
pull request and commit message:

- the kids' names, birthdays, ages or school details
- scans or photos of their art (tests make their own images)
- Dropbox paths, which contain the kids' names
- family email addresses (they live in mwarkentin/infra's `FRIDGE_PEOPLE`
  secret)

Tests and examples use made-up names (Ada, Bo) and `example.com` addresses.
CI's privacy job fails on pictures outside `public/icons/` and on any of the
real names (from the `KID_NAMES` secret) in files, file names, commit
messages or pull request text. Its log masks the names as `***`. If it
fails, fix the commit itself: rewrite the branch before merging, because
history on `main` is permanent.

## Layout

- `src/worker.js`: the Worker. Serves the app icons to anyone, checks the
  sign-in for everything else, then serves the API
  (`/api/...`), the images (`/img/<id>/thumb|display|original`, from the
  `ART` bucket) and the page (`public/`, through the `ASSETS` binding).
- `src/auth.js`: verifies Cloudflare Access's JWT on every request. Parents
  (the `PARENT_EMAILS` Worker secret) can change things; everyone else Access
  lets in can only look. It fails closed: with no Access settings, nobody
  gets in.
- `migrations/`: D1 schema. Add a new numbered file; never edit one that has
  been deployed.
- `public/`: the page. Plain HTML, CSS and JavaScript modules, with no build
  step and nothing loaded from other sites (the Worker's Content Security
  Policy allows only this origin). The fonts are in `public/fonts/` with
  their licences.
- `preview/`: a public preview of the page for pull requests. `worker.js`
  makes up the kids, the art and its drawings, and refuses every change;
  `wrangler.toml` gives it no bindings. `.github/workflows/preview.yml`
  deploys one per pull request and deletes it when the pull request closes.
- `scripts/fridge.py`: the import script, a uv script run on a parent's
  computer. It signs in with `cloudflared` as that parent.
- `tests/`: `worker.test.js` runs the Worker against local D1 and R2
  (wrangler's `getPlatformProxy`) with Access tokens it signs itself;
  `preview.test.js` checks the preview; `test_fridge.py` tests the import
  script.

## Stay in this repo's lane

mwarkentin/infra (`fridge.tf`) owns everything around the Worker: the
`fridge-art` bucket, the `fridge` database, the Access application and its
policies, the custom domain, the deploy token, and this repo's Actions
secrets and variables (`CLOUDFLARE_API_TOKEN`, `PARENT_EMAILS`,
`KID_NAMES`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN`). Don't add `routes` to `wrangler.toml` (that would
take the domain from infra), and keep `workers_dev` and `preview_urls` off,
since Access doesn't guard those addresses. The previews are public on
workers.dev only because they're a separate Worker with nothing real on it.

## Rules

- Every request is checked in `auth.js` before anything else. Don't add a
  route that skips it. The one exception is the app icons
  (`/icons/<name>.png|svg`, `GET` and `HEAD` only): iOS fetches Home Screen
  icons without the sign-in cookie, and they're public in this repo anyway.
  Infra's Access settings bypass that path to match. Nothing else goes in
  `public/icons/`.
- Changes (`POST`, `PATCH`, `DELETE`) need `X-Requested-With: fridge`, so
  another site can't send them with a family member's sign-in.
- Escape everything that came from the database before putting it in HTML
  (`esc()` in `app.js`).
- The preview Worker never gets a binding, a sign-in or anything real:
  everything on it is made up in `preview/worker.js`. Its workflow holds the
  deploy token, so it runs from main (`pull_request_target`) and copies a
  branch's `public/` and `preview/worker.js` as plain files. Never make it
  run a branch's code (`npm`, scripts, a build, the branch's config).
- Pin everything: exact versions in `package.json`, `pyproject.toml` and
  the script's header (a test checks the last two match), and commit SHAs
  for actions. Dependabot proposes updates.
- Phone and iPad first: usable at 375px wide, inputs at 16px or larger, and
  light and dark themes.

## Before pushing

```sh
npm ci && npm test
uv run --locked pytest
```

## Commits

Say what changed and why, and include the URL of the agent session behind
it. Never name a kid.
