# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "click==8.5.1",
#     "httpx==0.28.1",
#     "pillow==13.0.0",
#     "pillow-heif==1.8.1",
#     "pypdfium2==5.14.0",
# ]
# ///
"""Bring scans into the fridge.

    uv run scripts/fridge.py login
    uv run scripts/fridge.py folders add ~/Dropbox/Kids\\ Art/Ada --kid Ada
    uv run scripts/fridge.py survey
    uv run scripts/fridge.py import --picks ~/Downloads/fridge-picks-saved-folders.json
    uv run scripts/fridge.py survey ~/Dropbox/Kids\\ Art
    uv run scripts/fridge.py import ~/Dropbox/Kids\\ Art --dry-run
    uv run scripts/fridge.py import ~/Dropbox/Kids\\ Art
    uv run scripts/fridge.py import ~/Dropbox/School --kid Ada --ask

survey looks through a folder first, offline: how many pages each file has,
which are blank, which look like art and which are plain (documents, or
pencil drawings), with a report showing every page. import turns a PDF of
several pages into one piece per page, leaving out blank ones.

It signs in as you through Cloudflare Access, with cloudflared
(brew install cloudflared), so it can do only what you can do on the page:
with families set up, import art only for your own family's kids (and kids
in no family). The kids themselves, and their families, come from
fridge_people.auto.tfvars in mwarkentin/infra.

For each file it works out whose it is from a folder or file name that
matches a kid's name, and when it was made from a date in the file or folder
name (2024-05-29, 20240529, 2024-05, May 2024 or 2024). It makes the
screen-sized copy and thumbnail here, uploads them with the original, and
remembers each file by its contents, so running it again adds only new files.
"""

from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import tomllib
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import click
import httpx
import pillow_heif
import pypdfium2 as pdfium
from PIL import Image, ImageOps

pillow_heif.register_heif_opener()

DEFAULT_URL = os.environ.get("FRIDGE_URL", "https://fridge.michaelwarkentin.com")
TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
}
MAX_BYTES = 85 * 1024 * 1024  # with the copies, under the Worker's 90 MB limit
# Words scanners and cameras put in file names that make poor titles.
NOT_TITLES = {"scan", "scanned", "img", "image", "photo", "dsc", "pxl", "untitled", "copy", "final", "art", "artwork", "page", "document", "doc"}

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
DAY = re.compile(r"(?<!\d)((?:19|20)\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])(?!\d)")
MONTH = re.compile(r"(?<!\d)((?:19|20)\d{2})[-_. ](0[1-9]|1[0-2])(?!\d)")
MONTH_NAME = re.compile(r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[-_ ,]*((?:19|20)\d{2})(?!\d)")
YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
# A filing label: in "2024-05-29 Ada School Art Bundle rocket", what comes
# before it (kid, nickname, school) is filing, and the title follows it.
LABEL = re.compile(r"(?i)(?<![a-z])(?:art[-_ ]+)?bundle(?![a-z])")


# ---- Working out what each file is ----
def date_in(text: str) -> tuple[str, str] | None:
    """The most specific date in some text, as (YYYY-MM-DD, precision).

    A month alone is stored as the 15th and a year alone as July 1st, so ages
    come out close; the precision tells the page to show only what's known.
    """
    for m in DAY.finditer(text):
        try:
            return date(int(m[1]), int(m[2]), int(m[3])).isoformat(), "day"
        except ValueError:
            pass
    if m := MONTH.search(text):
        return f"{m[1]}-{m[2]}-15", "month"
    if m := MONTH_NAME.search(text):
        return f"{m[2]}-{MONTHS.index(m[1].lower()[:3]) + 1:02d}-15", "month"
    if m := YEAR.search(text):
        return f"{m[1]}-07-01", "year"
    return None


def date_from_path(relative: Path) -> tuple[str, str, str] | None:
    """A date from the file name, else the nearest folder that has one."""
    found = date_in(relative.stem)
    if found:
        return (*found, "file name")
    for folder in reversed(relative.parts[:-1]):
        if found := date_in(folder):
            return (*found, "folder name")
    return None


def photo_date(path: Path) -> str | None:
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)
    except Exception:
        return None
    m = re.match(r"(\d{4}):(\d{2}):(\d{2})", str(raw or ""))
    try:
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat() if m else None
    except ValueError:
        return None


def name_pattern(name: str) -> re.Pattern:
    return re.compile(rf"(?i)(?<![a-z]){re.escape(name)}(?:'s|s)?(?![a-z])")


def match_kid(relative: Path, kids: list[dict]) -> dict | None:
    """The one kid named in the folder names, or failing that the file name.

    Folders win, so Bo/me-and-Ada.jpg is Bo's. Two kids at the same level
    means it can't tell.
    """
    def named(parts):
        return {k["id"]: k for k in kids for part in parts if name_pattern(k["name"]).search(part)}

    hits = named(relative.parts[:-1]) or named(relative.parts[-1:])
    return next(iter(hits.values())) if len(hits) == 1 else None


def short_for(word: str, name: str) -> bool:
    """Whether word is a short form of name, as Theo is of Theodora. Four
    letters at least, so "The" and "And" stay in titles."""
    word = re.sub(r"['’]s$", "", word.lower())
    return len(word) >= 4 and name.lower().startswith(word)


