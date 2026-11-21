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


@pytest.fixture(autouse=True)
def saved_folders(tmp_path, monkeypatch):
    """Keep every test away from the real saved folders on this computer."""
    path = tmp_path / "config" / "folders.toml"
    monkeypatch.setenv("FRIDGE_FOLDERS", str(path))
    return path


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
        ("2026-03-01 Ada Art Bundle rocket ship", "Ada", "Rocket ship"),
        ("2025-11-05 Ada Big-Hill Art Bundle watercolour owl", "Ada", "Watercolour owl"),
        ("2026-03-10 Ada Art Bundle", "Ada", ""),
        ("Bo bundle castle", "Bo", "Castle"),
        ("2025-11-05 Theo Art Bundle kite", "Theodora", "Kite"),
        ("Theo's castle", "Theodora", "Castle"),
        ("the big tree", "Theodora", "The big tree"),
        ("me and bo", "Andrew", "Me and bo"),
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
        (Path("scan.pdf"), "2024", "", fridge.survey_file(pdf), pdf_hash, pdf, tmp_path),
        (Path("sun.png"), "2024", "", fridge.survey_file(png), png_hash, png, tmp_path),
    ]
    known = ({fridge.page_hash(pdf_hash, 1)}, {png_hash})
    page = fridge.report_html([tmp_path], rows, "summary", known)
    boxes = dict(re.findall(r'<input type="checkbox" data-id="([0-9a-f]{64})"( checked)?>', page))
    assert fridge.page_hash(pdf_hash, 1) not in boxes, "on the fridge: no box"
    assert page.count("On the fridge</span>") == 1
    assert boxes[png_hash] == "", "skipped before: unticked"
    assert "Skipped before · " in page
    assert boxes[fridge.page_hash(pdf_hash, 3)] == "", "new but plain: unticked"
    assert 'class="blank st-blank"' in page, "a multi-page PDF's blank page isn't new"
    assert '<body class="view-new">' in page and 'data-view="skipped"' in page
    offline = fridge.report_html([tmp_path], rows, "summary")
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
    other = tmp_path / "School"
    picks.write_text(json.dumps({"version": 2, "folders": [str(root), str(other)], "include": ["a"], "exclude": ["b"]}))
    loaded = fridge.load_picks(picks)
    assert loaded == {"include": {"a"}, "exclude": {"b"}, "folders": [root, other]}
    assert fridge.picks_cover(loaded, root) and fridge.picks_cover(loaded, other)
    assert fridge.picks_cover(loaded, root / "2024"), "a subfolder of a surveyed folder"
    assert fridge.picks_cover(loaded, tmp_path), "a folder around one"
    assert not fridge.picks_cover(loaded, tmp_path / "Elsewhere")
    picks.write_text(json.dumps({"version": 1, "folder": str(root), "include": ["a"], "exclude": []}))
    assert fridge.load_picks(picks)["folders"] == [root], "picks saved before folders could be saved still work"
    picks.write_text(json.dumps({"version": 3, "folders": [str(root)], "include": [], "exclude": []}))
    with pytest.raises(click.ClickException, match="isn’t a picks file"):
        fridge.load_picks(picks)


def test_saved_folders(tmp_path, saved_folders):
    art, school = tmp_path / "Ada" / "Art", tmp_path / "Bo" / "School \"quoted\""
    art.mkdir(parents=True)
    school.mkdir(parents=True)
    run = lambda *args: CliRunner().invoke(fridge.cli, list(args))
    assert "No folders saved yet" in run("folders", "list").output
    assert run("folders", "add", str(art), "--kid", "Ada").exit_code == 0
    result = run("folders", "add", str(school), "--kid", "Bo")
    assert result.exit_code == 0 and "Folders saved: 2" in result.output
    assert run("folders", "add", str(art), "--kid", "Ada").output.endswith(f"Folders saved: 2, in {saved_folders}.\n"), "adding again replaces"
    assert fridge.load_folders() == [(school, "Bo"), (art, "Ada")]
    assert tomllib.loads(saved_folders.read_text())["folder"][0]["path"] == str(school)
    listed = run("folders", "list").output
    assert f"Bo · {school}\n" in listed and f"Ada · {art}\n" in listed
    assert run("folders", "add", str(art)).exit_code != 0, "a saved folder needs its kid"
    assert run("folders", "remove", str(tmp_path / "nope")).exit_code != 0
    assert run("folders", "remove", str(school)).exit_code == 0
    assert fridge.load_folders() == [(art, "Ada")]


