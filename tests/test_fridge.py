"""The import script's guesses about whose a file is and when it was made,
and the copies it makes. Kid names here are made up."""

import json
import re
import tomllib
from pathlib import Path

import click
import pytest
from click.testing import CliRunner
from PIL import Image, ImageDraw

import fridge

KIDS = [{"id": 1, "name": "Ada", "born": "2019-04-02"}, {"id": 2, "name": "Bo", "born": "2021-07-02"}]


@pytest.mark.parametrize(
    "path, expected",
    [
        ("Ada/2024-05-29 rocket.jpg", ("2024-05-29", "day", "file name")),
        ("Ada/20240529_rocket.jpg", ("2024-05-29", "day", "file name")),
        ("Ada/rocket 2024-05.png", ("2024-05-15", "month", "file name")),
        ("Ada/May 2024/rocket.png", ("2024-05-15", "month", "folder name")),
        ("Ada/2023/rocket.jpg", ("2023-07-01", "year", "folder name")),
        ("2022/Ada/2023-06-01 sun.jpg", ("2023-06-01", "day", "file name")),
        ("Ada/2024-13-01 not a month.jpg", ("2024-07-01", "year", "file name")),
    ],
)
def test_dates_from_paths(path, expected):
    assert fridge.date_from_path(Path(path)) == expected


def test_no_date_in_path():
    assert fridge.date_from_path(Path("Ada/rocket.jpg")) is None


@pytest.mark.parametrize(
    "path, kid",
    [
        ("Ada/rocket.jpg", "Ada"),
        ("drawings/ada-rocket.jpg", "Ada"),
        ("Bo's drawings/sun.jpg", "Bo"),
        ("Adam/rocket.jpg", None),
        ("Ada and Bo/together.jpg", None),
        ("Bo/me-and-ada.jpg", "Bo"),
        ("misc/ada-and-bo.jpg", None),
        ("misc/scan.jpg", None),
    ],
)
def test_whose_it_is(path, kid):
    found = fridge.match_kid(Path(path), KIDS)
    assert (found and found["name"]) == kid


@pytest.mark.parametrize(
    "stem, owner, title",
    [
        ("2024-05-29_ada_rocket-to-the-moon", "Ada", "Rocket to the moon"),
        ("IMG_1234", "Ada", ""),
        ("Scan 3", "Ada", ""),
        ("Bo's dragon (May 2025)", "Bo", "Dragon"),
        ("me-age-8", "Ada", "Me age 8"),
        ("me-and-ada", "Bo", "Me and ada"),
    ],
)
def test_titles(stem, owner, title):
    assert fridge.title_from(stem, owner) == title


def test_plan_falls_back_to_a_guessed_month(tmp_path):
    f = tmp_path / "Ada" / "rocket.png"
    f.parent.mkdir()
    Image.new("RGB", (10, 10)).save(f)
    plan = fridge.plan_for(f, tmp_path, KIDS, None)
    assert plan.kid["name"] == "Ada"
    assert plan.precision == "month" and plan.made.endswith("-15")
    assert "guess" in plan.made_from


def test_plan_needs_a_kid(tmp_path):
    f = tmp_path / "rocket.png"
    Image.new("RGB", (10, 10)).save(f)
    assert "whose" in fridge.plan_for(f, tmp_path, KIDS, None).problem
    assert fridge.plan_for(f, tmp_path, KIDS, KIDS[1]).problem is None


def test_copies_are_small_flat_jpegs(tmp_path):
    f = tmp_path / "big.png"
    Image.new("RGBA", (3000, 2400), (255, 0, 0, 0)).save(f)
    im = fridge.open_image(f)
    assert im.mode == "RGB" and im.getpixel((0, 0)) == (255, 255, 255)
    data, w, h = fridge.jpeg(im, 2000, 85)
    assert (w, h) == (2000, 1600) and data[:2] == b"\xff\xd8"
    _, w, h = fridge.jpeg(im, 480, 80)
    assert (w, h) == (480, 384)


def test_reads_the_first_page_of_a_pdf(tmp_path):
    f = tmp_path / "scan.pdf"
    Image.new("RGB", (850, 1100), "white").save(f, resolution=100)
    im = fridge.open_image(f)
    assert im.mode == "RGB" and im.height > im.width


def test_ask_opens_the_file_then_asks_again(tmp_path):
    answers = iter(["o", "Y"])
    opened = []
    assert fridge.ask_about(tmp_path / "x.pdf", prompt=lambda *a, **k: next(answers), opener=opened.append) == "y"
    assert opened == [tmp_path / "x.pdf"]


def test_ask_defaults_to_no():
    seen = {}

    def prompt(text, **kwargs):
        seen.update(kwargs)
        return kwargs["default"]

    assert fridge.ask_about(Path("x.pdf"), prompt=prompt, opener=None) == "n"
    assert set(seen["type"].choices) == {"y", "n", "o", "q"}


