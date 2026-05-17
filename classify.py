"""Classify Nessa's IG posts into makeup / styling / both / unclear from the captions
we pulled via og:title.

Approach: Nessa's captions usually credit each role on a shoot to a specific artist
(e.g. "Styling by @nessamakeupart, Makeup by @makeupby_bilha"). For the website we
want to bucket each post by **what Nessa herself did**, not what someone else did.
So we parse role-credit phrases ("<role list> by <person>") and only count roles
where the person is her.

Fallback: when no credit phrase is found, role-specific hashtags
(#nessastyling, #nessawardrobe, #wardrobestylist, ...) are a reliable signal.
The blanket signature hashtag #nessamakeupart sits on almost every post and is
NOT used as a signal.
"""
import json, re, sys, html, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

def decode(s):
    if not s: return ''
    return html.unescape(s)

# A credit-phrase looks like "<role-list> by <person>" or "<role-list>: <person>"
# Roles can chain with "and" / "&" / "," — examples seen:
#   "Makeup by @nessamakeupart"
#   "Wardrobe styling by @nessamakeupart"
#   "Wardrobe styling and Makeup by @nessamakeupart"
#   "Makeup, beard and wardrobe by yours truly"
#   "Hair and makeup by @her"
#   "Styling by yours truly"
ROLE_WORD = r'(?:makeup|mua|wardrobe(?:\s+styling)?|styling|stylist|costume|costuming|beard|hair)'
ROLE_LIST = rf'(?:{ROLE_WORD}(?:\s*(?:,|and|&)\s*{ROLE_WORD})*)'
PERSON    = r'(?:yours\s+truly|myself|by\s+me\b|@nessamakeupart|@\w+|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)'

# Allow optional intro "by" or ":" or bare-space (e.g. "Makeup @bilha")
CREDIT_RE = re.compile(
    rf'({ROLE_LIST})\s*(?:by|:|\s)\s*(@nessamakeupart|yours\s+truly|myself|@\w+|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)',
    re.I)

# Also catch first-person role declarations: "I'm the wardrobe stylist", "working as the makeup artist"
SELF_ROLE_RE = re.compile(
    rf'(?:as\s+(?:the\s+|a\s+)?|i\s*(?:am|\'m)\s+(?:the\s+|a\s+)?|i\s+did\s+(?:the\s+)?)(?:{ROLE_WORD})',
    re.I)
SELF_ROLE_EXTRACT = re.compile(rf'({ROLE_WORD})', re.I)

# Role-specific hashtags Nessa actually uses on posts where she did styling
STYLING_TAGS = re.compile(r'#nessastyling|#nessawardrobe|#nessawadrobe|#wardrobestyl(?:ist|ing)|#fashionstylist|#fashionstyling', re.I)
# Standalone #nessamakeup (without -art) sometimes denotes makeup role specifically
MAKEUP_TAGS  = re.compile(r'#nessamakeup\b(?!art)|#mua\b', re.I)

def is_her(person):
    p = person.lower().strip()
    if p.startswith('@'):
        return p == '@nessamakeupart'
    if 'yours truly' in p or 'myself' in p or p == 'by me' or p == 'me':
        return True
    return False

def split_roles(role_list):
    """Return set of canonical roles: 'makeup' and/or 'styling'."""
    out = set()
    s = role_list.lower()
    if re.search(r'\b(makeup|mua|beard|hair)\b', s):
        out.add('makeup')
    if re.search(r'\b(wardrobe|styling|stylist|costum)\w*', s):
        out.add('styling')
    return out

def classify(caption):
    cap = decode(caption)
    if not cap.strip():
        return 'unclear'
    her_roles = set()
    for m in CREDIT_RE.finditer(cap):
        roles, person = m.group(1), m.group(2)
        if is_her(person):
            her_roles |= split_roles(roles)
    # First-person role declarations ("as the wardrobe stylist", "I'm the MUA")
    for m in SELF_ROLE_RE.finditer(cap):
        role_word = SELF_ROLE_EXTRACT.search(m.group(0)).group(1)
        her_roles |= split_roles(role_word)
    # Hashtag fallback (additive — works alongside credit-phrase signals)
    if STYLING_TAGS.search(cap):
        her_roles.add('styling')
    if MAKEUP_TAGS.search(cap):
        her_roles.add('makeup')
    if her_roles == {'makeup', 'styling'}: return 'both'
    if her_roles == {'makeup'}: return 'makeup'
    if her_roles == {'styling'}: return 'styling'
    return 'unclear'

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    data = json.load(open(path, encoding='utf-8') if path else sys.stdin)
    data.pop('undefined', None)
    buckets = {'makeup': [], 'styling': [], 'both': [], 'unclear': []}
    for sc, cap in data.items():
        buckets[classify(cap)].append((sc, decode(cap or '')[:220].replace('\n', ' | ')))
    total = sum(len(v) for v in buckets.values())
    print(f'Total captioned: {total}')
    for b in ('makeup', 'styling', 'both', 'unclear'):
        pct = 100 * len(buckets[b]) / total if total else 0
        print(f'  {b:8s} {len(buckets[b]):3d}  ({pct:4.1f}%)')
    print()
    for bucket in ('makeup', 'styling', 'both', 'unclear'):
        print(f'=== {bucket.upper()} ({len(buckets[bucket])}) — sample up to 10 ===')
        for sc, snippet in buckets[bucket][:10]:
            print(f'  {sc}: {snippet}')
        print()

def write_csv(data, out_path):
    """Write shortcode,category,caption_snippet CSV for manual review."""
    import csv
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['shortcode', 'category', 'caption_snippet'])
        for sc, cap in data.items():
            cat = classify(cap)
            snippet = decode(cap or '')[:200].replace('\n', ' | ')
            w.writerow([sc, cat, snippet])

if __name__ == '__main__':
    main()
    # Also dump CSV next to the input file
    if len(sys.argv) > 1:
        import os
        in_path = sys.argv[1]
        data = json.load(open(in_path, encoding='utf-8'))
        data.pop('undefined', None)
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'classification.csv')
        write_csv(data, out)
        print(f'\nCSV written to {out}')