def test_what_survey_and_import_work_on(tmp_path):
    with pytest.raises(click.ClickException, match="Name a folder, or save some first"):
        fridge.targets_for(None, None)
    art = tmp_path / "Art"
    fridge.save_folders([(art, "Ada"), (tmp_path / "Gone", "Bo")])
    assert fridge.targets_for(None, None) == [(art, "Ada"), (tmp_path / "Gone", "Bo")]
    assert fridge.targets_for(art, None) == [(art.resolve(), "Ada")], "a saved folder brings its kid"
    assert fridge.targets_for(art, "Bo") == [(art.resolve(), "Bo")], "--kid wins"
    assert fridge.targets_for(tmp_path / "Other", None) == [((tmp_path / "Other").resolve(), None)]
    with pytest.raises(click.ClickException, match="--kid goes with a folder"):
        fridge.targets_for(None, "Ada")


def test_survey_covers_every_saved_folder_in_one_report(tmp_path):
    ada, bo = tmp_path / "Ada" / "Artwork", tmp_path / "Bo" / "Artwork"
    for folder in (ada, bo):
        folder.mkdir(parents=True)
        art_page().save(folder / "sun.png")
    fridge.save_folders([(ada, "Ada"), (bo, "Bo"), (tmp_path / "Gone", "Bo")])
    report = tmp_path / "report.html"
    result = CliRunner().invoke(fridge.cli, ["survey", "--offline", "--report", str(report), "--no-open"])
    assert result.exit_code == 0, result.output
    assert f"== {ada} (Ada)" in result.output and f"== {bo} (Bo)" in result.output
    assert f"== {tmp_path / 'Gone'} (Bo)\n- not found, so left out" in result.output
    assert "2 files with 2 pages" in result.output
    assert "uv run scripts/fridge.py import --picks ~/Downloads/fridge-picks-saved-folders.json" in result.output
    page = report.read_text()
    assert page.count('<h2 class="folder">') == 2, "a heading per folder"
    assert json.dumps([str(ada), str(bo)]) in page, "the picks name the folders looked at"
    assert '"fridge-picks-saved-folders.json"' in page


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


# ---- Families ----
# A fake fridge with two made-up families: the Pines (Ada and Bo) and the
# Oaks (Cy and Dee), and Di in no family. The rule is the Worker's, and
# refusals come back as the Worker sends them.
class FakeFridge:
    def __init__(self, families=("pine",)):
        self.session = {"email": "pine@example.com", "canEdit": True, "families": list(families)}
        self.families = [{"id": "pine", "name": "The Pines"}, {"id": "oak", "name": "The Oaks"}]
        self.kids = [
            {"id": 1, "name": "Ada", "born": "2019-04-02", "family": "pine"},
            {"id": 2, "name": "Bo", "born": "2021-07-02", "family": "pine"},
            {"id": 3, "name": "Cy", "born": "2020-02-02", "family": "oak"},
            {"id": 4, "name": "Dee", "born": "2018-05-05", "family": "oak"},
            {"id": 5, "name": "Di", "born": "2018-05-05", "family": None},
        ]
        self.sent = []

    def handle(self, request):
        import httpx

        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        self.sent.append((request.method, request.url.path, body))
        if request.url.path == "/api/session":
            return httpx.Response(200, json=self.session)
        if request.url.path == "/api/gallery":
            return httpx.Response(200, json={"kids": self.kids, "pieces": [], "families": self.families})
        if request.url.path == "/api/imported":
            return httpx.Response(200, json={"hashes": [], "skipped": []})
        if request.method == "POST" and request.url.path == "/api/kids":
            return httpx.Response(201, json={"id": 9, "family": body.get("family", "pine")})
        if request.method == "PATCH" and request.url.path.startswith("/api/kids/"):
            kid = next(k for k in self.kids if k["id"] == int(request.url.path.rsplit("/", 1)[1]))
            if not fridge.can_change(kid, self.session):
                return httpx.Response(403, json={"error": f"{kid['name']} is in another family. Only their family’s parents can change {kid['name']} or their art."})
            return httpx.Response(200, json={"ok": True})
        if request.method == "POST" and request.url.path == "/api/pieces":
            return httpx.Response(201, json={"id": len(self.sent)})
        return httpx.Response(404, json={"error": "There’s nothing at that address."})


