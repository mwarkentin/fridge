# The Fridge

A private gallery for the kids' art: every scan hung on one page, sorted by
kid and age, with what they said about each piece, a timeline, "this time of
year", tags to browse by (tap one to see every piece with it, from every
kid), stickers and comments from the whole family, and a slideshow for an
old iPad on the counter. Only family can see it.

## How it works

- **One Cloudflare Worker** serves the page, a small API and the images. The
  page is plain HTML, CSS and JavaScript, with no build step.
- **D1** holds the kids (name and birthday, kept in step with infra's list
  of them) and each piece's details: when it was made, title, what they
  said, medium, tags, favourite. It also holds the comments and stickers on
  each piece (see [Comments and stickers](#comments-and-stickers)).
- **R2** holds three copies of each piece: the original, a screen-sized JPEG
  and a thumbnail. The copies are made before upload, by the import script or
  the page, so there's no paid image resizing.
- **Cloudflare Access** guards the address. Family members sign in with a
  code emailed to them; the kids' iPads sign in with addresses that deliver
  to a parent and stay signed in for a month. The Worker checks Access's
  token on every request too, and has no workers.dev address, so there's no
  way around the sign-in. Parents can change things (with families set up,
  only their own family's: see [Families](#families)); everyone else can
  look. Someone in no family can be shown only some families' art (see
  [Who sees what](#who-sees-what)). The fridge's owners can look at it as
  anyone else would see it, with nothing to change (see
  [View as](#view-as)).
  The one thing anyone can fetch is the app icons in `public/icons/`, since
  iOS fetches Home Screen icons without the sign-in. They're in this repo
  for anyone to see anyway.
- **The import script** (`scripts/fridge.py`) reads a folder on your
  computer, like the synced Dropbox folder, works out whose each piece is
  and when it was made from the folder and file names, and uploads it. It
  remembers files by their contents, so running it again adds only new ones.
- **Add art**, on the page, is for parents on a phone or iPad, or any
  computer without the import script. It takes several photos, scans and
  PDFs at once, splits a PDF of several pages into a piece per page without
  the blank ones, and guesses dates and titles from file names as the
  import script does. You check a card for each piece before anything goes
  up. It recognises pieces the same way as the import script, so neither
  adds what the other already has. It offers only the kids you can add art
  for (see [Families](#families)); a kid who's an artist uses it for their
  own art.

The bucket, database, sign-in, domain and deploy token are made by
[mwarkentin/infra](https://github.com/mwarkentin/infra) (`fridge.tf`). This
repo deploys the Worker into them.

Nothing about the family is in this repo, which is public. See AGENTS.md.

## Families

The fridge can hold more than one family's kids. Everyone signed in sees
everything (unless they're shown only some families: see
[Who sees what](#who-sees-what)), but a parent can add, edit, favourite and
remove art only for their own family's kids, and change only those kids. A kid in no family is
any parent's to change, as everything was before families. The page shows
each parent only what they can change, and the Worker refuses the rest.

Everything about who's who is in one place: infra's
`fridge_people.auto.tfvars`, which lists each family once, with its name,
its parents and its kids, and each kid with their birthday. Infra hands
this repo `PARENT_EMAILS` (every family's parents), `FAMILIES` (each
family with its parents and kids), `NAMES` (what everyone but the kids
is called beside comments, by sign-in address), `SEES` (who sees only
some families) and `ADMINS` (the owners, who can view the fridge as someone
else) as Actions secrets, and the Deploy workflow gives them to the Worker.

- **The kids** are the ones `FAMILIES` lists. The Worker adds a kid it
  doesn't have yet, and copies over a changed birthday or spelling, the
  next time the page or the import script loads the gallery. A kid renamed
  in the file keeps their art: they're matched by birthday when their old
  name is gone. A kid the file stops listing stays, with their art, in no
  family. Nothing else adds or changes kids, so there's no `add-kid`.
- **A kid's family** is the family the file lists them under.
- **A kid who's an artist** (`artist = true` in the file, with their own
  email) signs in to add their own art, and can edit, favourite or remove
  only the pieces they added. Their parents still look after all of their
  art, including what they add.
- **A kid's devices** (optional, `devices` in `FAMILIES`: the addresses
  their own iPad or tablet signs in with) only look at the art, but their
  stickers and comments are the kid's, with the kid's name and magnet.
  Without them, a kid's iPad is like a grandparent: it picks a name the
  first time it comments, and can't pick the kid's.

To add a kid, change a name or birthday, or move someone between
families, edit infra's file in a pull request, merge it, then run this
repo's Deploy workflow. Without `FAMILIES` there are no families, and
every parent can change everything. Taking a family out of infra's file
does the same for its kids.

## Who sees what

Everyone signed in sees every family's art, unless infra's file says
otherwise. Someone in no family, like grandparents on one family's side,
can be shown only some families: they see those families' kids and art,
and nothing of the rest. Parents and kids always see everything, so only
people in no family can be limited.

For someone shown only some families, the others aren't on the fridge:

- not their kids, nor their art, nor its pictures, at any size, even by a
  picture's own address;
- not the comments and stickers on their art, nor their place in **Latest
  comments** and the **New** counts;
- not the tags only their art has, nor their place on the timeline, in
  "This time of year" or in Frame.

A piece they don't see answers like one that isn't there. With one family
to see, the page shows its kids without family names, like a fridge with
one family.

When someone from a family they don't see (a parent, a kid or a kid's
iPad) comments on art they do see, or gives it a sticker, it says
**Family**, not their name. So does anyone whose name has the name of a
kid they don't see in it ("Cy's Nana"). What a comment says is shown as
it was written, so a comment that names a kid is seen by everyone who sees
the art it's on. Pieces and comments are numbered across the whole fridge,
so the numbers in a picture's address skip the ones they don't see.

Who's shown what comes from infra's file, as `SEES`: each limited sign-in
address with the ids of the families it sees. Missing or empty, everyone
sees everything, as before it. To limit someone, list them in infra's file
as a viewer with the families they see, merge it, then run this repo's
Deploy workflow, and tell them about the fridge only after that: until the
deploy, the fridge doesn't know they're limited.

## Comments and stickers

Everyone signed in can give a piece stickers and comment on it, from the
piece's own page: grandparents, the kids' iPads, the kids and the parents,
on either family's art (any art they see: see
[Who sees what](#who-sees-what)).

- **Stickers** are for kids who can't write yet, and anyone in a hurry: a
  heart, a gold star, a sparkly wow, a smiley and a rainbow. One tap gives
  one, another takes it back. Each person can give each kind once.
- **Comments** are up to 500 characters. A kid's comment is in their own
  handwriting-style bubble, in their colour, and the artist's own say so.
  What the artist said about a piece (set with **Edit details**) stays at
  the top; comments never change it.
- **Names** come from infra's file, like everything else about who's who.
  `NAMES` gives each sign-in address its person ("Grandma"), and a sign-in
  two people share, like grandparents with one email, a person for each.
  On a shared sign-in, the page says who's commenting just above the
  comment box ("Commenting as Grandma · Change"), starting with the first
  person listed. Change picks another, and that device remembers the
  choice; stickers go by it too. A parent can have two names, picked by
  whose art it is: one on their own family's kids' art ("Mom") and one on
  everyone else's ("Aunt Pine"). Everyone sees the same name on a piece,
  the parent included. A kid's own addresses are that kid: their artist
  address, and any `devices` listed for them in `FAMILIES` (see
  [Families](#families)), such as their iPad's. The page only ever gets names, never addresses.
  Nobody can have a kid's name, and no two people share one. Someone `NAMES`
  doesn't list shows as the part of their address before the @.
- **Who can change what.** People edit and delete their own comments (on a
  shared sign-in, either of them can: the fridge can't tell them apart).
  Parents can also remove anyone's comment on art they could change (their
  own family's kids', and kids' in no family), but never reword it. Only
  whoever gave a sticker takes it back. Someone can post 10 comments in 10
  minutes, and a piece holds 200.
- **What's new.** Home's **Latest comments** shows the most recent, marking
  the ones that came in since you last caught up, and each piece on the
  walls shows its comments and stickers, with **New** when someone else
  has commented since then. Frame shows none of it. The bell has what's
  new for you (see [What's new for you](#whats-new-for-you)), and can
  email it too (see [What's new, by email](#whats-new-by-email)).
- Taking a piece off the fridge takes its comments and stickers with it.

## What's new for you

The bell, at the right end of the top bar, has what's new for whoever's
signed in, with a red magnet counting what came since they last looked.
Tap it to see the list, newest first; tap a line to open its piece, at its
comments.

- **New art**, from either family (or only the families you see), unless
  you put it up yourself. A day's
  art by one person for one kid is one line, so an import of forty is one.
- **Stickers and comments on your art, or your kids' art**: a parent's kids
  are the ones they look after (their families', and kids in no family),
  and a kid's art is their own. A day's stickers from one person on one
  piece are one line.
- **Replies**: comments on a piece after you commented on it.
- **A kid's own sign-in** (their artist address, or their iPad's) gets only
  what's about their own art: put up by someone else, and said or stuck on
  by anyone else. It's in big stickers and few words ("Grandma gave your
  “Rocket” a gold star"), for kids who are only starting to read.
- **Someone who only looks**, like a grandparent, gets new art from all the
  kids they see, and replies after they commented.
- **A sign-in two people share** is one reader: what's new for either is
  new for both, and read when either looks.

Opening the bell catches you up. So does opening the fridge when nothing's
waiting in the bell; when something is, it waits, and so do the walls'
**New** marks, until you open the bell. The page checks for more every
minute while it's in sight. Nothing is stored for any of this but how far
each sign-in has caught up: the list is worked out from the art, comments
and stickers each time, so it follows `FAMILIES` and `NAMES`, and a line
goes when its piece, comment or sticker does. It's never about a kid
someone doesn't see, nor names anyone they don't. It shows the last 60
days. An owner viewing as someone (see [View as](#view-as)) sees that
person's bell, and opening it changes nothing for them.

## What's new, by email

The bell can come by email too. At the top of the bell, the envelope
button (folded, it says how it's set: Email, Sundays or Daily) opens
**Email me what's new**: every Sunday or every day, at the hour you
choose, in your own time. **Never** turns it off; that's the only way to
stop it, and there's no unsubscribe link. Each email has what's new since
the last one (or since you last caught up in the bell, if that's later),
with nothing if there's nothing new: the new art with its pictures and
titles, then the comments, with what was said beside each piece's
picture, then the stickers. Every piece links to itself on the fridge,
**Open the fridge** opens the bell, and the footer's link opens the bell
at the email settings.

It looks like the fridge: the wordmark's letter magnets beside the app
icon, a squiggle under each heading, each piece taped up on paper with its
title in handwriting, everyone's magnets, and what was said in a speech
bubble in the kid's colours. Email can't fetch the page's fonts, which are
behind the sign-in, so it asks for them by name and otherwise uses the
nearest a phone or computer has (Apple's rounded and chalkboard fonts).

It's the bell's list, worked out when the email goes, so it follows the
same rules: only kids you see, and only names, never addresses. Nothing is
kept for it but each sign-in's settings and how far its last email got.
**See it** shows the email as it would go (with everything from the last
week, seen or not), and an owner viewing as someone sees theirs.

While it's being tried out (`DIGESTS = "owners"` in `wrangler.toml`), only
the fridge's owners can have it, and they can **Send me one now** to try
it: the last week's, marked as a test, which changes nothing about the
next one. To open it to everyone, set `DIGESTS = "everyone"`. A kid's iPad
never gets one: its news is in the bell. Cloudflare's Email Service sends
it, only to addresses Cloudflare has verified, so each person clicks
**Verify email address** in an email from Cloudflare once (see [Setting it
up](#setting-it-up)). An hourly job sends whatever's due.

## View as

The fridge's owners can see it exactly as someone else would: a
grandparent, a kid's iPad, an artist, a parent in the other family, or
someone shown only some families. It's for checking a change ("what does
Nonna see now?") without asking them to look.

- **Who can.** The owners are in infra's file, and reach the Worker as
  `ADMINS`: sign-in addresses separated by commas, each one a parent's.
  Missing or empty, nobody can. One that can't be read (an address that
  isn't a parent's, say) also means nobody can, and the Deploy workflow
  stops on it. Nobody else can turn it on, whatever they send.
- **Whom.** The eye button in the header lists everyone the fridge knows of
  from infra's file, by name and grouped by family: each family's parents,
  then its kids (an artist, and each of a kid's devices, which are the
  kid), then everyone else, with what they see. On a sign-in two people
  share, each of them is there, so their names come out right. An address
  shows only where the name alone wouldn't tell two of them apart.
- **What you see** is what they'd see if they signed in themselves: their
  kids, art, pictures, comments, stickers, names and what's new for them,
  through the same rules as everything else. A strip across the top says
  whose eyes you're looking through, with **Switch** and **Stop**.
- **Nothing changes.** While it's on, the Worker refuses every change
  before anything else runs, and the page hides what would change things:
  no comments, stickers, Add art, edits, favourites or the importer. So
  nothing about them moves either: their last visit, what's new for them
  and what they've read stay as they were. Stopping is the one thing that
  goes through.
- It's remembered in a cookie that only the fridge can read, for an hour,
  so the pictures follow it too, and it counts only with an owner's own
  sign-in.

## Setting it up

1. **Cloudflare Zero Trust:** in the Cloudflare dashboard, open Zero Trust
   and choose the Free plan (up to 50 people). That's a billing choice, so
   it can't be made from code.
2. **mwarkentin/infra:** follow the "fridge" section of its README: token
   permissions, who the fridge lets in, then merge its pull request.
   That adopts the Zero Trust organization, adds the One-time PIN login,
   makes everything else and fills in this repo's Actions secrets and
   variables.
3. **Deploy:** run the Deploy workflow from this repo's Actions tab (after
   that, every merge to `main` deploys). Then merge the infra change that
   adds the custom domain: it can only point at a Worker that exists.
4. **The kids** come from infra's file (see [Families](#families)), so
   they're on the fridge once it has deployed. To import scans, sign the
   import script in, from a computer with this repo checked out and
   [uv](https://docs.astral.sh/uv/) and cloudflared installed
   (`brew install cloudflared`):

   ```sh
   uv run scripts/fridge.py login
   ```

5. **Import the scans.** On a phone or iPad, use **Add art** on the page
   instead: choose photos, scans and PDFs, as many as you like, set whose
   they are, check each piece's date and title, and press Add. They go up
   one by one; if one fails, it says which and tries just those again.
   Pieces already on the fridge (from either way in) are left out, and
   pieces you untick are remembered as skipped, as in the survey below.
   With no date in a file's name, it uses the day the photo was taken, or
   else today, and says so.

   On a computer with this repo, survey a folder first. It works offline,
   uploads nothing, and opens a report with a picture of every page, saying
   which pages are blank, which look like art and which are plain
   (documents, or pencil drawings). Each piece has a box to tick: pages
   that look like art start ticked, plain and blank ones don't, and
   clicking a picture opens the original. Press **Save my picks**, then
   import with the file it saves (named after the folder's last three
   names). The survey prints the exact command:

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
   kid's. With families set up, only your own family's kids (and kids in
   no family) count, and the import says which files it leaves out because
   they're another family's. When it was made comes from a date in the
   file or folder name: `2024-05-29`, `20240529`, `2024-05`, `May 2024` or
   `2024`. With none, it guesses the month from the photo's data or the
   file's date, which is usually when it was scanned, and the dry run says
   so. The title is the rest of the file name, without the kid's name (or a
   short form of it of four letters or more, like Theo for Theodora) and
   scanner words. In a name with a filing label, like `2024-05-29 Ada
   Big-Hill Art Bundle rocket.pdf`, only what follows "Art Bundle" (or
   "Bundle") is the title. Titles are set when a piece is imported, so
   check them in the dry run. Fix anything wrong on the page afterwards
   with **Edit details** (on your own family's kids' art).

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

7. **Email** (see [What's new, by email](#whats-new-by-email)) needs three
   things, all in Cloudflare and infra rather than here:
   - **The fridge's domain, onboarded for sending:** in the Cloudflare
     dashboard, **Compute**, **Email Service**, **Email Sending**,
     **Onboard Domain** (or infra's `cloudflare_email_sending_subdomain`).
     It adds its records on `cf-bounce.<domain>`, and a DMARC record if
     there's none.
   - **Each person who'll get it as a verified destination address:**
     **Email Routing**, **Destination addresses** (or infra's
     `cloudflare_email_routing_address`). Cloudflare emails each address a
     link to click once. Sending to verified addresses is free on any plan.
   - **`DIGEST_FROM`:** an address at the fridge's own domain for it to
     come from, like `fridge@<domain>`, as this repo's Actions variable
     (infra sets it). The email's links go to that domain. The next deploy
     picks it up; until then, the fridge sends no email.

## Working on it

```sh
npm ci
npm test                      # Worker tests, against local D1 and R2
uv run --locked pytest        # import script tests
```

To run it locally, create `.dev.vars` (git ignores it) with
`DEV_EMAIL=you@example.com`, `PARENT_EMAILS=you@example.com` and made-up
families and kids:

```sh
FAMILIES='[{"id":"pine","name":"The Pines","parents":["you@example.com"],"kids":[{"name":"Ada","born":"2019-04-02","devices":["ada.ipad@example.com"]},{"name":"Bo","born":"2021-07-02"}]},{"id":"oak","name":"The Oaks","parents":["someone@example.com"],"kids":[{"name":"Cy","born":"2020-02-02"}]}]'
```

and, to see names beside comments (a list for a shared sign-in):

```sh
NAMES='{"you@example.com":{"name":"Aunt Pine","family":"Mom"},"gran@example.com":["Grandma","Pop"],"nonna@example.com":"Nonna"}'
```

and, to show someone only one family:

```sh
SEES='{"nonna@example.com":["pine"]}'
```

and, to view the fridge as any of them (see [View as](#view-as)):

```sh
ADMINS=you@example.com
```

and, to try the email (see [What's new, by email](#whats-new-by-email)):

```sh
DIGEST_FROM=fridge@fridge.example.com
```

Locally nothing is really sent: `npm run dev` writes each email's text,
HTML and pictures to `.wrangler/tmp/email/` and says where. To run the
hourly job, start it with `--test-scheduled` and open
`http://localhost:8787/__scheduled`.

Then:

```sh
npx wrangler d1 migrations apply fridge --local
npm run dev
uv run scripts/fridge.py --url http://localhost:8787 import path/to/some/pictures
```

`DEV_EMAIL` counts only on localhost and is never deployed. To try the page
as someone else (a grandparent, Ada's iPad, or Nonna, who sees only the
Pines), start it as them: `npm run dev -- --var DEV_EMAIL:gran@example.com`.

## Previews

Each pull request from a branch in this repo gets a public preview at
`fridge-preview-pr-<number>.<subdomain>.workers.dev`, linked from a comment
on the pull request. It's the branch's page with two made-up families, Ada
and Bo's and Cy and Dee's, signed in as a parent in the first, and drawings,
comments, stickers and notifications that `preview/worker.js` makes up.
Links across the top show it as each kind of person: the parents, a
grandparent, Nonna (a grandparent who sees only the first family), a kid's
iPad and a kid who's an artist, comments and all. The parents are owners,
so the eye button tries **View as**, with nothing to change: it adds
`?view=` to the address instead of setting anything. Stickers and
comments added there stay in the page until it's reloaded. It has no database,
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
