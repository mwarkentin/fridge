"""Add art on the page and the import script must agree, so the fridge never
gets the same piece twice and both leave out the same blank pages. These run
the page's own modules (public/add/, through tests/browser_side.mjs and
Node) and the script on the same files, names and pixels. Kid names here are
made up; every picture is made here."""

import json
import random
import shutil
import subprocess
from pathlib import Path

import pillow_heif
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw

import fridge
from test_fridge import art_page, document_page, three_page_pdf

ROOT = Path(__file__).parent.parent
NODE = shutil.which("node")


def browser(tmp_path: Path, **ask) -> dict:
    """What the page's modules answer, run in Node."""
    assert NODE, "these tests need Node (npm ci) to run the page's modules"
    request, answer = tmp_path / "ask.json", tmp_path / "answer.json"
    request.write_text(json.dumps(ask))
    subprocess.run([NODE, str(ROOT / "tests" / "browser_side.mjs"), str(request), str(answer)], check=True, capture_output=True, cwd=ROOT)
    return json.loads(answer.read_text())


def blank(paper="white"):
    return Image.new("RGB", (425, 550), paper)


def speckled():
    """A blank page as a scanner sees it: a little grey noise and a shadow."""
    im = blank((246, 245, 241))
    d = ImageDraw.Draw(im)
    rng = random.Random(4)
    for _ in range(300):
        x, y = rng.randrange(425), rng.randrange(550)
        d.point((x, y), fill=(200, 200, 200))
    d.rectangle([0, 0, 6, 550], fill=(225, 224, 220))
    return im


def doodle():
    """Mostly blank, with one small crayon mark: not blank."""
    im = blank()
    ImageDraw.Draw(im).ellipse([180, 240, 230, 300], outline=(216, 52, 44), width=6)
    return im


def pencil():
    im = blank()
    d = ImageDraw.Draw(im)
    for i in range(12):
        d.line([(60 + i * 25, 120), (90 + i * 22, 420)], fill=(90, 90, 95), width=2)
    return im


def pdf_of(path: Path, pages: list[Image.Image]) -> Path:
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=50)
    return path


def test_the_page_names_pieces_as_the_script_does(tmp_path):
    files = [
        pdf_of(tmp_path / "2024-05-29 scan.pdf", [art_page(), blank(), document_page()]),
        pdf_of(tmp_path / "one page.pdf", [art_page()]),
        pdf_of(tmp_path / "two pages.pdf", [art_page(), art_page((241, 198, 208))]),
    ]
    art_page().save(tmp_path / "IMG_1234.jpg", quality=90)
    art_page().save(tmp_path / "rocket.png")
    art_page().save(tmp_path / "sun.webp")
    files += [tmp_path / "IMG_1234.jpg", tmp_path / "rocket.png", tmp_path / "sun.webp"]
    page = browser(tmp_path, files=[str(f) for f in files])["files"]
    for f, seen in zip(files, page):
        digest = fridge.sha256(f)
        assert seen["hash"] == digest, f.name
        pages = fridge.survey_file(f)
        assert seen["count"] == len(pages), f.name
        assert seen["pieces"] == [fridge.piece_id(digest, p) for p in pages], f.name
        # And the pieces import makes are among them, by the same names.
        pieces, _ = fridge.pieces_for(f, digest)
        assert {h for h, _, _ in pieces} <= set(seen["pieces"]), f.name
    assert page[1]["pieces"] == [fridge.sha256(files[1])], "a one-page PDF is the file's own hash"
    assert len(set(page[0]["pieces"])) == 3 and fridge.sha256(files[0]) not in page[0]["pieces"]


