"""Build data.json from captions.json + classification logic + ordered shortcode list.

For each post:
  {
    "id":            "<IG shortcode>",
    "category":      "makeup" | "styling" | "both" | "unclear",
    "title":         "<short headline derived from first caption line>",
    "description":   "<cleaned caption, hashtags stripped, no em-dashes>",
    "image":         "images/posts/nessa_<sc>.jpg",
    "instagramUrl":  "https://www.instagram.com/p/<sc>/",
    "createdAt":     null  # we don't know the exact post date; leave null for now
  }

The output preserves the order of the original __nessaList scrape (newest first).
"""
import json, re, html, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from classify import classify, decode  # reuse heuristic

CAPTIONS_PATH = os.path.join(HERE, 'captions.json')
IMG_DIR       = os.path.join(HERE, 'images', 'posts')
OUT_PATH      = os.path.join(HERE, 'data.json')

HASHTAG_RE = re.compile(r'#[\wÀ-￿]+', re.UNICODE)
MENTION_RE = re.compile(r'@[A-Za-z0-9_.]+')
DASH_RE    = re.compile(r'[–—]')  # en-dash, em-dash → strip

def clean(text, drop_mentions=False):
    s = decode(text or '').strip()
    s = HASHTAG_RE.sub('', s)
    if drop_mentions:
        s = MENTION_RE.sub('', s)
    s = DASH_RE.sub(',', s)
    s = re.sub(r'\s+\n', '\n', s)
    s = re.sub(r'\n{2,}', '\n', s)
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()

def derive_title(caption, category):
    body = clean(caption, drop_mentions=True)
    if not body:
        return {'makeup': 'Makeup', 'styling': 'Styling', 'both': 'Makeup + Styling', 'unclear': 'Untitled'}[category]
    # First sentence or line, up to ~70 chars
    first = re.split(r'[\n.!?]', body, 1)[0].strip()
    if len(first) > 70:
        first = first[:67].rsplit(' ', 1)[0] + '...'
    return first or category.title()

def main():
    caps = json.load(open(CAPTIONS_PATH, encoding='utf-8'))
    caps.pop('undefined', None)
    posts = []
    missing_images = []
    for sc, raw_cap in caps.items():
        cat = classify(raw_cap)
        img_rel = f'images/posts/nessa_{sc}.jpg'
        img_abs = os.path.join(IMG_DIR, f'nessa_{sc}.jpg')
        if not os.path.exists(img_abs):
            missing_images.append(sc)
            continue
        title = derive_title(raw_cap, cat)
        desc  = clean(raw_cap)
        posts.append({
            'id': sc,
            'category': cat,
            'title': title,
            'description': desc[:500],  # cap to keep data.json reasonable
            'image': img_rel,
            'instagramUrl': f'https://www.instagram.com/p/{sc}/',
            'createdAt': None,
        })
    settings = {
        'businessName': 'Nessa',
        'tagline': 'Makeup. Styling. ThriftLux bags.',
        'subtitle': "Vanessa's portfolio. Three lines of work, one phone.",
        'whatsappNumber': '254705044940',
        'ownerName': 'Vanessa',
        'instagram': 'https://www.instagram.com/nessamakeupart/',
        'thriftluxUrl': 'https://nessa.co.ke/thriftlux',
        'kalashaNomination': 'Kalasha Nominee 2022 - Best Costume Designer',
    }
    out = {'posts': posts, 'settings': settings}
    json.dump(out, open(OUT_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    # Report
    from collections import Counter
    cats = Counter(p['category'] for p in posts)
    print(f'Wrote {OUT_PATH}')
    print(f'Posts:    {len(posts)}')
    for k in ('makeup','styling','both','unclear'):
        print(f'  {k:8s} {cats.get(k,0):3d}')
    if missing_images:
        print(f'WARNING: {len(missing_images)} posts had no image file, skipped:')
        for sc in missing_images: print(f'  {sc}')

if __name__ == '__main__':
    main()
