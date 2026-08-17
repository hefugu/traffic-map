from __future__ import annotations

import re
import time

import audit_signal_blog as audit


def fetch_all_feed_entries():
    entries = []
    start = 1
    page_size = 150
    total = None
    while total is None or start <= total:
        data = audit.get_json(
            audit.FEED,
            {"alt": "json", "max-results": page_size, "start-index": start},
        )
        feed = data.get("feed", {})
        if total is None:
            raw_total = feed.get("openSearch$totalResults", {}).get("$t")
            total = int(raw_total) if raw_total else 10_000
            print(f"feed total reported: {total}")
        page = feed.get("entry", []) or []
        if not page:
            break
        entries.extend(page)
        print(f"feed: {len(entries)}/{total} entries")
        start += len(page)
        time.sleep(0.25)
    return entries


def is_data_row(row):
    if len(row) < 2:
        return False
    first = audit.clean(row[0])
    second = audit.clean(row[1])
    if audit.parse_seconds(second) is None:
        return False
    return bool(
        re.fullmatch(r"\d+", first)
        or re.fullmatch(r"(?:(?:\d+)分)?\s*\d+(?:\.\d+)?秒", first)
        or re.fullmatch(r"\d+(?:\.\d+)?", first)
    )


def pedestrian_profiles(soup):
    profiles = []
    for ti, table in enumerate(soup.find_all("table")):
        grid = audit.table_grid(table)
        if not grid:
            continue

        first_data = next((i for i, row in enumerate(grid) if is_data_row(row)), None)
        if first_data is None or first_data == 0:
            continue

        headers = []
        width = len(grid[0])
        for c in range(width):
            parts = []
            for r in range(first_data):
                value = audit.clean(grid[r][c]) if c < len(grid[r]) else ""
                if value and value not in parts:
                    parts.append(value)
            headers.append(" / ".join(parts))

        ped_cols = [
            i for i, h in enumerate(headers)
            if "歩行者用" in h or "横断歩道" in h or "横断" in h
        ]
        if not ped_cols:
            continue

        accum = {c: {"green": 0.0, "blink": 0.0, "observed": False} for c in ped_cols}
        cycle = 0.0
        row_count = 0
        for row in grid[first_data:]:
            if not is_data_row(row):
                continue
            dur = audit.parse_seconds(row[1])
            if dur is None:
                continue
            cycle += dur
            row_count += 1
            for c in ped_cols:
                if c >= len(row):
                    continue
                state = audit.clean(row[c])
                if state.startswith("青点滅"):
                    accum[c]["blink"] += dur
                    accum[c]["observed"] = True
                elif state.startswith("青"):
                    accum[c]["green"] += dur
                    accum[c]["observed"] = True

        crossings = []
        for c in ped_cols:
            if not accum[c]["observed"]:
                continue
            crossings.append({
                "header": headers[c],
                "greenSeconds": round(accum[c]["green"], 2),
                "blinkSeconds": round(accum[c]["blink"], 2),
            })

        if crossings:
            profiles.append({
                "tableIndex": ti,
                "cycleSecondsFromRows": round(cycle, 2),
                "rowCount": row_count,
                "crossings": crossings,
            })
    return profiles


audit.fetch_all_feed_entries = fetch_all_feed_entries
audit.pedestrian_profiles = pedestrian_profiles

audit.main()
