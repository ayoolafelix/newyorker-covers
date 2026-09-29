#!/usr/bin/env python3
"""Pin New Yorker covers to a Pinterest board, oldest first.

Run daily by .github/workflows/pinterest.yml. Reads the archive that is
already committed to this repository, so it needs no scraping and no network
access to newyorker.com: covers.json lists every cover, artists.json carries
the credit, and the JPEGs are served from the public site. Pinterest fetches
the image from that public URL itself, which is why the covers have to be
reachable without auth (they are) and why they carry a long max-age.

State lives in data/pinterest.json: a set of issue dates already pinned. The
job picks the oldest unpinned covers, up to a cap, and records what succeeded.
Recording per-pin rather than a single cursor means a run that dies halfway
resumes without re-pinning, and a cover that permanently fails does not block
the ones behind it.

Usage:
    python3 pin_pinterest.py --limit 20         # pin the next 20
    python3 pin_pinterest.py --limit 20 --dry-run
    python3 pin_pinterest.py --status

Environment:
    PINTEREST_TOKEN   access token with boards:read and pins:create
    PINTEREST_BOARD   board id, or a board URL from which the id is taken
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
STATE = os.path.join(DATA, "pinterest.json")
COVERS = os.path.join(ROOT, "public", "covers.json")
ARTISTS = os.path.join(ROOT, "public", "artists.json")
SITE = "https://newyorker-covers.vercel.app"
API = "https://api.pinterest.com/v5"

# Pinterest rejects titles over 100 characters and descriptions over 800.
TITLE_MAX = 100
DESC_MAX = 800
# A failed pin is retried this many times, then recorded as permanently
# failed so it does not block the queue forever.
MAX_ATTEMPTS = 3


def log(msg):
    print(msg, flush=True)


def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    return {"pinned": [], "failed": {}}


def save_state(state):
    os.makedirs(DATA, exist_ok=True)
    state["pinned"] = sorted(set(state["pinned"]))
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)
        f.write("\n")


def api(method, path, token, body=None, timeout=60):
    """One Pinterest API call. Returns (status, parsed_body)."""
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "newyorker-archive-pin/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"message": raw[:400].decode("utf-8", "replace")}
        return e.code, parsed
    except urllib.error.URLError as e:
        return 0, {"message": str(e.reason)}


def resolve_board_id(board):
    """Accept a bare id, or a board URL, and return the id.

    A board URL looks like https://www.pinterest.com/<user>/<board>/<slug>/,
    so the numeric id can be pulled from the trailing path segment. Accepting
    the URL means the value can be pasted straight from a browser.
    """
    board = (board or "").strip()
    if not board:
        return ""
    if re.fullmatch(r"\d+", board):
        return board
    m = re.search(r"/(\d{6,})/?", board)
    if m:
        return m.group(1)
    return board


def verify_access(token, board_id):
    """Fail loudly and early if the token cannot write.

    Trial access is read-mostly: POST /pins can be refused outright, and that
    is worth discovering on the first run rather than after a backfill has
    half-finished.
    """
    status, body = api("GET", f"/boards/{board_id}", token)
    if status != 200:
        log(f"  board check FAILED: HTTP {status} {body.get('message', body)}")
        log("  Is PINTEREST_BOARD correct, and does the token have boards:read?")
        return None
    name = body.get("name", "?")
    log(f"  board ok: {name!r} ({board_id})")
    return name


def build_pin(cover, credit):
    """Title, description and link for one cover.

    The title carries the artist when the archive has one and the date
    otherwise, so every pin has something meaningful in the field Pinterest
    indexes. Nothing is invented: no credit means no credit.
    """
    date = cover["d"]
    when = cover.get("t") or date
    who = ""
    if isinstance(credit, dict):
        who = (credit.get("artist") or "").strip()

    if who:
        title = f"{who}, {when}"
    else:
        title = f"The New Yorker, {when}"
    if len(title) > TITLE_MAX:
        title = title[:TITLE_MAX - 1].rstrip() + "\u2026"

    what = ""
    if isinstance(credit, dict) and (credit.get("title") or "").strip():
        what = f"\u201c{credit['title'].strip()}\u201d"

    desc = "\n\n".join(p for p in [
        f"The New Yorker cover for {when}." if not who
        else f"{who}\u2019s cover for The New Yorker, {when}.",
        what,
        f"From the archive at {SITE}",
    ] if p)
    if len(desc) > DESC_MAX:
        desc = desc[:DESC_MAX - 1].rstrip() + "\u2026"

    link = cover.get("src") or f"{SITE}"
    return title, desc, link


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20,
                    help="max covers to pin this run (default 20)")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be pinned, call no API")
    ap.add_argument("--status", action="store_true",
                    help="print counts and exit")
    args = ap.parse_args()

    with open(COVERS, encoding="utf-8") as f:
        covers = json.load(f)
    try:
        with open(ARTISTS, encoding="utf-8") as f:
            artists = json.load(f)
    except FileNotFoundError:
        artists = {}

    state = load_state()
    pinned = set(state.get("pinned", []))
    failed = state.get("failed", {})

    if args.status:
        todo = [c for c in covers if c["d"] not in pinned]
        log(f"  covers in archive : {len(covers)}")
        log(f"  already pinned    : {len(pinned)}")
        log(f"  permanently failed: {len(failed)}")
        log(f"  remaining         : {len(todo)}")
        if todo:
            log(f"  next up           : {todo[0]['d']} .. {todo[min(len(todo),5)-1]['d']}")
        return 0

    # covers.json is chronological, so this walks oldest first
    todo = [c for c in covers if c["d"] not in pinned]
    batch = todo[:args.limit]

    log(f"  archive={len(covers)} pinned={len(pinned)} failed={len(failed)} "
        f"todo={len(todo)} batch={len(batch)}")

    if not batch:
        log("  nothing new; backfill complete")
        return 0

    if args.dry_run:
        for c in batch:
            t, d, l = build_pin(c, artists.get(c["d"]))
            log(f"    would pin {c['d']}  {t!r}")
            log(f"              {l}")
        log(f"  dry run: {len(batch)} covers, no API calls made")
        return 0

    token = os.environ.get("PINTEREST_TOKEN", "").strip()
    board_id = resolve_board_id(os.environ.get("PINTEREST_BOARD", ""))
    if not token or not board_id:
        log("  PINTEREST_TOKEN and PINTEREST_BOARD must both be set")
        return 2

    log(f"  verifying access to board {board_id} ...")
    if verify_access(token, board_id) is None:
        return 3

    ok = 0
    for i, c in enumerate(batch, 1):
        date = c["d"]
        title, desc, link = build_pin(c, artists.get(date))
        image = f"{SITE}/{c['full']}"
        body = {
            "board_id": board_id,
            "media_source": {
                "source_type": "image_url",
                "url": image,
                "content_type": "image/jpeg",
            },
            "title": title,
            "description": desc,
            "link": link,
        }
        attempts, status, resp = 0, 0, {}
        while attempts < MAX_ATTEMPTS:
            attempts += 1
            status, resp = api("POST", "/pins", token, body)
            if status in (200, 201):
                break
            # 429 is a rate limit and 5xx is transient: both are worth a wait.
            # A 4xx is the request itself, so retrying it just wastes quota.
            if status == 429 or status >= 500:
                wait = 2 ** attempts * 5
                log(f"    {date}: HTTP {status}, retrying in {wait}s "
                    f"(attempt {attempts}/{MAX_ATTEMPTS})")
                time.sleep(wait)
                continue
            break

        if status in (200, 201):
            pin_id = (resp.get("id") or "")
            ok += 1
            pinned.add(date)
            failed.pop(date, None)
            log(f"  [{i}/{len(batch)}] {date}  pinned  {pin_id}")
        else:
            msg = str(resp.get("message", resp))[:160]
            failed[date] = f"HTTP {status}: {msg}"
            log(f"  [{i}/{len(batch)}] {date}  FAILED  HTTP {status} {msg}")
        # pace regardless of outcome, to stay well inside the rate limit
        time.sleep(1.2)

    state["pinned"] = sorted(pinned)
    state["failed"] = failed
    state["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_state(state)
    log(f"  done: {ok}/{len(batch)} pinned, {len(pinned)} total, "
        f"{len(failed)} failed")
    return 0 if ok or not batch else 1


if __name__ == "__main__":
    sys.exit(main())
