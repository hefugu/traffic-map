from __future__ import annotations

import csv
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

BASE = "https://www.shingou-saikuru.com"
FEED = f"{BASE}/feeds/posts/default"
OUT = Path("signal-blog-audit")
OUT.mkdir(exist_ok=True)

WARDS = [
    "千代田区", "中央区", "港区", "新宿区", "文京区", "台東区", "墨田区", "江東区",
    "品川区", "目黒区", "大田区", "世田谷区", "渋谷区", "中野区", "杉並区", "豊島区",
    "北区", "荒川区", "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区",
]

session = requests.Session()
session.headers.update({
    "User-Agent": "traffic-map research audit/1.0 (source verification; GitHub hefugu/traffic-map)"
})


def get_json(url: str, params: dict[str, str | int]) -> dict[str, Any]:
    r = session.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_all_feed_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    start = 1
    page_size = 150
    while True:
        data = get_json(FEED, {"alt": "json", "max-results": page_size, "start-index": start})
        page = data.get("feed", {}).get("entry", []) or []
        if not page:
            break
        entries.extend(page)
        print(f"feed: {len(entries)} entries")
        if len(page) < page_size:
            break
        start += len(page)
        time.sleep(0.25)
    return entries


def post_url(entry: dict[str, Any]) -> str | None:
    for link in entry.get("link", []):
        if link.get("rel") == "alternate":
            return link.get("href")
    return None


def categories(entry: dict[str, Any]) -> list[str]:
    return [c.get("term", "") for c in entry.get("category", []) if c.get("term")]


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def parse_seconds(text: str) -> float | None:
    text = clean(text).replace("約", "")
    # Ranges: use midpoint, but retain raw text elsewhere.
    m = re.search(r"(?:(\d+)分)?\s*(\d+(?:\.\d+)?)\s*秒", text)
    if m:
        return (float(m.group(1) or 0) * 60) + float(m.group(2))
    m = re.fullmatch(r"(\d+(?:\.\d+)?)", text)
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)\s*[～〜~-]\s*(\d+(?:\.\d+)?)", text)
    if m:
        return (float(m.group(1)) + float(m.group(2))) / 2
    return None


def table_grid(table) -> list[list[str]]:
    grid: list[list[str | None]] = []
    spans: dict[tuple[int, int], tuple[str, int]] = {}
    trs = table.find_all("tr")
    for r, tr in enumerate(trs):
        while len(grid) <= r:
            grid.append([])
        row = grid[r]
        c = 0
        cells = tr.find_all(["th", "td"], recursive=False)
        for cell in cells:
            while (r, c) in spans:
                text, remaining = spans[(r, c)]
                while len(row) <= c:
                    row.append(None)
                row[c] = text
                if remaining > 1:
                    spans[(r + 1, c)] = (text, remaining - 1)
                c += 1
            text = clean(cell.get_text(" ", strip=True))
            rs = int(cell.get("rowspan", 1) or 1)
            cs = int(cell.get("colspan", 1) or 1)
            for dc in range(cs):
                while len(row) <= c + dc:
                    row.append(None)
                row[c + dc] = text
                if rs > 1:
                    spans[(r + 1, c + dc)] = (text, rs - 1)
            c += cs
        # Fill span-only tail positions for this row.
        while (r, c) in spans:
            text, remaining = spans[(r, c)]
            while len(row) <= c:
                row.append(None)
            row[c] = text
            if remaining > 1:
                spans[(r + 1, c)] = (text, remaining - 1)
            c += 1
    width = max((len(r) for r in grid), default=0)
    return [[cell or "" for cell in r] + [""] * (width - len(r)) for r in grid]


