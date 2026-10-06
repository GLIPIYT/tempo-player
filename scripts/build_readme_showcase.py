#!/usr/bin/env python3
"""Build README image strips from captured UI screens; requires Pillow and Chrome/Edge."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / "docs" / "screenshots"
CAPTURES = SCREENSHOTS / "1.0.0"
HTML = SCREENSHOTS / "showcase.html"
COVER_GRID = CAPTURES / "library-cover-grid.png"
PAGE_WIDTH = 1280


def make_library_cover_grid() -> None:
    """Pull a small, faithful cover wall from the Home recommendation row."""
    with Image.open(CAPTURES / "01-home.png") as opened:
        source = opened.convert("RGB")

    tile_width, tile_height = 168, 238
    gap_x, gap_y = 14, 16
    padding = 18
    grid_width = 6 * tile_width + 5 * gap_x
    grid_height = 2 * tile_height + gap_y
    width, height = grid_width + 2 * padding, grid_height + 2 * padding

    canvas = Image.new("RGBA", (width, height), (17, 14, 21, 255))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (0, 0, width - 1, height - 1),
        radius=24,
        fill="#110e15",
        outline="#553044",
        width=2,
    )

    shadow_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    for index in range(12):
        row, col = divmod(index, 6)
        x = padding + col * (tile_width + gap_x)
        y = padding + row * (tile_height + gap_y)
        shadow_draw.rounded_rectangle(
            (x + 2, y + 7, x + tile_width + 2, y + tile_height + 7),
            radius=15,
            fill=(0, 0, 0, 105),
        )
    canvas = Image.alpha_composite(canvas, shadow_layer.filter(ImageFilter.GaussianBlur(8)))

    draw = ImageDraw.Draw(canvas)
    for index in range(12):
        row, col = divmod(index, 6)
        x = padding + col * (tile_width + gap_x)
        y = padding + row * (tile_height + gap_y)
        source_x = 300 + (index + 1) * 158
        card = source.crop((source_x, 760, source_x + 145, 965))
        card = ImageOps.fit(
            card,
            (tile_width, tile_height),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.46),
        )
        mask = Image.new("L", card.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, tile_width - 1, tile_height - 1), radius=14, fill=255
        )
        canvas.paste(card.convert("RGBA"), (x, y), mask)
        draw.rounded_rectangle(
            (x, y, x + tile_width - 1, y + tile_height - 1),
            radius=14,
            outline="#7e405e",
            width=1,
        )

    canvas.convert("RGB").save(COVER_GRID, format="PNG", optimize=True, compress_level=9)


def find_browser() -> Path:
    candidate = shutil.which("chrome") or shutil.which("msedge")
    if candidate:
        return Path(candidate)
    for path in (
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ):
        if path.is_file():
            return path
    raise RuntimeError("Google Chrome or Microsoft Edge is required to render the README screenshot strips.")


def browser_args(browser: Path, profile: Path) -> list[str]:
    return [
        str(browser),
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        f"--user-data-dir={profile}",
    ]


def render_height(browser: Path, locale: str) -> int:
    url = HTML.as_uri() + f"?lang={locale}"
    with tempfile.TemporaryDirectory(prefix=f"tempo-readme-measure-{locale}-") as temp:
        result = subprocess.run(
            browser_args(browser, Path(temp))
            + ["--window-size=1280,1000", "--virtual-time-budget=5000", "--dump-dom", url],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            check=False,
        )
    output = result.stdout + result.stderr
    match = re.search(r'data-render-height="(\d+)"', output)
    if not match:
        raise RuntimeError(f"Could not read the rendered page height for {locale}: {output[-1200:]}")
    height = int(match.group(1))
    if height < 3000 or height > 14000:
        raise RuntimeError(f"Unexpected README showcase height for {locale}: {height}")
    return height


def render_strip(browser: Path, locale: str, height: int) -> Path:
    output = SCREENSHOTS / f"tempo-showcase-{locale}.png"
    url = HTML.as_uri() + f"?lang={locale}"
    with tempfile.TemporaryDirectory(prefix=f"tempo-readme-render-{locale}-") as temp:
        profile = Path(temp) / "profile"
        result = subprocess.run(
            browser_args(browser, profile)
            + [
                f"--window-size={PAGE_WIDTH},{height}",
                "--virtual-time-budget=5000",
                f"--screenshot={output}",
                url,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    if not output.is_file():
        raise RuntimeError(f"The browser did not create {output}: {(result.stdout + result.stderr)[-1200:]}")
    with Image.open(output) as rendered:
        image = rendered.convert("RGB")
        if image.width != PAGE_WIDTH:
            raise RuntimeError(f"Unexpected screenshot width: {image.width}")
        if image.height > height:
            image = image.crop((0, 0, image.width, height))
        image.save(output, format="PNG", optimize=True, compress_level=9)
    return output


def main() -> None:
    make_library_cover_grid()
    browser = find_browser()
    for locale in ("en", "ru"):
        height = render_height(browser, locale)
        output = render_strip(browser, locale, height)
        print(f"{locale}: {output.relative_to(ROOT)} ({PAGE_WIDTH}x{height}, {output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