def title_from(stem: str, owner: str | None) -> str:
    """A title from the file name, without its date, the owner's name (or a
    short form of it), camera and scanner words, or anything before a filing
    label such as "Art Bundle". Other kids' names stay: "me and Bo"."""
    t = stem
    for rx in (DAY, MONTH, MONTH_NAME, YEAR):
        t = rx.sub(" ", t)
    labels = list(LABEL.finditer(t))
    if labels:
        t = t[labels[-1].end():]
    if owner:
        t = name_pattern(owner).sub(" ", t)
    words = [w for w in re.sub(r"[-_.()\[\]]+", " ", t).split() if w.lower() not in NOT_TITLES]
    if owner:
        words = [w for w in words if not short_for(w, owner)]
    words = [w for w in words if not (w.isdigit() and len(w) >= 3)]  # camera counters like 1234
    if all(w.isdigit() for w in words):
        return ""  # "Scan 3"
    t = " ".join(words)
    return t[:1].upper() + t[1:]


@dataclass
class Plan:
    path: Path
    relative: Path
    kid: dict | None
    made: str | None = None
    precision: str = "day"
    made_from: str = ""
    title: str = ""
    problem: str | None = None


def plan_for(path: Path, root: Path, kids: list[dict], forced_kid: dict | None, others: list[dict] = ()) -> Plan:
    """What to import a file as. kids are the ones you can import art for;
    others, the kids in other families, only to say why a file of theirs is
    left out."""
    relative = path.relative_to(root)
    plan = Plan(path, relative, forced_kid or match_kid(relative, kids))
    if not plan.kid:
        other = not forced_kid and match_kid(relative, others)
        if other:
            plan.problem = f"it’s {other['name']}’s, and {other['name']} is in another family, so only their family can import it"
        else:
            plan.problem = "can’t tell whose it is (put it in a folder named after them, or use --kid)"
        return plan
    if found := date_from_path(relative):
        plan.made, plan.precision, plan.made_from = found
    elif taken := photo_date(path):
        # Often when it was scanned or photographed rather than made, so only
        # the month is claimed.
        plan.made, plan.precision, plan.made_from = f"{taken[:7]}-15", "month", "photo data, a guess"
    else:
        modified = datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
        plan.made, plan.precision, plan.made_from = f"{modified[:7]}-15", "month", "file date, a guess"
    plan.title = title_from(path.stem, plan.kid["name"])
    # A PDF is checked page by page when it's split.
    if path.suffix.lower() != ".pdf" and path.stat().st_size > MAX_BYTES:
        plan.problem = "too big (the limit is 85 MB)"
    return plan


# ---- Images ----
def find_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TYPES and not p.name.startswith("."))


def open_image(path: Path, page: int = 1) -> Image.Image:
    """The picture, the right way up, in RGB on white. For a PDF, that page
    (counting from 1) at 200 dpi."""
    if path.suffix.lower() == ".pdf":
        pdf = pdfium.PdfDocument(str(path))
        try:
            im = pdf[page - 1].render(scale=200 / 72).to_pil()
        finally:
            pdf.close()
    else:
        im = Image.open(path)
        im.load()
        im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P", "PA"):
        im = im.convert("RGBA")
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, mask=im.getchannel("A"))
        return flat
    return im if im.mode == "RGB" else im.convert("RGB")


