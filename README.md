# The Fridge

A private gallery for the kids' art: every scan hung on one page, sorted by
kid and age, with what they said about each piece, a timeline, "this time of
year", tags to browse by (tap one to see every piece with it, from every
kid), and a slideshow for an old iPad on the counter. Only family can see
it.

## How it works

- **One Cloudflare Worker** serves the page, a small API and the images. The
  page is plain HTML, CSS and JavaScript, with no build step.
- **D1** holds the kids (name and birthday) and each piece's details: when it
  was made, title, what they said, medium, tags, favourite.
- **R2** holds three copies of each piece: the original, a screen-sized JPEG
  and a thumbnail. The copies are made before upload, by the import script or
  the page, so there's no paid image resizing.
- **Cloudflare Access** guards the address. Family members sign in with a
  code emailed to them; the kids' iPads sign in with addresses that deliver
  to a parent and stay signed in for a month. The Worker checks Access's
  token on every request too, and has no workers.dev address, so there's no
  way around the sign-in. Parents can change things; everyone else can look.
  The one thing anyone can fetch is the app icons in `public/icons/`, since
  iOS fetches Home Screen icons without the sign-in. They're in this repo
  for anyone to see anyway.
- **The import script** (`scripts/fridge.py`) reads a folder on your
  computer, like the synced Dropbox folder, works out whose each piece is
  and when it was made from the folder and file names, and uploads it. It
  remembers files by their contents, so running it again adds only new ones.

The bucket, database, sign-in, domain and deploy token are made by
[mwarkentin/infra](https://github.com/mwarkentin/infra) (`fridge.tf`). This
repo deploys the Worker into them.

Nothing about the family is in this repo, which is public. See AGENTS.md.

## Setting it up

1. **Cloudflare Zero Trust:** in the Cloudflare dashboard, open Zero Trust
   and choose the Free plan (up to 50 people). That's a billing choice, so
   it can't be made from code.
2. **mwarkentin/infra:** follow the "fridge" section of its README: token
   permissions, the `FRIDGE_PEOPLE` secret, then merge its pull request.
   That adopts the Zero Trust organization, adds the One-time PIN login,
   makes everything else and fills in this repo's Actions secrets and
   variables.
3. **Deploy:** run the Deploy workflow from this repo's Actions tab (after
   that, every merge to `main` deploys). Then merge the infra change that
   adds the custom domain: it can only point at a Worker that exists.
