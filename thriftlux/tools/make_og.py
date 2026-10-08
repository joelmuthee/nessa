"""ThriftLux WhatsApp/OG share card, 1200x630.
Logo left on its own dark ground, three real in-stock bags right.
Bag photos are cropped and resized only, never retouched.

Usage (from a scratch folder):
  1. Download the site fonts next to this script's working dir as corm.ttf
     (Cormorant Garamond variable) and inter.ttf (Inter variable), from
     github.com/google/fonts ofl/cormorantgaramond and ofl/inter.
  2. Download three bag photos from <worker>/img/... (pick ones whose bag is
     centred with room at the sides, or the tile crop clips them).
  3. python make_og.py a.jpg b.jpg c.jpg  -> og-image.jpg (keep under ~300KB)
  4. Copy to images/og-image.jpg, deploy, re-scrape in the FB Sharing Debugger.
2026-10-08 card: hot-pink quilted chain bag, tan C&K top handle, black bucket."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import sys

LOGO = r"C:\Users\Joel\Website Designs\nessa-essenceautomations\thriftlux\images\logo.jpg"
BAGS = sys.argv[1:4] if len(sys.argv) > 3 else ["c2.jpg", "c14.jpg", "c10.jpg"]
OUT = "og-image.jpg"
W, H = 1200, 630
GOLD = (201, 169, 97)
GOLD_LIGHT = (234, 215, 168)

def font(path, size, var):
    f = ImageFont.truetype(path, size)
    f.set_variation_by_name(var)
    return f

logo = Image.open(LOGO).convert("RGB")
# Ground colour = the logo's own corner tone, so its edge disappears.
px = [logo.getpixel(p) for p in [(4, 4), (logo.width - 5, 4), (4, logo.height - 5), (logo.width - 5, logo.height - 5)]]
bg = tuple(sum(c[i] for c in px) // 4 for i in range(3))
card = Image.new("RGB", (W, H), bg)

# Logo, scaled to the left column, edges feathered into the ground.
lw = 520
lh = round(logo.height * lw / logo.width)
lg = logo.resize((lw, lh), Image.LANCZOS)
mask = Image.new("L", (lw, lh), 0)
ImageDraw.Draw(mask).rounded_rectangle([18, 18, lw - 18, lh - 18], radius=60, fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(16))
lx, ly = 30, 48
card.paste(lg, (lx, ly), mask)

d = ImageDraw.Draw(card)
cx = lx + lw // 2
f1 = font("corm.ttf", 40, "SemiBold")
f2 = font("inter.ttf", 21, "Medium")
t1 = "Pre-loved designer-style handbags"
t2 = "NAIROBI  ·  ORDER ON WHATSAPP"
y1 = ly + lh + 18
d.text((cx, y1), t1, font=f1, fill=GOLD_LIGHT, anchor="mt")
d.text((cx, y1 + 62), t2, font=f2, fill=GOLD, anchor="mt")

# Three bag tiles.
tw, th, gap = 188, 420, 12
x0 = W - 40 - (3 * tw + 2 * gap)
ty = (H - th) // 2
for i, f in enumerate(BAGS):
    im = Image.open(f).convert("RGB")
    ch = round(im.height * 0.96)
    cw = round(ch * tw / th)
    left = (im.width - cw) // 2
    top = round(im.height * 0.03)
    im = im.crop((left, top, left + cw, top + ch)).resize((tw, th), Image.LANCZOS)
    m = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, tw - 1, th - 1], radius=16, fill=255)
    x = x0 + i * (tw + gap)
    card.paste(im, (x, ty), m)
    d.rounded_rectangle([x, ty, x + tw - 1, ty + th - 1], radius=16, outline=GOLD, width=2)

card.save(OUT, "JPEG", quality=86, optimize=True, progressive=True)
import os
print(OUT, card.size, os.path.getsize(OUT) // 1024, "KB", "bg", bg)