def art_page(paper="white"):
    im = Image.new("RGB", (425, 550), paper)
    d = ImageDraw.Draw(im)
    for i, colour in enumerate([(216, 52, 44), (44, 111, 198), (244, 197, 27), (61, 155, 63)]):
        d.ellipse([40 + i * 80, 120 + i * 60, 160 + i * 80, 260 + i * 60], fill=colour)
    return im


def document_page():
    im = Image.new("RGB", (425, 550), "white")
    d = ImageDraw.Draw(im)
    for line in range(30):
        d.rectangle([40, 60 + line * 15, 380, 66 + line * 15], fill=(30, 30, 30))
    d.ellipse([30, 10, 70, 50], fill=(30, 90, 200))  # a coloured logo doesn't make it art
    return im


@pytest.mark.parametrize(
    "make, kind",
    [
        (art_page, "art"),
        (lambda: art_page(paper=(241, 198, 208)), "art"),
        (document_page, "plain"),
        (lambda: Image.new("RGB", (425, 550), "white"), "blank"),
        (lambda: Image.new("RGB", (425, 550), (241, 198, 208)), "blank"),  # construction paper
    ],
)
def test_measure_tells_art_from_documents_and_blanks(make, kind):
    page = fridge.Page(1, 1, None, *fridge.measure(make()), thumb=None)
    assert page.kind == kind


def three_page_pdf(path):
    pages = [art_page(), Image.new("RGB", (425, 550), "white"), document_page()]
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=50)
    return path


def test_survey_file_measures_each_page(tmp_path):
    pages = fridge.survey_file(three_page_pdf(tmp_path / "scan.pdf"))
    assert [p.kind for p in pages] == ["art", "blank", "plain"]
    assert all(p.count == 3 for p in pages)
    assert pages[0].size_in == pytest.approx((8.5, 11), abs=0.05)
    assert max(pages[0].thumb.size) <= 320


def test_a_multi_page_pdf_becomes_a_piece_per_page(tmp_path):
    pdf = three_page_pdf(tmp_path / "scan.pdf")
    pieces, blanks = fridge.pieces_for(pdf, "f" * 64)
    assert [(page, count) for _, page, count in pieces] == [(1, 3), (3, 3)]
    assert blanks == [2]
    hashes = [h for h, _, _ in pieces]
    assert len(set(hashes)) == 2 and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes)
    assert fridge.pieces_for(pdf, "f" * 64, split=False) == ([("f" * 64, None, 1)], [])


def test_a_single_page_file_stays_one_piece(tmp_path):
    f = tmp_path / "one.pdf"
    art_page().save(f, resolution=50)
    assert fridge.pieces_for(f, "a" * 64) == ([("a" * 64, None, 1)], [])
    png = tmp_path / "one.png"
    art_page().save(png)
    assert fridge.pieces_for(png, "b" * 64) == ([("b" * 64, None, 1)], [])


def test_each_page_gets_a_pdf_of_its_own(tmp_path):
    data = fridge.single_page_pdf(three_page_pdf(tmp_path / "scan.pdf"), 3)
    out = tmp_path / "page3.pdf"
    out.write_bytes(data)
    assert len(fridge.survey_file(out)) == 1
    assert fridge.survey_file(out)[0].kind == "plain"


def test_survey_reports_without_signing_in(tmp_path):
    folder = tmp_path / "Ada"
    (folder / "2024").mkdir(parents=True)
    three_page_pdf(folder / "2024" / "2024-05-29 ada rocket.pdf")
    art_page().save(folder / "2024" / "IMG_1234.png")
    report = tmp_path / "report.html"
    result = CliRunner().invoke(fridge.cli, ["--url", "http://localhost:1", "survey", str(folder), "--kid", "Ada", "--report", str(report), "--no-open"])
    assert result.exit_code == 0, result.output
    assert "2024-05-29 · “Rocket” · 3 pages: 1 art, 1 blank, 1 plain" in result.output
    assert "2024 · untitled · 1 page: 1 art" in result.output
    assert "Importing would add up to 3 pieces." in result.output
    assert "Couldn’t ask the fridge what it already has" in result.output
    assert "2 files with 4 pages; 1 PDF has several pages." in result.output
    page = report.read_text()
    assert page.count("data:image/jpeg;base64,") == 4
    assert "PDFs with several pages" in page
    assert "--kid Ada --picks ~/Downloads/fridge-picks-" in result.output

    # A box per piece, with the ids import uses; art starts ticked, plain and blank don't.
    pdf = folder / "2024" / "2024-05-29 ada rocket.pdf"
    file_hash = fridge.sha256(pdf)
    boxes = dict(re.findall(r'<input type="checkbox" data-id="([0-9a-f]{64})"( checked)?>', page))
    assert boxes[fridge.page_hash(file_hash, 1)] == " checked"
    assert boxes[fridge.page_hash(file_hash, 2)] == ""
    assert boxes[fridge.page_hash(file_hash, 3)] == ""
    assert boxes[fridge.sha256(folder / "2024" / "IMG_1234.png")] == " checked"
    assert f'href="{pdf.as_uri()}#page=3"' in page


