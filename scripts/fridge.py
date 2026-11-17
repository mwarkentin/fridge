# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "click==8.5.0",
#     "httpx==0.28.1",
#     "pillow==13.0.0",
#     "pillow-heif==1.8.1",
#     "pypdfium2==5.14.0",
# ]
# ///
"""Bring scans into the fridge, and add the kids they belong to.

    uv run scripts/fridge.py login
    uv run scripts/fridge.py add-kid "Name" 2018-03-14
    uv run scripts/fridge.py import ~/Dropbox/Kids\\ Art --dry-run
    uv run scripts/fridge.py import ~/Dropbox/Kids\\ Art

It signs in as you through Cloudflare Access, with cloudflared
(brew install cloudflared), so it can do only what you can do on the page.

For each file it works out whose it is from a folder or file name that
matches a kid's name, and when it was made from a date in the file or folder
name (2024-05-29, 20240529, 2024-05, May 2024 or 2024). It makes the
screen-sized copy and thumbnail here, uploads them with the original, and
remembers each file by its contents, so running it again adds only new files.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
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


def title_from(stem: str, owner: str) -> str:
    """A title from the file name, without its date, the owner's name, or
    camera and scanner words. Other kids' names stay: "me and Bo"."""
    t = stem
    for rx in (DAY, MONTH, MONTH_NAME, YEAR):
        t = rx.sub(" ", t)
    t = name_pattern(owner).sub(" ", t)
    words = [w for w in re.sub(r"[-_.()\[\]]+", " ", t).split() if w.lower() not in NOT_TITLES]
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


def plan_for(path: Path, root: Path, kids: list[dict], forced_kid: dict | None) -> Plan:
    relative = path.relative_to(root)
    plan = Plan(path, relative, forced_kid or match_kid(relative, kids))
    if not plan.kid:
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
    if path.stat().st_size > MAX_BYTES:
        plan.problem = "too big (the limit is 85 MB)"
    return plan


# ---- Images ----
def open_image(path: Path) -> Image.Image:
    """The picture, the right way up, in RGB on white. A PDF gives its first page."""
    if path.suffix.lower() == ".pdf":
        pdf = pdfium.PdfDocument(str(path))
        try:
            im = pdf[0].render(scale=200 / 72).to_pil()
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


@cli.command("add-kid")
@click.argument("name")
@click.argument("born")
@click.pass_obj
def add_kid(url: str, name: str, born: str) -> None:
    """Add a kid, with their birthday as YYYY-MM-DD."""
    with connect(url) as client:
        kid = check(client.post("/api/kids", json={"name": name, "born": born}))
    click.echo(f"Added {name} (kid {kid['id']}).")


@cli.command("import")
@click.argument("folder", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--kid", "kid_name", help="Whose art it all is, when the folder names don’t say.")
@click.option("--dry-run", is_flag=True, help="Show what would happen, and change nothing.")
@click.pass_obj
def import_(url: str, folder: Path, kid_name: str | None, dry_run: bool) -> None:
    """Import every picture and PDF under FOLDER."""
    root = folder.expanduser().resolve()
    with connect(url) as client:
        kids = check(client.get("/api/gallery"))["kids"]
        if not kids:
            raise click.ClickException("Add the kids first: uv run scripts/fridge.py add-kid NAME YYYY-MM-DD")
        forced = None
        if kid_name:
            forced = next((k for k in kids if k["name"].lower() == kid_name.lower()), None)
            if not forced:
                raise click.ClickException(f"No kid called {kid_name}. The fridge has: {', '.join(k['name'] for k in kids)}")
        done = set(check(client.get("/api/imported"))["hashes"])

        files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TYPES and not p.name.startswith("."))
        counts = {"added": 0, "already": 0, "skipped": 0}
        for path in files:
            plan = plan_for(path, root, kids, forced)
            if plan.problem:
                counts["skipped"] += 1
                click.echo(f"- {plan.relative}: {plan.problem}")
                continue
            digest = sha256(path)
            if digest in done:
                counts["already"] += 1
                continue
            click.echo(f"+ {plan.relative}\n    {describe(plan)}")
            if dry_run:
                counts["added"] += 1
                continue
            try:
                im = open_image(path)
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
                "source_hash": digest,
                "source_name": str(plan.relative),
            }
            files_out = {
                "original": (path.name, path.read_bytes(), TYPES[path.suffix.lower()]),
                "display": ("display.jpg", display, "image/jpeg"),
                "thumb": ("thumb.jpg", thumb, "image/jpeg"),
            }
            check(client.post("/api/pieces", data={"meta": json.dumps(meta)}, files=files_out))
            done.add(digest)
            counts["added"] += 1

    verb = "Would add" if dry_run else "Added"
    click.echo(f"\n{verb} {counts['added']}. Already on the fridge: {counts['already']}. Skipped: {counts['skipped']}.")
    if dry_run and counts["added"]:
        click.echo("Fix any wrong names or dates in the files or folders, or on the page after importing, then run it again without --dry-run.")


if __name__ == "__main__":
    cli()
