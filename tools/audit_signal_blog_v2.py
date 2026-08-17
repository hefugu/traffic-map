from __future__ import annotations

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


audit.fetch_all_feed_entries = fetch_all_feed_entries

audit.main()