TITLES = [
    ("2024-05-29_ada_rocket-to-the-moon", "Ada"),
    ("IMG_1234", "Ada"),
    ("Scan 3", "Ada"),
    ("Bo's dragon (May 2025)", "Bo"),
    ("me-age-8", "Ada"),
    ("me-and-ada", "Bo"),
    ("2026-03-01 Ada Art Bundle rocket ship", "Ada"),
    ("2025-11-05 Ada Big-Hill Art Bundle watercolour owl", "Ada"),
    ("2026-03-10 Ada Art Bundle", "Ada"),
    ("Bo bundle castle", "Bo"),
    ("2025-11-05 Theo Art Bundle kite", "Theodora"),
    ("Theo's castle", "Theodora"),
    ("the big tree", "Theodora"),
    ("me and bo", "Andrew"),
    ("PXL_20240529_123456789", "Ada"),
    ("IMG_20231102_101500", "Bo"),
    ("Scan 2024-05-29 (2)", "Ada"),
    ("ADA'S BIG RED DOG", "Ada"),
    ("Adas house", "Ada"),
    ("Adam's house", "Ada"),
    ("Ada-and-Bo at the beach", "Ada"),
    ("bundle", "Ada"),
    ("artbundle robot", "Ada"),
    ("Art_Bundle_2024_dinosaur", "Bo"),
    ("Sept 2023 apple tree", "Bo"),
    ("2024.05.29 snowman", "Ada"),
    ("2024 05 bird", "Ada"),
    ("20240229 leap day", "Ada"),
    ("my drawing 3", "Ada"),
    ("Page 2 of the story", "Ada"),
    ("final copy final", None),
    ("été au lac", "Åda"),
    ("Åda's été", "Åda"),
    ("ÅDA in the snow", "Åda"),
    ("Theodora", "Theodora"),
    ("  spaces   and__underscores  ", "Bo"),
    ("[draft] (big) cat.", None),
    ("1999-12-31 party", "Ada"),
    ("rocket", None),
    ("", "Ada"),
]

DATES = [
    "2024-05-29 rocket", "20240529_rocket", "rocket 2024-05", "May 2024", "2023", "2022 then 2023-06-01 sun",
    "2024-13-01 not a month", "2024-02-30 not a day 2024-03-01", "20240230", "IMG_20231102_101500", "PXL_20240529_123456789",
    "Sept. 2023", "sept-2023", "December, 2021 snow", "dec2021", "mayday 2020", "1899 old", "2100 future", "12024", "202405",
    "2024_05_29", "2024 05 29", "2024.05", "2024-5-29", "IMG_1234", "", "my-may-2019-drawing", "Mar 2019 and 2018-04-04",
]


def test_the_page_guesses_titles_and_dates_as_the_script_does(tmp_path):
    # Not "file.": Python 3.14 gives it the stem "file", and 3.13 "file.". The
    # title is the same either way.
    names = ["rocket.jpg", "Scan 3.PDF", "a.b.c.png", ".hidden", "no extension", "IMG_1234.jpeg"]
    page = browser(tmp_path, titles=TITLES, dates=DATES, stems=names)
    assert page["titles"] == [fridge.title_from(stem, owner) for stem, owner in TITLES]
    assert page["dates"] == [list(d) if (d := fridge.date_in(t)) else None for t in DATES]
    assert page["stems"] == [Path(n).stem for n in names]


PAGES = {
    "art": art_page,
    "art on pink paper": lambda: art_page((241, 198, 208)),
    "document": document_page,
    "pencil drawing": pencil,
    "blank": blank,
    "construction paper": lambda: blank((241, 198, 208)),
    "speckled scan of a blank page": speckled,
    "one small doodle": doodle,
}


def test_the_page_finds_the_same_blank_pages(tmp_path):
    """The script's measure and the page's on the same renders: the survey's
    320-pixel look at each page, through pdfium."""
    pdf = pdf_of(tmp_path / "pages.pdf", [make() for make in PAGES.values()])
    pages = fridge.survey_file(pdf)
    pixels = []
    for name, p in zip(PAGES, pages):
        raw = tmp_path / f"{len(pixels)}.rgba"
        raw.write_bytes(p.thumb.convert("RGBA").tobytes())
        pixels.append({"path": str(raw), "width": p.thumb.width, "height": p.thumb.height})
    seen = browser(tmp_path, pixels=pixels)["measures"]
    for name, p, s in zip(PAGES, pages, seen):
        assert s["kind"] == p.kind, name
        assert s["measure"] == pytest.approx([p.ink, p.coloured], abs=1e-12), name
    assert [p.kind for p in pages] == ["art", "art", "plain", "plain", "blank", "blank", "blank", "art"]


