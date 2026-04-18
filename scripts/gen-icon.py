#!/usr/bin/env python3
"""Use the Gemini glassmorphism source image directly as the procman
icon. No keying, no blending, no recoloring. Just resize and export."""
import os
import subprocess
import shutil
import tempfile
from PIL import Image

BASE_SIZE = 1024
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "assets")
SOURCE = os.path.join(REPO, "app/src-tauri/icons/icon.png")


def make_icon(size=BASE_SIZE):
    # Load source into memory first so we don't read-after-write when
    # the export overwrites the same path on disk.
    with open(SOURCE, "rb") as f:
        data = f.read()
    import io
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    # Center-crop to square if not already
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    return img.resize((size, size), Image.LANCZOS)


def save_sizes(master):
    os.makedirs(os.path.join(REPO, "assets"), exist_ok=True)
    master.save(os.path.join(REPO, "assets", "icon-1024.png"))
    print("  wrote assets/icon-1024.png")

    def write(path, size):
        resized = master.resize((size, size), Image.LANCZOS)
        full = os.path.join(REPO, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        resized.save(full)
        print(f"  wrote {path} ({size}x{size})")

    desktop = "app/src-tauri/icons"
    for name, sz in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
        ("StoreLogo.png", 50),
        ("Square30x30Logo.png", 30),
        ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71),
        ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107),
        ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150),
        ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310),
    ]:
        write(f"{desktop}/{name}", sz)

    for name, sz in [
        ("AppIcon-20x20@2x.png", 40),
        ("AppIcon-20x20@3x.png", 60),
        ("AppIcon-29x29@2x.png", 58),
        ("AppIcon-29x29@3x.png", 87),
        ("AppIcon-40x40@2x.png", 80),
        ("AppIcon-40x40@3x.png", 120),
        ("AppIcon-60x60@2x.png", 120),
        ("AppIcon-60x60@3x.png", 180),
        ("AppIcon-76x76@2x.png", 152),
        ("AppIcon-83.5x83.5@2x.png", 167),
        ("AppIcon-512@2x.png", 1024),
    ]:
        p = f"{desktop}/ios/{name}"
        if os.path.exists(os.path.join(REPO, p)):
            write(p, sz)

    mobile = "mobile/public"
    write(f"{mobile}/icon-192.png", 192)
    write(f"{mobile}/icon-512.png", 512)

    cap_ios = "mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset"
    if os.path.isdir(os.path.join(REPO, cap_ios)):
        write(f"{cap_ios}/AppIcon-512@2x.png", 1024)


def build_icns(master_path):
    iconset = tempfile.mkdtemp(suffix=".iconset")
    try:
        spec = [
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
        ]
        master = Image.open(master_path).convert("RGBA")
        for size, name in spec:
            master.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))
        out = os.path.join(REPO, "app/src-tauri/icons/icon.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)
        print("  wrote app/src-tauri/icons/icon.icns")
    finally:
        shutil.rmtree(iconset, ignore_errors=True)


if __name__ == "__main__":
    print("Using Gemini source as-is...")
    master = make_icon(BASE_SIZE)
    save_sizes(master)
    build_icns(os.path.join(REPO, "assets", "icon-1024.png"))
    print("Done.")
