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
  Every hour it sends the email digests that are due (`sendDigests`).
- `src/auth.js`: verifies Cloudflare Access's JWT on every request. Parents
  (the `PARENT_EMAILS` Worker secret) can change things; everyone else Access
  lets in can only look. With families (the `FAMILIES` Worker secret), a
  parent can change only the art of the kids in their own families and kids
  in no family (`canChangeKid`), and a kid who's an artist can add their own
  art and change only the pieces they added (`isArtistOf`). A kid's own
  addresses (their artist address and `devices`) are that kid's for comments
  and stickers (`kid`, `kidAddresses`); everyone else's names come from the
  `NAMES` Worker secret (`readNames`), one or more people per sign-in
  address, and a parent can go by another name ("Mom") on their own
  family's kids' art, the same to everyone. Someone in no family can be
  shown only some families (the `SEES` Worker secret, `readSees`), and
  `canSee` is the one rule for who sees which kids. The owners (the
  `ADMINS` Worker secret, `readAdmins`, each one a parent) can view the
  fridge as anyone else (`viewable`, `viewedAs`). It fails closed: with
  no Access settings, or a `FAMILIES` or `SEES` it can't read, nobody gets
  in; with a `NAMES` it can't read, comments are off; with an `ADMINS` it
  can't read, nobody can view as anyone.
- `migrations/`: D1 schema. Add a new numbered file; never edit one that has
  been deployed.
- `public/`: the page. Plain HTML, CSS and JavaScript modules, with no build
  step and nothing loaded from other sites (the Worker's Content Security
  Policy allows only this origin). The fonts are in `public/fonts/` with
  their licences.
- `public/notes.js` and `public/digest.js`: what each notification says,
  and the email digest made of them (subject, HTML and text). The page,
  the Worker (which imports them) and the tests run the same code, so the
  bell, See it and the email always agree. They touch neither the page nor
  the Worker.
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
  makes up the kids, the art, its drawings, comments, stickers,
  notifications and email settings, and refuses every change (the page keeps what's added
  there to itself); `wrangler.toml` gives it no bindings. It's seen as a
  parent in the first family, or, from a page opened with `?as=` (its
  strip's links), as another made-up person: a grandparent, Nonna (who sees
  only that family), a kid's iPad or an artist. The page's requests carry
  that address as their Referer; nothing is remembered. The parent is an
  owner, and `?view=` is them viewing as one of its people, in place of the
  real Worker's cookie. `.github/workflows/preview.yml`
  deploys one per pull request and deletes it when the pull request closes.
- `scripts/fridge.py`: the import script, a uv script run on a parent's
  computer. It signs in with `cloudflared` as that parent.
- `tests/`: `worker.test.js` runs the Worker against local D1 and R2
  (wrangler's `getPlatformProxy`) with Access tokens it signs itself, and an
  email binding that keeps what it's sent; `digest.test.js` checks the
  email's words and layout;
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
`NAMES`, `SEES`, `ADMINS`, `KID_NAMES`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`,
`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `DIGEST_FROM`, `DIGEST_TO`), and the email around it:
the domain onboarded for Email Sending and the verified destination
addresses. Keep addresses out of `wrangler.toml` (no
`allowed_destination_addresses`): who gets email is the people's choice,
in the bell, among the people infra lets in. Don't add `routes` to `wrangler.toml` (that would
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
- Who sees what: everyone sees every kid, except someone `SEES` lists, who
  sees only the kids in those families (not another family's, nor a kid in
  no family). Only people in no family can be limited: parents and kids
  always see everything. `canSee` in `auth.js` is the one place that
  decides; every route that shows or changes a kid, a piece, a picture, or
  a comment or sticker on one goes through it (`seenKids`, `seenPiece`,
  `pieceOwner`, `kidById` in `worker.js`), and so must anything new that
  tells someone about them, like notifications. A piece someone doesn't
  see answers exactly as one that isn't there (a 404 where a piece is
  named, nothing in a list), never with a 403 that says it exists. To
  them, everyone in only the families they don't see, and anyone whose
  name has the name of a kid they don't see in it, is `FAMILY` ("Family"),
  never their name (`namesFor`). Test every route as someone limited.
- Comments and stickers (`talk()` in `worker.js`) are for everyone signed
  in, on any piece they see. Authors edit and delete their own comments; a parent can
  also remove (never reword) any comment on art they could change
  (`canChangeKid`); a sticker is taken back only by whoever gave it. On a
  sign-in two people share, each comment and sticker says which of them
  it's from (`as`, one of its `NAMES`), and either can do what the other
  can. The Worker tells the page what each person may do (`mine`,
  `can_remove`), and sends names (`namesFor`), never addresses. Names come
  only from infra (`NAMES`, `FAMILIES`): don't add a route that sets them.
  Comments and stickers are deleted with their piece. Keep the limits (500 characters, 10 comments in 10 minutes, 200 a
  piece) in the Worker.
- Notifications (`notifications()` in `worker.js`, the bell in `app.js`)
  are worked out from the art, comments and stickers each time they're
  asked for, under the same rules as everything else, so they go when
  their piece, comment or sticker does. Nothing is stored but how far each
  sign-in has caught up (`people.seen_at`), which the walls' New marks go
  by too: don't add a second "seen". They're only about kids someone sees
  (`canSee` in `auth.js`), so no notification, count or link gives away a
  piece or kid they couldn't open. Names only, never addresses, even in
  a notification's `key`. Only what's from before the current second is
  listed, so catching up to `as_of` never passes over something unlisted.
  While an owner views as someone, the bell is that person's, and nothing
  catches them up: the page doesn't try, and `readOnly` would refuse it.
- The email digest (`sendDigests` in `worker.js`, `digestMail` in
  `public/digest.js`) is someone's notifications (`notifications()`),
  worked out when it goes, so it follows the same rules: only kids they
  see, names (`namesFor`) and never addresses, in the subject, the HTML,
  the text and the pictures alike. Nothing is stored but each sign-in's
  settings and how far its last one got (`people.digest`, `digest_hour`,
  `digest_zone`, `digest_at`, and `digest_error`, whether Cloudflare last
  refused their address for want of the Verify click): don't add a second
  "seen". Nobody gets one without the `EMAIL` binding and `DIGEST_FROM`;
  never a kid's devices; only the owners while `DIGESTS` is `"owners"`, and
  the owners and whoever infra's `DIGEST_TO` lists (`readDigestTo` in
  `auth.js`, failing closed to the owners) while it's `"listed"`. Never (in the bell) is
  always allowed and is how it stops: don't add an unsubscribe route that
  skips `auth.js`. The test (`POST /api/digest`) is the owners' only, and
  changes nothing. The pictures go as they are (`ArrayBuffer`), so a run
  costs the Worker almost no CPU, and each email is marked done as soon as
  it's gone, so a run cut short leaves the rest for the next hour.
- View as (`viewAs` in `worker.js`) is for the owners only (`isOwner`):
  anyone else's cookie counts for nothing, and the list of people
  (`/api/view-as`) goes to nobody else. The person viewed's `who` is the
  one they'd get signing in themselves (`viewedAs`), so every route and
  `canSee` treat it as theirs; never special-case it in a route. While
  it's on, `readOnly` refuses every change before any route runs, and the
  importer's routes, so nothing about the person viewed is written; the
  only change that goes through is stopping (`DELETE /api/view-as`). A
  new route that writes on a `GET` would break that: don't add one. The
  page hides what would change things (`VIEWING` in `app.js`), and
  doesn't mark anything seen.
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
