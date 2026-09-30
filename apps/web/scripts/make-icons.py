#!/usr/bin/env python3
"""App icons from public/logo.png (run again after changing the logo: `bun run icons`).

Also stamps ?v=<hash of the logo> on the icon links in manifest.webmanifest and index.html.

Writes public/icons/icon-192.png, icon-512.png (as the logo, transparent corners), icon-maskable-512.png (full-bleed
brand yellow with the logo inside Android's safe zone), and public/apple-touch-icon.png + favicon-32.png (iOS fills
transparency with black, so the touch icon is flattened onto the brand yellow).
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "public"
BRAND = (0xF5, 0xB9, 0x14, 255)  # the logo's own yellow

logo = Image.open(ROOT / "logo.png").convert("RGBA")
(ROOT / "icons").mkdir(exist_ok=True)


def resized(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.LANCZOS)


def on_brand(size: int, scale: float) -> Image.Image:
    """The logo centered on a full brand-colour square, at `scale` of the side."""
    canvas = Image.new("RGBA", (size, size), BRAND)
    inner = resized(logo, round(size * scale))
    off = (size - inner.width) // 2
    canvas.alpha_composite(inner, (off, off))
    return canvas


resized(logo, 192).save(ROOT / "icons" / "icon-192.png", optimize=True)
resized(logo, 512).save(ROOT / "icons" / "icon-512.png", optimize=True)
# maskable: everything that matters inside the central 80% circle; the logo's own yellow blends into the background
on_brand(512, 0.8).save(ROOT / "icons" / "icon-maskable-512.png", optimize=True)
# iOS rounds the corners itself; no transparency (it would turn black)
on_brand(180, 1.0).convert("RGB").save(ROOT / "apple-touch-icon.png", optimize=True)
resized(logo, 32).save(ROOT / "favicon-32.png", optimize=True)
# cache-busting: the icon links carry a hash of the logo, so browsers and installed apps fetch the new icons
import hashlib, re
version = hashlib.sha256((ROOT / "logo.png").read_bytes()).hexdigest()[:8]
ICON_URL = re.compile(r'(/(?:icons/[\w-]+|apple-touch-icon|favicon-32|logo)\.png)(\?v=[0-9a-f]+)?')
for target in (ROOT / "manifest.webmanifest", ROOT.parent / "index.html"):
    text = target.read_text()
    target.write_text(ICON_URL.sub(lambda m: f"{m.group(1)}?v={version}", text))
print("icons written to", ROOT, "· version", version)