@pytest.fixture
def fake(monkeypatch):
    import httpx

    f = FakeFridge()
    monkeypatch.setattr(fridge, "connect", lambda url: httpx.Client(base_url="http://fridge.test", transport=httpx.MockTransport(f.handle)))
    return f


def run(*args):
    return CliRunner().invoke(fridge.cli, list(args))


def test_the_rule_matches_the_fridges():
    session = {"canEdit": True, "families": ["pine"]}
    assert fridge.can_change({"family": "pine"}, session)
    assert fridge.can_change({"family": None}, session), "a kid in no family"
    assert not fridge.can_change({"family": "oak"}, session)
    assert not fridge.can_change({"family": None}, {"canEdit": False, "families": []}), "a viewer"
    assert fridge.can_change({"family": None}, {"canEdit": True, "families": []}), "no families set up"


def test_add_kid_says_which_family(fake):
    assert run("add-kid", "Ada", "2019-04-02").exit_code == 0
    assert fake.sent[-1] == ("POST", "/api/kids", {"name": "Ada", "born": "2019-04-02"}), "the fridge picks the parent's family"
    result = run("add-kid", "Ada", "2019-04-02", "--family", "pine")
    assert fake.sent[-1][2]["family"] == "pine"
    assert "Added Ada (kid 9), in family pine." in result.output
    run("add-kid", "Ada", "2019-04-02", "--family", "none")
    assert fake.sent[-1][2]["family"] is None


def test_set_family_puts_a_kid_in_a_family(fake):
    result = run("set-family", "di", "pine")
    assert result.exit_code == 0, result.output
    assert fake.sent[-1] == ("PATCH", "/api/kids/5", {"family": "pine"})
    assert "Di is in family pine now." in result.output
    assert run("set-family", "5", "none").exit_code == 0
    assert fake.sent[-1] == ("PATCH", "/api/kids/5", {"family": None})

    result = run("set-family", "Di", "elm")
    assert result.exit_code == 1 and "There's no family elm. The fridge has: pine, oak" in result.output
    assert run("set-family", "Eli", "pine").output.startswith("Error: No kid called Eli. The fridge has: Ada, Bo, Cy, Dee, Di")
    fake.kids.append({"id": 6, "name": "Ada", "born": "2022-01-01", "family": None})
    assert "There are 2 kids called Ada: kids 1, 6. Use the number instead." in run("set-family", "Ada", "pine").output
    assert all(method != "PATCH" or path == "/api/kids/5" for method, path, _ in fake.sent), "nothing sent when it can't tell"


def test_a_refusal_is_said_plainly(fake):
    result = run("set-family", "Cy", "pine")
    assert result.exit_code == 1
    assert result.output == "Error: The fridge said: Cy is in another family. Only their family’s parents can change Cy or their art. (HTTP 403)\n"
    assert isinstance(result.exception, SystemExit), "no traceback"


def test_families_lists_them_and_their_kids(fake):
    result = run("families")
    assert result.exit_code == 0, result.output
    assert "The Pines, id pine (yours): Ada, Bo\nThe Oaks, id oak: Cy, Dee\nIn no family, so any parent can change them: Di\n" in result.output
    fake.families = []
    assert "No families are set up" in run("families").output


def test_import_brings_in_only_your_familys_kids(fake, tmp_path):
    for kid, paper in (("Ada", "white"), ("Cy", (241, 198, 208)), ("Di", (250, 240, 200))):
        (tmp_path / kid).mkdir()
        art_page(paper).save(tmp_path / kid / f"2024-05-29 {kid.lower()} sun.png")
    result = run("import", str(tmp_path))
    assert result.exit_code == 0, result.output
    posted = [path for method, path, _ in fake.sent if method == "POST"]
    assert posted == ["/api/pieces", "/api/pieces"], "Ada's and Di's"
    assert "Cy/2024-05-29 cy sun.png: it’s Cy’s, and Cy is in another family, so only their family can import it" in result.output
    assert "Added 2." in result.output

    result = run("import", str(tmp_path / "Cy"), "--kid", "Cy")
    assert result.exit_code == 1 and "Cy is in another family, so only their family can import Cy’s art." in result.output
    fake.session["families"] = []
    for kid in fake.kids:
        kid["family"] = kid["family"] and "elsewhere"
    fake.kids = [k for k in fake.kids if k["family"]]
    assert "Every kid on the fridge is in another family" in run("import", str(tmp_path)).output
