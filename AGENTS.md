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
- family email addresses and who's in which family (they live in
  mwarkentin/infra's `fridge_people.auto.tfvars`, which is private)

Tests and examples use made-up names (Ada and Bo, and Cy and Dee in a second
family; families like the Pines and the Oaks) and `example.com` addresses.
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
  lets in can only look. With families (the `FAMILIES` Worker secret), a
  parent can change only the art of the kids in their own families and kids
  in no family (`canChangeKid`), and a kid who's an artist can add their own
  art and change only the pieces they added (`isArtistOf`). A kid's own
  addresses (their artist address and `devices`) are that kid's for comments
  and stickers (`kid`, `kidAddresses`). It fails closed: with no Access
  settings, or a `FAMILIES` it can't read, nobody gets in.
- `migrations/`: D1 schema. Add a new numbered file; never edit one that has
  been deployed.
- `public/`: the page. Plain HTML, CSS and JavaScript modules, with no build
  step and nothing loaded from other sites (the Worker's Content Security
  Policy allows only this origin). The fonts are in `public/fonts/` with
  their licences.
- `public/add/`: Add art, loaded when a parent opens it. `sheet.js` takes
  several photos, scans and PDFs at once, shows a card per piece to check,
  then uploads them one by one. `names.js`, `ids.js`, `pages.js` and
  `exif.js` guess dates and titles, name pieces (`source_hash`), find blank
  pages and read photo dates exactly as `scripts/fridge.py` does, so neither
  adds what the other already has. Change them together: `tests/test_add_art.py`
  runs both on the same files.
- `public/pdfjs/`: a pinned copy of pdf.js, for PDFs in Add art. See "pdf.js"
  below.
- `preview/`: a public preview of the page for pull requests. `worker.js`
  makes up the kids, the art, its drawings, comments and stickers, and
  refuses every change (the page keeps what's added there to itself);
  `wrangler.toml` gives it no bindings. `.github/workflows/preview.yml`
  deploys one per pull request and deletes it when the pull request closes.
- `scripts/fridge.py`: the import script, a uv script run on a parent's
  computer. It signs in with `cloudflared` as that parent.
- `tests/`: `worker.test.js` runs the Worker against local D1 and R2
  (wrangler's `getPlatformProxy`) with Access tokens it signs itself;
  `preview.test.js` checks the preview; `families.test.js` checks how the
  page groups, orders and colours the kids by family (`public/families.js`);
  `add-art.test.js` checks Add art's modules and the copy of pdf.js;
  `test_fridge.py` tests the import script; `test_add_art.py` runs Add art's
  modules (in Node, through `browser_side.mjs`) and the script on the same
  files and checks they agree.

## Stay in this repo's lane

mwarkentin/infra (`fridge.tf`) owns everything around the Worker: the
`fridge-art` bucket, the `fridge` database, the Access application and its
policies, the custom domain, the deploy token, and this repo's Actions
secrets and variables (`CLOUDFLARE_API_TOKEN`, `PARENT_EMAILS`, `FAMILIES`,
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
- The kids come only from `FAMILIES`, which infra writes from its
  `fridge_people.auto.tfvars`: the Worker adds and updates them to match
  (`syncKids`), and a kid's family is the one listing them. Don't add a
  route that adds or changes kids.
- Every change to a piece checks the rules in the Worker (`mayAddFor`,
  `mayChange`): a parent can change a kid's pieces when the kid is in one
  of their families or in none, and an artist can add their own art and
  change only the pieces they added. Moving a piece to another kid needs
  rights over both. The page mirrors the rules (`canAddFor` and
  `canChangePiece` in `app.js`) only to hide what the Worker would refuse;
  the Worker decides. The importer's routes are for parents only.
  Skips (`/api/skipped`) are fingerprints only, so any parent can record
  them.
- Comments and stickers (`talk()` in `worker.js`) are for everyone signed
  in, on any piece. Authors edit and delete their own comments; a parent can
  also remove (never reword) any comment on art they could change
  (`canChangeKid`); a sticker is taken back only by whoever gave it. The
  Worker tells the page what each person may do (`mine`, `can_remove`), and
  sends names (`namesFor`), never addresses. They're deleted with their
  piece. Keep the limits (500 characters, 10 comments in 10 minutes, 200 a
  piece) in the Worker.
- Escape everything that came from the database before putting it in HTML
  (`esc()` in `app.js`), comments and names included.
- The preview Worker never gets a binding, a sign-in or anything real:
  everything on it is made up in `preview/worker.js`. Its workflow holds the
  deploy token, so it runs from main (`pull_request_target`) and copies a
  branch's `public/` and `preview/worker.js` as plain files. Never make it
  run a branch's code (`npm`, scripts, a build, the branch's config).
- Pin everything: exact versions in `package.json`, `pyproject.toml` and
  the script's header (a test checks the last two match), and commit SHAs
  for actions. Dependabot proposes updates, except for pdf.js (below).
- Phone and iPad first: usable at 375px wide, inputs at 16px or larger, and
  light and dark themes.

## pdf.js

Add art reads PDFs with pdf.js (Apache-2.0), copied into `public/pdfjs/`
with its licence beside it: `pdfjs-dist@6.5.438`, the legacy build, which
works on older iPhones and iPads than the modern one. It loads only when a
PDF is chosen (`public/add/pdf.js`). `public/add/pdf.js` runs it without
WebAssembly or eval (`useWasm: false`, `disableFontFace: true`), so its JBIG2
and JPEG 2000 decoders are the plain JavaScript ones in `public/pdfjs/wasm/`
and the Worker's Content-Security-Policy needs nothing new. Keep it that way:
never add `'unsafe-eval'` or another host to the policy for it.

Dependabot doesn't see it, so update it by hand, to a version at least two
weeks old. From the repo, with the new version in `v`:

```sh
v=6.5.438
tmp=$(mktemp -d)
(cd "$tmp" && npm pack "pdfjs-dist@$v" && tar xzf "pdfjs-dist-$v.tgz")
cp "$tmp"/package/legacy/build/pdf.min.mjs "$tmp"/package/legacy/build/pdf.worker.min.mjs "$tmp"/package/LICENSE public/pdfjs/
cp "$tmp"/package/wasm/{jbig2,openjpeg}_nowasm_fallback.js "$tmp"/package/wasm/LICENSE_{JBIG2,OPENJPEG,PDFJS_JBIG2,PDFJS_OPENJPEG} public/pdfjs/wasm/
```

`npm pack` only downloads the package; nothing in it runs. Then put the new
version here and in `tests/add-art.test.js`, run the tests, and in
`npm run dev` add a PDF of several pages with Add art, watching the browser's
console for errors and Content-Security-Policy reports.

## Before pushing

```sh
npm ci && npm test
uv run --locked pytest
```

## Commits

Say what changed and why, and include the URL of the agent session behind
it. Never name a kid.