4. **Add the kids**, from a computer with this repo checked out and
   [uv](https://docs.astral.sh/uv/) and cloudflared installed
   (`brew install cloudflared`):

   ```sh
   uv run scripts/fridge.py login
   uv run scripts/fridge.py add-kid "Name" 2018-03-14
   ```

5. **Import the scans.** Survey a folder first. It works offline, uploads
   nothing, and opens a report with a picture of every page, saying which
   pages are blank, which look like art and which are plain (documents, or
   pencil drawings). Each piece has a box to tick: pages that look like art
   start ticked, plain and blank ones don't, and clicking a picture opens
   the original. Press **Save my picks**, then import with the file it
   saves (named after the folder's last three names). The survey prints the
   exact command:

   ```sh
   uv run scripts/fridge.py survey ~/Dropbox/Kids\ Art --kid Ada
   uv run scripts/fridge.py import ~/Dropbox/Kids\ Art --kid Ada --picks ~/Downloads/fridge-picks-….json --dry-run
   uv run scripts/fridge.py import ~/Dropbox/Kids\ Art --kid Ada --picks ~/Downloads/fridge-picks-….json
   ```

   To skip typing the folders each time, save them once, each with its kid.
   They're kept on your computer only (`fridge.py folders list` says
   where), never in this repo. Then `survey` and `import` with no folder
   work through all of them, with one report (a heading per folder) and one
   picks file:

   ```sh
   uv run scripts/fridge.py folders add ~/Dropbox/Kids\ Art/Ada --kid Ada
   uv run scripts/fridge.py folders add ~/Dropbox/School/Bo --kid Bo
   uv run scripts/fridge.py survey
   uv run scripts/fridge.py import --picks ~/Downloads/fridge-picks-saved-folders.json
   ```

   `folders list` shows them and `folders remove PATH` drops one. Naming a
   folder still works as above, and a saved folder brings its kid.

   Picks name pieces by their contents, so renaming or moving a file
   doesn't lose its pick. Anything added to the folder after the survey is
   skipped (or asked about, with `--ask`); survey again to pick it.

   The fridge remembers both kinds of decision. What's imported is on the
   fridge, and what you leave unticked (or answer "no" to with `--ask`) is
   remembered as skipped, from any computer. So a later survey of the same
   folder shows only what's new, with pieces already on the fridge and ones
   skipped before under **Everything**, and a later import, picks or not,
   leaves skipped pieces out. To import a skipped piece after all, tick it
   in a survey's report (**Skipped before** lists them). `survey --offline`
   doesn't ask the fridge, and shows everything as new.

   Adding new art later is the same loop: scan it into its folder, survey
   (you'll see just the new pieces), tick, save, import. Delete the picks
   file once it's imported: the fridge doesn't need it, and the browser
   would save the next one under another name, such as `… (1).json`.

   A PDF of several pages, as a scanner makes from a stack of pieces,
   becomes one piece per page, leaving out blank pages. `--first-page-only`
   imports each PDF as one piece instead, its first page.

   Whose a piece is comes from a folder (or failing that, file) name
   matching a kid's name; `--kid NAME` covers a folder that's all one
   kid's. When it was made comes from a date in the file or folder name:
   `2024-05-29`, `20240529`, `2024-05`, `May 2024` or `2024`. With none, it
   guesses the month from the photo's data or the file's date, which is
   usually when it was scanned, and the dry run says so. The title is the
   rest of the file name, without the kid's name (or a short form of it of
   four letters or more, like Theo for Theodora) and scanner words. In a
   name with a filing label, like `2024-05-29 Ada Big-Hill Art Bundle
   rocket.pdf`, only what follows "Art Bundle" (or "Bundle") is the title.
   Titles are set when a piece is imported, so check them in the dry run.
   Fix anything wrong on the page afterwards with **Edit details**.

   For a folder that mixes art with other papers (a school folder with
   report cards, say), add `--ask`: it shows each file and asks whether to
   import it, with `o` to open it and look first. Enter means no, so nothing
   goes up by accident.

6. **On each iPad:** open the fridge in Safari, sign in with the kid's
   address and type in the code that arrives in your email. If the kids use
   it from the Home Screen, add it there first (Share, then **Add to Home
   Screen**) and sign in from the icon: the fridge has a web app manifest,
   so the icon opens it as its own app, without Safari's address bar, and
   on iPadOS a Home Screen web app keeps its own cookies apart from Safari.
   Signing in in Safari doesn't sign the icon in, or the other way round.
   The sign-in page is on another address (`<team>.cloudflareaccess.com`),
   so the app may show it with a bar naming that address at the top;
   finish signing in there and it comes back to the fridge. If signing in
   there keeps returning to the sign-in page, use the fridge in Safari
   instead. If Screen Time limits websites, allow the fridge's address and
   your `<team>.cloudflareaccess.com` sign-in page.

   Android phones and desktop Chrome can install it too (**Install app** or
   **Add to Home screen** in Chrome's menu), after signing in.

## Working on it

```sh
npm ci
npm test                      # Worker tests, against local D1 and R2
uv run --locked pytest        # import script tests
```

To run it locally, create `.dev.vars` (git ignores it) with
`DEV_EMAIL=you@example.com` and `PARENT_EMAILS=you@example.com`, then:

```sh
npx wrangler d1 migrations apply fridge --local
npm run dev
uv run scripts/fridge.py --url http://localhost:8787 add-kid Ada 2019-04-02
uv run scripts/fridge.py --url http://localhost:8787 import path/to/some/pictures
```

`DEV_EMAIL` counts only on localhost and is never deployed.

## Previews

Each pull request from a branch in this repo gets a public preview at
`fridge-preview-pr-<number>.<subdomain>.workers.dev`, linked from a comment
on the pull request. It's the branch's page with a made-up family: Ada and
Bo, and drawings that `preview/worker.js` makes up. It has no database,
bucket or sign-in, so there's nothing private on it, and it refuses every
change. It's updated on every push and deleted when the pull request
closes. To make one for a pull request opened before previews existed, run
the Preview workflow from the Actions tab with its number.

To run the preview locally, no `.dev.vars` needed:

```sh
npm run preview               # http://localhost:8787
```

If a kid's name is also an everyday word that turns up in code (Max, say),
the privacy check in CI will flag ordinary lines, and it will need a list of
lines to allow.