def jpeg(im: Image.Image, longest: int, quality: int) -> tuple[bytes, int, int]:
    """A JPEG copy no bigger than `longest` on its long side, with no metadata."""
    copy = im.copy()
    copy.thumbnail((longest, longest), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    copy.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue(), copy.width, copy.height


# ---- Looking at pages ----
# Scanners often put several pieces in one PDF, a page each. Each page is
# measured on a small render: how much of it isn't bare paper ("ink"), and
# how much of that is clearly coloured. Kids' art mostly is; documents and
# pencil drawings aren't, so plain pages are the ones to look at. On sample
# drawings the coloured share was 0.19 and up; on documents, even one with a
# coloured logo, 0.02 or less.
BLANK_INK = 0.004  # under 0.4% of the page marked
ART_SHARE = 0.10  # at least a tenth of the marks clearly coloured
KINDS = {"art": "looks like art", "plain": "plain: a document, or a pencil drawing?", "blank": "blank"}


@dataclass
class Page:
    number: int  # from 1
    count: int
    size_in: tuple[float, float] | None
    ink: float
    coloured: float
    thumb: Image.Image

    @property
    def kind(self) -> str:
        if self.ink < BLANK_INK:
            return "blank"
        return "art" if self.coloured >= ART_SHARE else "plain"


def measure(im: Image.Image) -> tuple[float, float]:
    """(share of the page that isn't paper, share of those marks clearly
    coloured). The paper is the commonest colour, so construction paper
    counts as paper."""
    small = im.convert("RGB")
    small.thumbnail((200, 200))
    px = list(small.get_flattened_data())
    paper = Counter((r >> 4, g >> 4, b >> 4) for r, g, b in px).most_common(1)[0][0]
    pr, pg, pb = ((c << 4) + 8 for c in paper)
    marks = [(r, g, b) for r, g, b in px if (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2 > 60**2]
    if not marks:
        return 0.0, 0.0
    coloured = sum(1 for m in marks if max(m) - min(m) >= 48)
    return len(marks) / len(px), coloured / len(marks)


def survey_file(path: Path) -> list[Page]:
    """Every page of a PDF, or the one picture, measured, with a small preview."""
    if path.suffix.lower() != ".pdf":
        im = open_image(path)
        im.thumbnail((320, 320))
        return [Page(1, 1, None, *measure(im), thumb=im)]
    pdf = pdfium.PdfDocument(str(path))
    try:
        pages = []
        for i in range(len(pdf)):
            w, h = pdf[i].get_size()
            im = pdf[i].render(scale=min(1.0, 320 / max(w, h))).to_pil().convert("RGB")
            pages.append(Page(i + 1, len(pdf), (w / 72, h / 72), *measure(im), thumb=im))
        return pages
    finally:
        pdf.close()


def page_hash(file_hash: str, number: int) -> str:
    """A page's own identity, so each page of a PDF is remembered by itself."""
    return hashlib.sha256(f"{file_hash}:page {number}".encode()).hexdigest()


def single_page_pdf(path: Path, number: int) -> bytes:
    """That page of a PDF as a PDF of its own: the original for its piece."""
    src = pdfium.PdfDocument(str(path))
    out = pdfium.PdfDocument.new()
    try:
        out.import_pages(src, [number - 1])
        buf = io.BytesIO()
        out.save(buf)
        return buf.getvalue()
    finally:
        out.close()
        src.close()


def piece_id(file_hash: str, page: Page) -> str:
    """The source hash import gives that page's piece: the page's own for a
    PDF of several pages, the file's otherwise (as pieces_for does)."""
    return page_hash(file_hash, page.number) if page.count > 1 else file_hash


def pieces_for(path: Path, file_hash: str, split: bool = True, keep: set[str] = frozenset()) -> tuple[list[tuple[str, int | None, int]], list[int]]:
    """What one file becomes: (source hash, page or None, page count) for each
    piece, and the blank pages left out. A PDF of several pages becomes one
    piece per page that isn't blank, or is in `keep` (picked in the survey);
    anything else is one piece."""
    if split and path.suffix.lower() == ".pdf":
        pages = survey_file(path)
        if len(pages) > 1:
            kept = [p for p in pages if p.kind != "blank" or piece_id(file_hash, p) in keep]
            pieces = [(piece_id(file_hash, p), p.number, len(pages)) for p in kept]
            return pieces, [p.number for p in pages if p not in kept]
    return [(file_hash, None, 1)], []


# ---- Picks: what to import, ticked in the survey's report ----
PICKS_VERSION = 2  # 1 had one "folder"; 2 lists "folders"
SAVED_PICKS = "fridge-picks-saved-folders.json"


def picks_name(root: Path) -> str:
    """The name the report saves picks under: the folder's last three names,
    so two kids' Artwork folders, or two kids' School/<same school> folders,
    don't share one."""
    tail = " ".join(part for part in root.parts[-3:] if part != root.anchor)
    return "fridge-picks-" + re.sub(r"[^a-z0-9]+", "-", tail.lower()).strip("-") + ".json"


def load_picks(path: Path) -> dict:
    """The pieces ticked (include) and unticked (exclude) in a survey's report,
    by source hash, so renaming or moving a file doesn't lose its pick, and
    the folders that survey looked at."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        folders = [data["folder"]] if data.get("version") == 1 else data["folders"] if data.get("version") == 2 else None
        return {"include": set(data["include"]), "exclude": set(data["exclude"]), "folders": [Path(f) for f in folders]}
    except Exception:
        raise click.ClickException(f"{path.name} isn’t a picks file saved from the survey’s report.")


def picks_cover(picks: dict, root: Path) -> bool:
    """Whether the survey those picks came from looked at this folder (or a
    folder inside it, or one around it)."""
    return any(root == f or f in root.parents or root in f.parents for f in picks["folders"])


# ---- Saved folders: what survey and import use when no folder is named ----
# Kept on this computer only, outside the repo: the paths name the kids.
def folders_file() -> Path:
    return Path(os.environ.get("FRIDGE_FOLDERS") or Path(click.get_app_dir("fridge")) / "folders.toml")


def load_folders() -> list[tuple[Path, str | None]]:
    f = folders_file()
    if not f.exists():
        return []
    try:
        data = tomllib.loads(f.read_text(encoding="utf-8"))
        return [(Path(e["path"]), e.get("kid")) for e in data.get("folder", [])]
    except Exception as e:
        raise click.ClickException(f"Couldn’t read the saved folders in {f}: {e}")


def save_folders(entries: list[tuple[Path, str | None]]) -> None:
    f = folders_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# The folders fridge.py surveys and imports when you don't name one.", "# Change them with: uv run scripts/fridge.py folders add|remove, or by hand.", ""]
    for path, kid in entries:
        # JSON strings are valid TOML basic strings.
        lines += ["[[folder]]", f"path = {json.dumps(str(path))}"] + ([f"kid = {json.dumps(kid)}"] if kid else []) + [""]
    f.write_text("\n".join(lines), encoding="utf-8")


def targets_for(folder: Path | None, kid_name: str | None) -> list[tuple[Path, str | None]]:
    """The folders to work on, each with its kid: the one named (its kid from
    --kid, or from the saved folders), or else every saved folder."""
    saved = load_folders()
    if folder:
        root = folder.expanduser().resolve()
        return [(root, kid_name or next((k for p, k in saved if p == root), None))]
    if kid_name:
        raise click.ClickException("--kid goes with a folder. Saved folders each have their own kid.")
    if not saved:
        raise click.ClickException("Name a folder, or save some first: uv run scripts/fridge.py folders add PATH --kid NAME")
    return saved


def when_text(found: tuple[str, str, str] | None) -> str:
    if not found:
        return "no date in the name"
    made, precision, _ = found
    return {"day": made, "month": made[:7], "year": made[:4]}[precision]


def report_html(roots: list[Path], rows: list, summary: str, known: tuple[set[str], set[str]] | None = None, note: str = "", picks_file: str | None = None) -> str:
    """A page to look through in a browser: every file, with a picture of every
    page and a box to tick each piece to import. New pages that look like art
    start ticked. "Save my picks" downloads them for import --picks. With
    what the fridge knows, pieces already on it have no box, pieces skipped
    before start unticked, and only new ones show at first."""
    def data_uri(im: Image.Image) -> str:
        small = im.copy()
        small.thumbnail((220, 220))
        buf = io.BytesIO()
        small.save(buf, "JPEG", quality=70)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    sections = []
    current = None
    for rel, when, title, pages, digest, path, root in rows:
        if len(roots) > 1 and root != current:
            current = root
            sections.append(f'<h2 class="folder">{html.escape(str(root))}</h2>')
        size = f" · {pages[0].size_in[0]:.1f} × {pages[0].size_in[1]:.1f} in" if pages[0].size_in else ""
        statuses = [status_of(piece_id(digest, p), known) for p in pages]
        # A blank page of a multi-page PDF isn't imported, so it isn't new:
        # it shows only under Everything (and can still be ticked there).
        statuses = ["blank" if st == "new" and len(pages) > 1 and p.kind == "blank" else st for p, st in zip(pages, statuses)]
        figures = ""
        for p, status in zip(pages, statuses):
            pid = piece_id(digest, p)
            if status == "on":
                pick = '<span class="pick on-fridge">On the fridge</span>'
            else:
                ticked = " checked" if status == "new" and p.kind == "art" else ""
                pick = f'<label class="pick"><input type="checkbox" data-id="{pid}"{ticked}> Import</label>'
            figures += (
                f'<figure class="{p.kind} st-{status}"><a href="{html.escape(path.as_uri() + (f"#page={p.number}" if path.suffix.lower() == ".pdf" else ""))}" '
                f'target="_blank" rel="noopener" title="Open the original"><img src="{data_uri(p.thumb)}" alt=""></a>{pick}'
                f'<figcaption>{"Skipped before · " if status == "skipped" else ""}{f"Page {p.number}: " if len(pages) > 1 else ""}{KINDS[p.kind]}</figcaption></figure>'
            )
        classes = " ".join([
            "file",
            "multi" if len(pages) > 1 else "",
            "has-plain" if any(p.kind == "plain" for p in pages) else "",
            "has-new" if "new" in statuses else "",
            "has-skipped" if "skipped" in statuses else "",
        ])
        sections.append(
            f'<section class="{classes}"><div class="head"><h2>{html.escape(str(rel))}</h2>'
            f'<span class="bulk"><button type="button" data-all>All</button><button type="button" data-none>None</button></span></div>'
            f'<p>{html.escape(when)} · {html.escape(f"“{title}”") if title else "untitled"} · '
            f'{len(pages)} page{"s" if len(pages) != 1 else ""}{size}</p><div class="pages">{figures}</div></section>'
        )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fridge survey</title>
<style>
:root {{ color-scheme: light dark; --bg: #edf0ef; --card: #fbfcfc; --ink: #1b2124; --muted: #59646a; --line: #d3dad9; --art: #2f8a4a; --plain: #c96509; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #141819; --card: #1c2224; --ink: #e6ebec; --muted: #9ba7ac; --line: #2c3437; --art: #5cc27a; --plain: #f0954a; }} }}
body {{ margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }}
main {{ max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; display: grid; gap: 14px; }}
h1 {{ margin: 0; font-size: 1.6rem; }} .lede {{ margin: 0; color: var(--muted); }}
.filters {{ display: flex; flex-wrap: wrap; gap: 8px; }}
.filters button {{ font: inherit; padding: 6px 12px; border-radius: 99px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }}
.filters button[aria-pressed="true"] {{ background: var(--ink); color: var(--bg); }}
.file {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }}
.file h2 {{ margin: 0; font-size: 0.95rem; overflow-wrap: anywhere; }} .file p {{ margin: 2px 0 10px; color: var(--muted); font-size: 0.9rem; }}
.pages {{ display: flex; flex-wrap: wrap; gap: 10px; }}
figure {{ margin: 0; width: 150px; }} figure img {{ width: 100%; height: auto; display: block; border: 1px solid var(--line); background: #fff; }}
figcaption {{ font-size: 0.8rem; color: var(--muted); margin-top: 4px; }}
figure.art figcaption {{ color: var(--art); }} figure.plain figcaption {{ color: var(--plain); font-weight: 600; }} figure.blank {{ opacity: 0.45; }}
body.only-multi .file:not(.multi), body.only-plain .file:not(.has-plain) {{ display: none; }}
body.view-new figure:not(.st-new), body.view-skipped figure:not(.st-skipped) {{ display: none; }}
body.view-new .file:not(.has-new), body.view-skipped .file:not(.has-skipped) {{ display: none; }}
.filters label {{ display: flex; align-items: center; gap: 6px; font-size: 0.9rem; color: var(--muted); }}
figure.st-on img {{ opacity: 0.5; }} .on-fridge {{ color: var(--art); cursor: default; }}
h2.folder {{ margin: 12px 0 0; font-size: 1.05rem; overflow-wrap: anywhere; }}
.nothing-new {{ display: none; margin: 0; padding: 14px; color: var(--muted); }} body.view-new .nothing-new {{ display: block; }}
.picks {{ position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 10px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }}
.picks button {{ font: inherit; font-weight: 600; padding: 7px 14px; border-radius: 8px; border: 0; background: var(--ink); color: var(--bg); cursor: pointer; }}
.picks .note {{ color: var(--muted); font-size: 0.9rem; }}
.head {{ display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; align-items: baseline; }}
.bulk {{ display: flex; gap: 6px; }} .bulk button {{ font: inherit; font-size: 0.8rem; padding: 2px 9px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }}
.pick {{ display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }}
.pick input {{ width: 18px; height: 18px; margin: 0; }}
figure:has(input:not(:checked)) img {{ opacity: 0.4; }}
</style></head><body class="{"view-new" if known is not None else "view-all"}"><main>
<h1>Fridge survey</h1>
<p class="lede">{"<br>".join(html.escape(str(r)) for r in roots)}<br>{html.escape(summary)}{f"<br>{html.escape(note)}" if note else ""}</p>
<div class="picks"><span id="count"></span><button type="button" id="save">Save my picks</button>
<span class="note" id="saved">Ticked pieces get imported, and unticked ones are remembered as skipped. Plain pages start unticked: tick the pencil drawings you want. Click a picture to open the original.{" Showing what’s new: pieces already on the fridge, and ones skipped before, are under Everything. Tick a skipped piece to import it after all." if known is not None else ""}</span></div>
<div class="filters" role="group" aria-label="Show">
{'<button type="button" data-view="new" aria-pressed="true">New</button><button type="button" data-view="all" aria-pressed="false">Everything</button><button type="button" data-view="skipped" aria-pressed="false">Skipped before</button>' if known is not None else ""}
<label><input type="checkbox" id="only-multi"> Only PDFs with several pages</label>
<label><input type="checkbox" id="only-plain"> Only files with plain pages</label>
</div>
{'<p class="nothing-new">Nothing new here: everything is on the fridge already or was skipped before. Everything shows it all.</p>' if known is not None and not any("has-new" in sec for sec in sections) else ""}
{"".join(sections)}
</main>
<script>
const FOLDERS = {json.dumps([str(r) for r in roots]).replace("</", "<\\/")};
const NAME = {json.dumps(picks_file or picks_name(roots[0])).replace("</", "<\\/")};
const KEY = 'fridge-picks:' + FOLDERS.join('|');
const boxes = [...document.querySelectorAll('input[data-id]')];
let kept = {{}};
try {{ kept = JSON.parse(localStorage.getItem(KEY) || '{{}}'); }} catch {{}}
for (const b of boxes) if (b.dataset.id in kept) b.checked = kept[b.dataset.id];
function set(id, on) {{ for (const b of boxes) if (b.dataset.id === id) b.checked = on; }}
function remember() {{
  const now = {{}};
  for (const b of boxes) now[b.dataset.id] = b.checked;
  try {{ localStorage.setItem(KEY, JSON.stringify(now)); }} catch {{}}
  const ids = new Set(boxes.map((b) => b.dataset.id));
  const on = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.id));
  document.getElementById('count').textContent = `${{on.size}} of ${{ids.size}} pieces ticked`;
  return {{ ids, on }};
}}
document.addEventListener('change', (e) => {{ if (e.target.matches('input[data-id]')) {{ set(e.target.dataset.id, e.target.checked); remember(); }} }});
document.addEventListener('click', (e) => {{
  const bulk = e.target.closest('[data-all], [data-none]');
  if (!bulk) return;
  // Only the boxes on show, so "All" never ticks a hidden skipped piece.
  bulk.closest('.file').querySelectorAll('input[data-id]').forEach((b) => {{ if (b.offsetParent !== null) set(b.dataset.id, bulk.hasAttribute('data-all')); }});
  remember();
}});
document.getElementById('save').addEventListener('click', () => {{
  const {{ ids, on }} = remember();
  const picks = {{ version: {PICKS_VERSION}, folders: FOLDERS, include: [...on], exclude: [...ids].filter((id) => !on.has(id)) }};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(picks, null, 1)], {{ type: 'application/json' }}));
  a.download = NAME;
  document.body.append(a);
  a.click();
  a.remove();
  document.getElementById('saved').textContent = `Saved ${{NAME}} to your downloads. Import with --picks and that file.`;
}});
remember();
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {{
  document.body.classList.remove('view-new', 'view-all', 'view-skipped');
  document.body.classList.add('view-' + b.dataset.view);
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}}));
for (const id of ['only-multi', 'only-plain']) document.getElementById(id).addEventListener('change', (e) => document.body.classList.toggle(id, e.target.checked));
</script></body></html>
"""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---- Talking to the fridge ----
def access_token(url: str) -> str:
    exe = shutil.which("cloudflared")
    if not exe:
        raise click.ClickException("Signing in needs cloudflared: brew install cloudflared")
    r = subprocess.run([exe, "access", "token", f"-app={url}"], capture_output=True, text=True)
    token = r.stdout.strip()
    if r.returncode or not token or " " in token:
        raise click.ClickException("You’re not signed in. Run: uv run scripts/fridge.py login")
    return token


def connect(url: str) -> httpx.Client:
    headers = {"X-Requested-With": "fridge"}
    if httpx.URL(url).host not in ("localhost", "127.0.0.1"):
        headers["cf-access-token"] = access_token(url)
    return httpx.Client(base_url=url, headers=headers, timeout=httpx.Timeout(30, write=600), follow_redirects=False)


def check(r: httpx.Response) -> dict:
    if r.is_redirect or r.status_code in (401, 403) and "json" not in r.headers.get("content-type", ""):
        raise click.ClickException("Cloudflare Access turned the request away. Run: uv run scripts/fridge.py login")
    if r.is_error:
        try:
            message = r.json()["error"]
        except Exception:
            message = r.text[:200]
        raise click.ClickException(f"The fridge said: {message} (HTTP {r.status_code})")
    return r.json() if r.content else {}


def open_file(path: Path) -> None:
    exe = shutil.which("open") or shutil.which("xdg-open")
    if exe:
        subprocess.run([exe, str(path)], check=False)
    else:
        click.echo("    There's no way to open files here; look at it in Finder.")


def ask_about(path: Path, prompt=click.prompt, opener=open_file) -> str:
    """Ask whether to import one file: "y" or "n", or "q" to stop. "o" opens
    it to look, then asks again. Enter means no, so nothing that isn't art
    goes up by accident."""
    choices = click.Choice(["y", "n", "o", "q"], case_sensitive=False)
    while True:
        answer = prompt("    Import it? [y]es, [n]o, [o]pen to look, [q]uit", default="n", show_default=False, show_choices=False, type=choices).lower()
        if answer != "o":
            return answer
        opener(path)


def fetch_known(client: httpx.Client) -> tuple[set[str], set[str]]:
    """What the fridge already knows: pieces on it, and pieces a parent chose
    not to import."""
    data = check(client.get("/api/imported"))
    return set(data["hashes"]), set(data.get("skipped", []))


def record_skipped(client: httpx.Client, hashes: set[str]) -> None:
    """Remember on the fridge that these pieces were looked at and left out,
    so later imports leave them out and later surveys say so."""
    todo = sorted(hashes)
    for i in range(0, len(todo), 5000):
        check(client.post("/api/skipped", json={"add": todo[i : i + 5000]}))


def status_of(piece: str, known: tuple[set[str], set[str]] | None) -> str:
    """"on" the fridge, "skipped" before, or "new" (everything, when offline)."""
    if known is None:
        return "new"
    imported, skipped = known
    return "on" if piece in imported else "skipped" if piece in skipped else "new"


def can_change(kid: dict, session: dict) -> bool:
    """The fridge's rule: a parent can change a kid, and their art, if the
    kid is in one of the parent's families or in none."""
    return bool(session.get("canEdit")) and (kid.get("family") is None or kid["family"] in session.get("families", []))


def describe(plan: Plan) -> str:
    when = {"day": plan.made, "month": plan.made[:7] if plan.made else "", "year": plan.made[:4] if plan.made else ""}[plan.precision]
    title = f"“{plan.title}”" if plan.title else "untitled"
    return f"{plan.kid['name']} · {when} (from {plan.made_from}) · {title}"


# ---- Commands ----
@click.group()
@click.option("--url", default=DEFAULT_URL, show_default=True, help="The fridge’s address. FRIDGE_URL sets it too.")
@click.pass_context
def cli(ctx: click.Context, url: str) -> None:
    """Add kids and bring scans into the fridge."""
    ctx.obj = url.rstrip("/")


@cli.command()
@click.pass_obj
def login(url: str) -> None:
    """Sign in through Cloudflare Access (opens your browser)."""
    exe = shutil.which("cloudflared")
    if not exe:
        raise click.ClickException("Signing in needs cloudflared: brew install cloudflared")
    subprocess.run([exe, "access", "login", url], check=True)


@cli.group()
def folders() -> None:
    """The folders survey and import use when you don't name one, each with
    its kid. Kept on this computer only, never in the repo."""


@folders.command("add")
@click.argument("folder", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--kid", "kid_name", required=True, help="Whose art the folder holds.")
def folders_add(folder: Path, kid_name: str) -> None:
    """Save FOLDER, with whose art it is."""
    root = folder.expanduser().resolve()
    saved = [(p, k) for p, k in load_folders() if p != root] + [(root, kid_name)]
    save_folders(saved)
    click.echo(f"Saved {root} ({kid_name}). Folders saved: {len(saved)}, in {folders_file()}.")


@folders.command("list")
def folders_list() -> None:
    """Show the saved folders."""
    saved = load_folders()
    if not saved:
        click.echo("No folders saved yet. Add one: uv run scripts/fridge.py folders add PATH --kid NAME")
        return
    for path, kid in saved:
        click.echo(f"{kid or '(no kid)'} · {path}{'' if path.exists() else '  (not found)'}")
    click.echo(f"\nSaved in {folders_file()}")


@folders.command("remove")
@click.argument("folder", type=click.Path(path_type=Path))
def folders_remove(folder: Path) -> None:
    """Stop using FOLDER when none is named. Nothing in it is touched."""
    root = folder.expanduser().resolve()
    saved = load_folders()
    kept = [(p, k) for p, k in saved if p != root]
    if len(kept) == len(saved):
        raise click.ClickException(f"{root} isn’t a saved folder. See them with: uv run scripts/fridge.py folders list")
    save_folders(kept)
    click.echo(f"Removed {root}. Folders saved: {len(kept)}.")


@cli.command()
@click.argument("folder", required=False, type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--kid", "kid_name", help="Whose art it is, so their name is left out of the titles.")
@click.option("--report", "report_path", type=click.Path(dir_okay=False, path_type=Path), help="Where to write the report. Default: a new file in your temporary folder, never the folder being surveyed.")
@click.option("--no-open", is_flag=True, help="Don’t open the report once it’s written.")
@click.option("--offline", is_flag=True, help="Don’t ask the fridge what it already has; show every piece as new.")
@click.pass_obj
def survey(url: str, folder: Path | None, kid_name: str | None, report_path: Path | None, no_open: bool, offline: bool) -> None:
    """Look through FOLDER, or every saved folder, before importing. Nothing
    is uploaded.

    For each file: its pages, which are blank, which look like art and which
    are plain (a document, or a pencil drawing, so worth a look), and the date
    and title the import would use. Signed in, it also asks the fridge which
    pieces are on it already and which were skipped before, and the report
    shows only new ones at first. The report shows a picture of every page.
    """
    targets = targets_for(folder, kid_name)
    known, note = None, ""
    if not offline:
        try:
            with connect(url) as client:
                known = fetch_known(client)
        except (click.ClickException, httpx.HTTPError) as e:
            why = e.message if isinstance(e, click.ClickException) else f"couldn’t reach {url}"
            note = f"Couldn’t ask the fridge what it already has ({why}), so every piece shows as new."
            click.echo(note + "\n")
    rows, totals = [], Counter()
    for root, kid_name in targets:
        if len(targets) > 1:
            click.echo(f"== {root}{f' ({kid_name})' if kid_name else ''}")
        if not root.exists():
            click.echo("- not found, so left out\n")
            continue
        for path in find_files(root):
            rel = path.relative_to(root)
            try:
                pages = survey_file(path)
                digest = sha256(path)
            except Exception as e:
                totals["unreadable"] += 1
                click.echo(f"- {rel}: couldn’t open it: {e}")
                continue
            kinds = Counter(p.kind for p in pages)
            totals.update(kinds)
            totals["files"] += 1
            totals["pages"] += len(pages)
            totals["multi"] += len(pages) > 1
            totals["pieces"] += 1 if len(pages) == 1 else len(pages) - kinds["blank"]
            statuses = Counter(status_of(piece_id(digest, p), known) for p in pages if len(pages) == 1 or p.kind != "blank")
            totals.update({f"st-{k}": v for k, v in statuses.items()})
            when, title = when_text(date_from_path(rel)), title_from(path.stem, kid_name)
            counts = ", ".join(f"{n} {kind}" for kind, n in kinds.items())
            known_counts = ""
            if known is not None and (statuses["on"] or statuses["skipped"]):
                known_counts = " (" + ", ".join(f"{n} {label}" for label, n in (("new", statuses["new"]), ("on the fridge", statuses["on"]), ("skipped before", statuses["skipped"])) if n) + ")"
            click.echo(f"{rel}\n    {when} · {f'“{title}”' if title else 'untitled'} · {len(pages)} page{'s' if len(pages) != 1 else ''}: {counts}{known_counts}")
            rows.append((rel, when, title, pages, digest, path, root))

    def n(count: int, one: str, many: str) -> str:
        return f"{count} {one if count == 1 else many}"

    summary = (
        f"{n(totals['files'], 'file', 'files')} with {n(totals['pages'], 'page', 'pages')}; "
        f"{n(totals['multi'], 'PDF has', 'PDFs have')} several pages. "
        f"Pages that look like art: {totals['art']}. Plain (documents, or pencil drawings, so look at these): {totals['plain']}. "
        f"Blank: {totals['blank']}. "
    )
    if known is not None:
        summary += f"New pieces: {totals['st-new']}. Already on the fridge: {totals['st-on']}. Skipped before: {totals['st-skipped']}."
    else:
        summary += f"Importing would add up to {n(totals['pieces'], 'piece', 'pieces')}."
    if totals["unreadable"]:
        summary += f" Couldn’t open: {totals['unreadable']}."
    click.echo(f"\n{summary}")
    out = report_path or Path(tempfile.gettempdir()) / f"fridge-survey-{datetime.now():%Y%m%d-%H%M%S}.html"
    roots = [r for r, _ in targets if r.exists()]  # the folders looked at, which the picks will cover
    picks_file = picks_name(roots[0]) if folder else SAVED_PICKS
    out.write_text(report_html(roots, rows, summary, known, note, picks_file), encoding="utf-8")
    click.echo(f"Report: {out}")
    if folder:
        kid = f" --kid {shlex.quote(targets[0][1])}" if targets[0][1] else ""
        command = f"uv run scripts/fridge.py import {shlex.quote(str(roots[0]))}{kid} --picks ~/Downloads/{picks_file}"
    else:
        command = f"uv run scripts/fridge.py import --picks ~/Downloads/{picks_file}"
    click.echo(f"\nIn the report, tick what to import (pages that look like art start ticked) and press “Save my picks”. Then:\n  {command}")
    if not no_open:
        open_file(out)


@cli.command("import")
@click.argument("folder", required=False, type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--kid", "kid_name", help="Whose art it all is, when the folder names don’t say.")
@click.option("--dry-run", is_flag=True, help="Show what would happen, and change nothing.")
@click.option("--ask", is_flag=True, help="Ask before each piece, for folders that mix art with other papers. Ones you say no to are remembered as skipped.")
@click.option("--first-page-only", "first_only", is_flag=True, help="Import each PDF as one piece, its first page, instead of a piece per page.")
@click.option("--picks", "picks_path", type=click.Path(exists=True, dir_okay=False, path_type=Path), help="The picks file saved from the survey’s report: import only what’s ticked there. Pieces added since the survey are skipped, or asked about with --ask.")
@click.pass_obj
def import_(url: str, folder: Path | None, kid_name: str | None, dry_run: bool, ask: bool, first_only: bool, picks_path: Path | None) -> None:
    """Import every picture and PDF under FOLDER, or under every saved folder.
    A PDF of several pages becomes one piece per page, leaving out blank pages."""
    targets = targets_for(folder, kid_name)
    picks = load_picks(picks_path.expanduser()) if picks_path else None
    if picks and not any(picks_cover(picks, root) for root, _ in targets):
        where = ", ".join(str(f) for f in picks["folders"])
        raise click.ClickException(f"Those picks are for {where}. Survey again, and save picks from the new report.")
    if picks and first_only:
        raise click.ClickException("Picks are made page by page, so they can’t be used with --first-page-only.")
    with connect(url) as client:
        everyone = check(client.get("/api/gallery"))["kids"]
        if not everyone:
            raise click.ClickException("There are no kids on the fridge yet. They come from fridge_people.auto.tfvars, in mwarkentin/infra.")
        # Only the kids you can change: your families' and those in none.
        session = check(client.get("/api/session"))
        kids = [k for k in everyone if can_change(k, session)]
        others = [k for k in everyone if k not in kids]
        if not kids:
            raise click.ClickException("Every kid on the fridge is in another family, so there’s nobody you can import art for.")
        forced_for = {}
        for _, name in targets:
            if name:
                forced_for[name] = next((k for k in kids if k["name"].lower() == name.lower()), None)
                if not forced_for[name]:
                    if any(k["name"].lower() == name.lower() for k in others):
                        raise click.ClickException(f"{name} is in another family, so only their family can import {name}’s art.")
                    raise click.ClickException(f"No kid called {name}. You can import art for: {', '.join(k['name'] for k in kids)}")
        done, skipped_before = fetch_known(client)

        counts = {"added": 0, "already": 0, "skipped": 0, "unpicked": 0, "skipped_before": 0}
        to_skip: set[str] = set()  # left out this time, to remember on the fridge
        try:
            for root, name in targets:
                if len(targets) > 1:
                    click.echo(f"== {root}{f' ({name})' if name else ''}")
                if not root.exists():
                    click.echo("- not found, so left out")
                    continue
                if picks and not picks_cover(picks, root):
                    click.echo("- not in the survey those picks came from, so left out. Survey again to include it.")
                    continue
                if import_files(client, root, kids, forced_for.get(name), picks, first_only, ask, dry_run, done, skipped_before, to_skip, counts, others):
                    break
        finally:
            if to_skip and not dry_run:
                record_skipped(client, to_skip)
                click.echo(f"\nRemembered {len(to_skip)} left-out piece{'s' if len(to_skip) != 1 else ''} as skipped, so later imports leave them out too.")

    verb = "Would add" if dry_run else "Added"
    left_out = f" Left out by your picks: {counts['unpicked']}." if picks else ""
    before = f" Skipped before: {counts['skipped_before']}." if counts["skipped_before"] else ""
    click.echo(f"\n{verb} {counts['added']}. Already on the fridge: {counts['already']}. Skipped: {counts['skipped']}.{left_out}{before}")
    if dry_run and counts["added"]:
        click.echo("Fix any wrong names or dates in the files or folders, or on the page after importing, then run it again without --dry-run.")


def import_files(client, root, kids, forced, picks, first_only, ask, dry_run, done, skipped_before, to_skip, counts, others=()) -> bool:
    """The import's loop over one folder's files and their pieces (see
    import_). True if the person chose to stop."""
    stopped = False
    for path in find_files(root):
        plan = plan_for(path, root, kids, forced, others)
        if plan.problem:
            counts["skipped"] += 1
            click.echo(f"- {plan.relative}: {plan.problem}")
            continue
        digest = sha256(path)
        try:
            pieces, blanks = pieces_for(path, digest, split=not first_only, keep=picks["include"] if picks else frozenset())
        except Exception as e:
            counts["skipped"] += 1
            click.echo(f"- {plan.relative}: couldn’t open it: {e}")
            continue
        if blanks:
            click.echo(f"  {plan.relative}: leaving out blank page{'s' if len(blanks) > 1 else ''} {', '.join(map(str, blanks))}")
        for piece_hash, page, page_count in pieces:
            if piece_hash in done:
                counts["already"] += 1
                continue
            where = f"{plan.relative}, page {page} of {page_count}" if page else str(plan.relative)
            picked = None if picks is None else "in" if piece_hash in picks["include"] else "out" if piece_hash in picks["exclude"] else "new"
            if picked == "out":
                counts["unpicked"] += 1
                if piece_hash not in skipped_before:
                    to_skip.add(piece_hash)
                continue
            if picked != "in" and piece_hash in skipped_before:
                counts["skipped_before"] += 1
                continue
            if picked == "new" and not ask:
                counts["skipped"] += 1
                click.echo(f"- {where}: not in your picks (new since the survey?). Survey again, or add --ask.")
                continue
            click.echo(f"+ {where}\n    {describe(plan)}")
            if dry_run:
                counts["added"] += 1
                continue
            if ask and picked != "in":
                answer = ask_about(path)
                if answer == "q":
                    stopped = True
                    break
                if answer == "n":
                    counts["skipped"] += 1
                    to_skip.add(piece_hash)
                    continue
            try:
                if page:
                    original = (f"{path.stem} p{page}.pdf", single_page_pdf(path, page), "application/pdf")
                else:
                    original = (path.name, path.read_bytes(), TYPES[path.suffix.lower()])
                if len(original[1]) > MAX_BYTES:
                    counts["skipped"] += 1
                    click.echo("    too big (the limit is 85 MB)")
                    continue
                im = open_image(path, page or 1)
            except Exception as e:
                counts["skipped"] += 1
                click.echo(f"    couldn’t open it: {e}")
                continue
            display, width, height = jpeg(im, 2000, 85)
            thumb, _, _ = jpeg(im, 480, 80)
            meta = {
                "kid_id": plan.kid["id"],
                "made": plan.made,
                "made_precision": plan.precision,
                "title": plan.title,
                "width": width,
                "height": height,
                "source_hash": piece_hash,
                "source_name": f"{plan.relative}#page={page}" if page else str(plan.relative),
            }
            files_out = {
                "original": original,
                "display": ("display.jpg", display, "image/jpeg"),
                "thumb": ("thumb.jpg", thumb, "image/jpeg"),
            }
            check(client.post("/api/pieces", data={"meta": json.dumps(meta)}, files=files_out))
            done.add(piece_hash)
            counts["added"] += 1
        if stopped:
            break
    return stopped


if __name__ == "__main__":
    cli()