def pedestrian_profiles(soup: BeautifulSoup) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for ti, table in enumerate(soup.find_all("table")):
        grid = table_grid(table)
        if not grid:
            continue
        # Find first likely data row: first cell step number + a seconds-like second cell.
        first_data = None
        for i, row in enumerate(grid):
            if len(row) >= 2 and re.fullmatch(r"\d+", clean(row[0])) and parse_seconds(row[1]) is not None:
                first_data = i
                break
        if first_data is None or first_data == 0:
            continue
        headers = []
        for c in range(len(grid[0])):
            h = " / ".join(dict.fromkeys(clean(grid[r][c]) for r in range(first_data) if clean(grid[r][c])))
            headers.append(h)
        ped_cols = [i for i, h in enumerate(headers) if "歩行者用" in h or "横断歩道" in h or "横断" in h]
        if not ped_cols:
            continue
        accum = {c: {"green": 0.0, "blink": 0.0, "observed": False} for c in ped_cols}
        cycle = 0.0
        for row in grid[first_data:]:
            if len(row) < 2 or not re.fullmatch(r"\d+", clean(row[0])):
                continue
            dur = parse_seconds(row[1])
            if dur is None:
                continue
            cycle += dur
            for c in ped_cols:
                if c >= len(row):
                    continue
                state = clean(row[c])
                if state.startswith("青点滅"):
                    accum[c]["blink"] += dur
                    accum[c]["observed"] = True
                elif state.startswith("青"):
                    accum[c]["green"] += dur
                    accum[c]["observed"] = True
        crossings = []
        for c in ped_cols:
            if accum[c]["observed"]:
                crossings.append({
                    "header": headers[c],
                    "greenSeconds": round(accum[c]["green"], 2),
                    "blinkSeconds": round(accum[c]["blink"], 2),
                })
        if crossings:
            profiles.append({"tableIndex": ti, "cycleSecondsFromRows": round(cycle, 2), "crossings": crossings})
    return profiles


def extract_coord(text: str) -> tuple[float | None, float | None]:
    candidates = re.findall(r"(35\.\d{4,})\s*[,，]\s*(139\.\d{4,})", text)
    if not candidates:
        return None, None
    lat, lng = candidates[-1]  # coordinate near the article's map text tends to be last/main location
    return float(lat), float(lng)


def extract_cycle_text(text: str) -> str | None:
    patterns = [
        r"1サイクルは([^。\n]{1,80})",
        r"1サイクル[：:]\s*([^\n]{1,50})",
    ]
    for p in patterns:
        m = re.search(p, text)
        if m:
            return clean(m.group(1))
    return None


def extract_survey(text: str) -> str | None:
    m = re.search(r"(?:最終調査|調査日時)\s*[:：]?\s*([^\n]{1,80})", text)
    return clean(m.group(1)) if m else None


def extract_signal_no(text: str) -> str | None:
    m = re.search(r"信号機番号\s*[:：]?\s*([0-9()\-、,・/ ]+)", text)
    return clean(m.group(1)) if m else None


def fetch_post(url: str) -> BeautifulSoup:
    r = session.get(url, timeout=30)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")


def main() -> None:
    entries = fetch_all_feed_entries()
    selected = []
    for entry in entries:
        cats = categories(entry)
        ward = next((w for w in WARDS if w in cats), None)
        if ward is None or "信号サイクル" not in cats:
            continue
        url = post_url(entry)
        if url:
            selected.append((ward, entry, url))
    print(f"selected Tokyo-23 signal posts: {len(selected)}")

    rows: list[dict[str, Any]] = []
    for idx, (ward, entry, url) in enumerate(selected, 1):
        title = clean(entry.get("title", {}).get("$t", ""))
        try:
            soup = fetch_post(url)
            article = soup.find("article") or soup
            text = article.get_text("\n", strip=True)
            lat, lng = extract_coord(text)
            profiles = pedestrian_profiles(article)
            row = {
                "ward": ward,
                "title": title,
                "url": url,
                "lat": lat,
                "lng": lng,
                "cycleText": extract_cycle_text(text),
                "survey": extract_survey(text),
                "signalNo": extract_signal_no(text),
                "pedestrianProfiles": profiles,
                "pedestrianProfileCount": len(profiles),
                "status": "parsed" if profiles else "needs-manual-review",
            }
        except Exception as exc:
            row = {
                "ward": ward, "title": title, "url": url, "lat": None, "lng": None,
                "cycleText": None, "survey": None, "signalNo": None,
                "pedestrianProfiles": [], "pedestrianProfileCount": 0,
                "status": f"error: {type(exc).__name__}: {exc}",
            }
        rows.append(row)
        print(f"[{idx}/{len(selected)}] {ward} {title}: {row['status']}")
        time.sleep(0.12)

    rows.sort(key=lambda r: (WARDS.index(r["ward"]), r["title"]))
    (OUT / "all-posts.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_fields = ["ward", "title", "lat", "lng", "cycleText", "survey", "signalNo", "pedestrianProfileCount", "status", "url"]
    with (OUT / "all-posts.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=csv_fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k) for k in csv_fields})

    summary = {
        "total": len(rows),
        "parsedWithPedestrianTimings": sum(r["pedestrianProfileCount"] > 0 for r in rows),
        "needsManualReview": sum(r["pedestrianProfileCount"] == 0 for r in rows),
        "withCoordinates": sum(r["lat"] is not None and r["lng"] is not None for r in rows),
        "byWard": {w: sum(r["ward"] == w for r in rows) for w in WARDS},
    }
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