def test_survey_offline_doesnt_ask_the_fridge(tmp_path):
    art_page().save(tmp_path / "sun.png")
    result = CliRunner().invoke(fridge.cli, ["--url", "http://localhost:1", "survey", str(tmp_path), "--offline", "--report", str(tmp_path / "r.html"), "--no-open"])
    assert result.exit_code == 0, result.output
    assert "Couldn’t ask" not in result.output


def test_status_of():
    known = ({"a"}, {"b"})
    assert [fridge.status_of(h, known) for h in "abc"] == ["on", "skipped", "new"]
    assert fridge.status_of("a", None) == "new"


def test_report_marks_what_the_fridge_knows(tmp_path):
    pdf = three_page_pdf(tmp_path / "scan.pdf")
    png = tmp_path / "sun.png"
    art_page().save(png)
    pdf_hash, png_hash = fridge.sha256(pdf), fridge.sha256(png)
    rows = [
        (Path("scan.pdf"), "2024", "", fridge.survey_file(pdf), pdf_hash, pdf),
        (Path("sun.png"), "2024", "", fridge.survey_file(png), png_hash, png),
    ]
    known = ({fridge.page_hash(pdf_hash, 1)}, {png_hash})
    page = fridge.report_html(tmp_path, rows, "summary", known)
    boxes = dict(re.findall(r'<input type="checkbox" data-id="([0-9a-f]{64})"( checked)?>', page))
    assert fridge.page_hash(pdf_hash, 1) not in boxes, "on the fridge: no box"
    assert page.count("On the fridge</span>") == 1
    assert boxes[png_hash] == "", "skipped before: unticked"
    assert "Skipped before · " in page
    assert boxes[fridge.page_hash(pdf_hash, 3)] == "", "new but plain: unticked"
    assert 'class="blank st-blank"' in page, "a multi-page PDF's blank page isn't new"
    assert '<body class="view-new">' in page and 'data-view="skipped"' in page
    offline = fridge.report_html(tmp_path, rows, "summary")
    assert '<body class="view-all">' in offline and 'data-view="new"' not in offline


def test_piece_ids_match_what_import_uses(tmp_path):
    pdf = three_page_pdf(tmp_path / "scan.pdf")
    pieces, _ = fridge.pieces_for(pdf, "f" * 64)
    assert [fridge.piece_id("f" * 64, p) for p in fridge.survey_file(pdf) if p.kind != "blank"] == [h for h, _, _ in pieces]
    png = tmp_path / "one.png"
    art_page().save(png)
    assert fridge.piece_id("a" * 64, fridge.survey_file(png)[0]) == "a" * 64


def test_a_picked_blank_page_is_kept(tmp_path):
    pdf = three_page_pdf(tmp_path / "scan.pdf")
    pieces, blanks = fridge.pieces_for(pdf, "f" * 64, keep={fridge.page_hash("f" * 64, 2)})
    assert [page for _, page, _ in pieces] == [1, 2, 3] and blanks == []


def test_picks_files(tmp_path):
    root = tmp_path / "Artwork"
    (root / "2024").mkdir(parents=True)
    picks = tmp_path / "picks.json"
    picks.write_text(json.dumps({"version": 1, "folder": str(root), "include": ["a"], "exclude": ["b"]}))
    assert fridge.load_picks(picks, root) == {"include": {"a"}, "exclude": {"b"}}
    assert fridge.load_picks(picks, root / "2024")["include"] == {"a"}, "a subfolder of the surveyed folder"
    with pytest.raises(click.ClickException, match="not "):
        fridge.load_picks(picks, tmp_path / "Elsewhere")
    picks.write_text(json.dumps({"version": 2, "folder": str(root), "include": [], "exclude": []}))
    with pytest.raises(click.ClickException, match="isn’t a picks file"):
        fridge.load_picks(picks, root)


def test_picks_file_names_tell_two_kids_folders_apart():
    assert fridge.picks_name(Path("/x/Ada/Artwork")) == "fridge-picks-x-ada-artwork.json"
    assert fridge.picks_name(Path("/x/Ada/School/Big Hill PS")) == "fridge-picks-ada-school-big-hill-ps.json"
    assert fridge.picks_name(Path("/x/Bo/School/Big Hill PS")) == "fridge-picks-bo-school-big-hill-ps.json"
    assert fridge.picks_name(Path("/Art")) == "fridge-picks-art.json"


def test_script_pins_match_pyproject():
    root = Path(__file__).parent.parent
    header = re.search(r"^# /// script\n(.*?)^# ///$", (root / "scripts" / "fridge.py").read_text(), re.S | re.M)[1]
    script = tomllib.loads("\n".join(line.removeprefix("# ").removeprefix("#") for line in header.splitlines()))
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    assert script["dependencies"] == project["dependencies"]
