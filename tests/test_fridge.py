"""The import script's guesses about whose a file is and when it was made,
and the copies it makes. Kid names here are made up."""

import re
import tomllib
from pathlib import Path

import pytest
from PIL import Image

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


def test_script_pins_match_pyproject():
    root = Path(__file__).parent.parent
    header = re.search(r"^# /// script\n(.*?)^# ///$", (root / "scripts" / "fridge.py").read_text(), re.S | re.M)[1]
    script = tomllib.loads("\n".join(line.removeprefix("# ").removeprefix("#") for line in header.splitlines()))
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    assert script["dependencies"] == project["dependencies"]
