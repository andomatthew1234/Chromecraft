"""Generate the branded Squirrel loading animation.

The GIF is committed because packaging must not depend on a Python toolchain.
Run this script from the repository root after changing the artwork.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "resources" / "installer" / "chromecraft-vanilla-installing.gif"
PREVIEW = ROOT / "resources" / "installer" / "chromecraft-vanilla-preview.png"
LOGO_PATH = ROOT / "resources" / "icons" / "chromecraft.png"

WIDTH = 268
HEIGHT = 167
FRAME_COUNT = 48
FRAME_DURATION_MS = 63


def font(size: int, semibold: bool = False) -> ImageFont.FreeTypeFont:
    filename = "seguisb.ttf" if semibold else "segoeui.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / filename), size)


def ease_out_cubic(value: float) -> float:
    return 1 - (1 - value) ** 3


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return mask


def place_logo(canvas: Image.Image, logo: Image.Image, progress: float) -> None:
    pulse = (math.sin(progress * math.tau) + 1) / 2
    float_y = round(math.sin(progress * math.tau) * 1.2)
    logo_size = 47
    logo_x = 23
    logo_y = 38 + float_y

    halo = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo)
    halo_radius = 34 + round(pulse * 2)
    halo_draw.ellipse(
        (
            logo_x + logo_size // 2 - halo_radius,
            logo_y + logo_size // 2 - halo_radius,
            logo_x + logo_size // 2 + halo_radius,
            logo_y + logo_size // 2 + halo_radius,
        ),
        fill=(242, 167, 139, 66),
    )
    halo = halo.filter(ImageFilter.GaussianBlur(13))
    canvas.alpha_composite(halo)

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.ellipse(
        (logo_x + 5, logo_y + logo_size - 2, logo_x + logo_size - 1, logo_y + logo_size + 9),
        fill=(76, 37, 27, 42),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(5)))

    resized = logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, (logo_x, logo_y))


def draw_progress(draw: ImageDraw.ImageDraw, progress: float) -> None:
    track_left = 22
    track_right = WIDTH - 22
    track_y = 139
    draw.rounded_rectangle(
        (track_left, track_y, track_right, track_y + 4),
        2,
        fill=(235, 211, 201, 255),
    )

    phase = progress * 1.12
    if phase <= 1:
        leading = ease_out_cubic(min(phase, 1))
    else:
        leading = 1
    fill_right = track_left + round((track_right - track_left) * leading)
    draw.rounded_rectangle(
        (track_left, track_y, max(track_left + 4, fill_right), track_y + 4),
        2,
        fill=(185, 77, 49, 255),
    )

    shimmer_x = track_left + int(((progress * 1.3) % 1) * (track_right - track_left))
    draw.ellipse((shimmer_x - 3, track_y - 1, shimmer_x + 3, track_y + 5), fill=(255, 220, 206, 230))

    for index, x in enumerate((196, 208, 220)):
        dot_phase = (progress * 3 - index * 0.18) % 1
        active = dot_phase < 0.34
        radius = 2 if active else 1
        colour = (185, 77, 49, 255) if active else (198, 163, 151, 255)
        draw.ellipse((x - radius, 119 - radius, x + radius, 119 + radius), fill=colour)


def render_frame(logo: Image.Image, frame_index: int) -> Image.Image:
    progress = frame_index / FRAME_COUNT
    canvas = Image.new("RGBA", (WIDTH, HEIGHT), (255, 248, 244, 255))
    draw = ImageDraw.Draw(canvas)

    # Quiet Vanilla pattern and accent curve.
    for x in range(8, WIDTH, 18):
        draw.line((x, 0, x, HEIGHT), fill=(250, 235, 228, 120), width=1)
    for y in range(5, HEIGHT, 18):
        draw.line((0, y, WIDTH, y), fill=(250, 235, 228, 120), width=1)
    draw.ellipse((200, -61, 302, 41), fill=(255, 230, 220, 255), outline=(239, 196, 181, 255), width=1)
    draw.arc((208, -52, 292, 32), 24, 164, fill=(185, 77, 49, 255), width=2)

    # Main elevated surface.
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((10, 12, 258, 154), 17, fill=(62, 28, 20, 38))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(7)))
    draw.rounded_rectangle(
        (9, 9, 258, 152),
        17,
        fill=(255, 252, 250, 255),
        outline=(231, 191, 176, 255),
        width=1,
    )

    place_logo(canvas, logo, progress)
    draw = ImageDraw.Draw(canvas)

    draw.text((82, 29), "CHROMECRAFT", font=font(8, True), fill=(74, 50, 43, 255))
    draw.text((143, 29), "VANILLA", font=font(8, True), fill=(185, 77, 49, 255))
    draw.text((81, 45), "Making the web", font=font(17, True), fill=(53, 34, 29, 255))
    draw.text((81, 65), "feel like yours.", font=font(17, True), fill=(53, 34, 29, 255))

    draw.rounded_rectangle((22, 105, 181, 130), 8, fill=(255, 232, 222, 255))
    draw.ellipse((33, 115, 39, 121), fill=(43, 139, 103, 255))
    draw.text((46, 110), "INSTALLING CHROMECRAFT", font=font(8, True), fill=(112, 71, 58, 255))
    draw_progress(draw, progress)

    # A soft travelling highlight gives the card depth without a flashing effect.
    glint_x = int(-70 + progress * (WIDTH + 140))
    glint = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glint_draw = ImageDraw.Draw(glint)
    glint_draw.polygon(
        ((glint_x, 10), (glint_x + 19, 10), (glint_x - 32, 152), (glint_x - 51, 152)),
        fill=(255, 255, 255, 30),
    )
    glint.putalpha(glint.getchannel("A").filter(ImageFilter.GaussianBlur(7)))
    card_mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(card_mask).rounded_rectangle((9, 9, 258, 152), 17, fill=255)
    glint.putalpha(Image.composite(glint.getchannel("A"), Image.new("L", canvas.size, 0), card_mask))
    canvas.alpha_composite(glint)

    return canvas.convert("RGB")


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    logo = Image.open(LOGO_PATH).convert("RGBA")
    frames = [render_frame(logo, index) for index in range(FRAME_COUNT)]
    frames[16].save(PREVIEW, optimize=True)
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")
    print(f"Wrote {PREVIEW.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