def test_the_page_shrinks_pages_as_pillow_does(tmp_path):
    """Odd sizes, landscape and tiny, so every rounding in the thumbnail is hit."""
    rng = random.Random(7)
    pixels, images = [], []
    for w, h in [(320, 248), (248, 320), (320, 181), (217, 320), (201, 200), (199, 320), (320, 1), (90, 60)]:
        im = Image.frombytes("RGB", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 3)))
        raw = tmp_path / f"{w}x{h}.rgba"
        raw.write_bytes(im.convert("RGBA").tobytes())
        pixels.append({"path": str(raw), "width": w, "height": h})
        images.append(im)
    seen = browser(tmp_path, pixels=pixels)["measures"]
    for im, s in zip(images, seen):
        assert s["measure"] == pytest.approx(list(fridge.measure(im)), abs=1e-12), im.size


def with_exif(original: str | None = None, plain: str | None = None) -> Image.Exif:
    exif = Image.Exif()
    if plain:
        exif[306] = plain
    if original is not None:
        exif.get_ifd(0x8769)[36867] = original
    return exif


def test_the_page_reads_photo_dates_as_the_script_does(tmp_path):
    pillow_heif.register_heif_opener()
    im = art_page()
    cases = {
        "taken.jpg": with_exif(original="2023:06:14 10:11:12", plain="2025:01:01 00:00:00"),
        "only-datetime.jpg": with_exif(plain="2022:12:24 18:00:00"),
        "no-date.jpg": None,
        "not-a-day.jpg": with_exif(original="2024:02:30 10:00:00"),
        "empty-original.jpg": with_exif(original="", plain="2021:03:04 05:06:07"),
        "taken.png": with_exif(original="2020:08:09 10:00:00"),
        "taken.webp": with_exif(original="2019:10:11 12:00:00"),
        "taken.tif": with_exif(original="2018:01:02 03:04:05"),
        "taken.heic": with_exif(original="2017:05:06 07:08:09"),
    }
    paths = []
    for name, exif in cases.items():
        path = tmp_path / name
        im.save(path, **({"exif": exif.tobytes()} if exif is not None else {}))
        paths.append(path)
    pdf_of(tmp_path / "scan.pdf", [im])
    paths.append(tmp_path / "scan.pdf")
    seen = browser(tmp_path, photoDates=[str(p) for p in paths])["photoDates"]
    assert seen == [fridge.photo_date(p) for p in paths]
    assert seen[:3] == ["2023-06-14", "2022-12-24", None]
    assert seen[5:9] == ["2020-08-09", "2019-10-11", "2018-01-02", "2017-05-06"]


def test_a_page_the_page_takes_out_of_a_pdf_is_that_page(tmp_path):
    """The page uploads each page of a multi-page PDF as a PDF of its own, as
    the script does: the right page, and only it."""
    assert NODE
    pdf = three_page_pdf(tmp_path / "scan.pdf")
    script = tmp_path / "extract.mjs"
    script.write_text(
        "import { readFileSync, writeFileSync } from 'node:fs';\n"
        f"const lib = await import({json.dumps((ROOT / 'public/pdfjs/pdf.min.mjs').as_uri())});\n"
        f"lib.GlobalWorkerOptions.workerSrc = {json.dumps(str(ROOT / 'public/pdfjs/pdf.worker.min.mjs'))};\n"
        "const doc = await lib.getDocument({ data: new Uint8Array(readFileSync(process.argv[2])), useWasm: false, verbosity: 0 }).promise;\n"
        "writeFileSync(process.argv[3], await doc.extractPages([{ document: null, includePages: [2] }]));\n"
        "await doc.loadingTask.destroy();\n"
    )
    out = tmp_path / "page3.pdf"
    subprocess.run([NODE, str(script), str(pdf), str(out)], check=True, capture_output=True, cwd=ROOT)
    pages = fridge.survey_file(out)
    assert len(pages) == 1 and pages[0].kind == "plain"
    assert pages[0].size_in == pytest.approx((8.5, 11), abs=0.05)
    assert len(pdfium.PdfDocument(str(out))) == 1
