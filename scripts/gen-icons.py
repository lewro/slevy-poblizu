from PIL import Image, ImageDraw, ImageFont
import math

BG = (232, 115, 44)       # amber/terracotta
FG = (250, 246, 240)      # warm white

def rounded_square(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)

    # Pin shape (circle head + triangular tail) pointing down
    cx = size * 0.5
    head_r = size * 0.20
    head_cy = size * 0.38

    # tail (triangle) drawn first so circle overlaps cleanly
    tail = [
        (cx - head_r * 0.62, head_cy + head_r * 0.55),
        (cx + head_r * 0.62, head_cy + head_r * 0.55),
        (cx, size * 0.78),
    ]
    d.polygon(tail, fill=FG)
    d.ellipse(
        [cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
        fill=FG,
    )

    # punch a hole + percent-style dot/slash inside the pin head to read as "deal"
    hole_r = head_r * 0.42
    d.ellipse(
        [cx - hole_r, head_cy - hole_r, cx + hole_r, head_cy + hole_r],
        fill=BG,
    )
    dot_r = hole_r * 0.30
    d.ellipse(
        [cx - hole_r * 0.55 - dot_r, head_cy - hole_r * 0.55 - dot_r,
         cx - hole_r * 0.55 + dot_r, head_cy - hole_r * 0.55 + dot_r],
        fill=FG,
    )
    d.ellipse(
        [cx + hole_r * 0.55 - dot_r, head_cy + hole_r * 0.55 - dot_r,
         cx + hole_r * 0.55 + dot_r, head_cy + hole_r * 0.55 + dot_r],
        fill=FG,
    )
    d.line(
        [cx - hole_r * 0.7, head_cy + hole_r * 0.7,
         cx + hole_r * 0.7, head_cy - hole_r * 0.7],
        fill=BG, width=max(1, int(size * 0.012))
    )
    return img

for size in [192, 512]:
    img = rounded_square(size)
    img.save(f"/home/claude/slevy-pwa/public/icons/icon-{size}.png")

# maskable version (same art, square fill, no transparency, safe-zone padding already baked in)
for size in [192, 512]:
    img = rounded_square(size, radius_ratio=0.0)
    img.save(f"/home/claude/slevy-pwa/public/icons/icon-{size}-maskable.png")

# favicon
fav = rounded_square(64)
fav.save("/home/claude/slevy-pwa/public/favicon.png")

print("icons generated")
