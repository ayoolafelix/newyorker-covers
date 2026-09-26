#!/usr/bin/env python3
"""Scrape cover artist credits where New Yorker publishes them.

Coverage is genuinely limited: /culture/cover-story/<date> pages exist only for
2017-2026 (some issues in 2017 and 2023 lack them). Issue pages carry no cover
credit at all -- the alt text is the generic string "The New Yorker". So this
fills ~9% of the archive and the rest stays unknown. That is the ceiling of
what the publisher exposes, not a scraping shortfall.
"""
import html, json, os, re, requests, time
from concurrent.futures import ThreadPoolExecutor

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BASE = "https://www.newyorker.com/culture/cover-story/cover-story-{}"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
OUT = os.path.join(SITE, "public", "artists.json")

TITLE_RE = re.compile(r"<title>([^<]+?)\s*\|\s*The New Yorker</title>")
DESC_RE = re.compile(r'<meta name="description" content="([^"]*)"')
# "R. Kikuo Johnson's "Perennial"" -> artist, title
CREDIT_RE = re.compile(r"^(?P<artist>.+?)[’\u2019]s\s*[“\"](?P<title>.+?)[”\"]")

# courtesy pacing; only ~460 pages are ever requested
_last = [0.0]


def throttle():
    while True:
        dt = time.time() - _last[0]
        if dt >= 0.34:
            _last[0] = time.time()
            return
        time.sleep(0.34 - dt)


def fetch(date):
    throttle()
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    try:
        r = s.get(BASE.format(date), timeout=45)
    except Exception:
        return date, None
    if r.status_code != 200:
        return date, None
    h = html.unescape(r.text)
    m = TITLE_RE.search(h)
    if not m:
        return date, None
    artist, title = None, None
    c = CREDIT_RE.match(m.group(1).strip())
    if c:
        artist = c.group("artist").strip()
        title = c.group("title").strip()
    d = DESC_RE.search(h)
    if artist and d:
        # the description names the artist in prose; prefer it when it agrees
        pm = re.search(r"interviews?\s+([A-Z][^.]+?)\s+about", d.group(1))
        if pm and pm.group(1).strip() != artist:
            artist = pm.group(1).strip()
    if not artist:
        return date, None
    return date, {"artist": artist, "title": title or ""}


def main():
    covers = json.load(open(os.path.join(SITE, "public", "covers.json")))
    dates = [c["d"] for c in covers if c["d"] >= "2017-01-01"]
    print(f"checking {len(dates)} issues from 2017 onward")

    out = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, (d, rec) in enumerate(ex.map(fetch, dates), 1):
            if rec:
                out[d] = rec
            if i % 60 == 0:
                print(f"  {i}/{len(dates)}  credited={len(out)}", flush=True)

    json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} credits -> {OUT}")


if __name__ == "__main__":
    main()
