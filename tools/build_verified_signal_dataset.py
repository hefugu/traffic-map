from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from pathlib import Path

SOURCE = Path('signal-blog-audit/all-posts.json')
OUT_TS = Path('frontend/src/measuredSignalTimings.generated.ts')
OUT_SUMMARY = Path('signal-blog-audit/verified-summary.json')

MANUAL_SOURCE_URLS = {
    'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight-e.html',
    'https://www.shingou-saikuru.com/2018/08/kameido-sta.html',
    'https://www.shingou-saikuru.com/2020/10/toyosu-sta.html',
    'https://www.shingou-saikuru.com/2018/08/kiba-5.html',
    'https://www.shingou-saikuru.com/2020/10/edagawa-1.html',
    'https://www.shingou-saikuru.com/2020/10/tokyo-wangan-police.html',
    'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight.html',
    'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight-seimon.html',
    'https://www.shingou-saikuru.com/2018/08/morishita-sta.html',
    'https://www.shingou-saikuru.com/2018/08/fukagawa-771-202.html',
    'https://www.shingou-saikuru.com/2018/08/expwy-kiba-ent.html',
    'https://www.shingou-saikuru.com/2018/08/sengoku-brdg-n.html',
    'https://www.shingou-saikuru.com/2020/10/fukagawa-akatsukibashi-s.html',
}

WARD_ORDER = [
    '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
    '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
    '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区',
]


def cycle_text_values(value: str | None) -> list[float]:
    if not value:
        return []
    values: list[float] = []
    for match in re.finditer(r'(?:(\d+(?:\.\d+)?)分)?\s*(\d+(?:\.\d+)?)秒', value):
        values.append(float(match.group(1) or 0) * 60 + float(match.group(2)))
    return values


def validate(row: dict) -> tuple[bool, str]:
    if row.get('status') != 'parsed' or not row.get('pedestrianProfiles'):
        return False, 'not-machine-readable'

    for profile in row['pedestrianProfiles']:
        cycle = float(profile['cycleSecondsFromRows'])
        if not 30 <= cycle <= 240:
            return False, 'cycle-out-of-range'
        crossings = profile.get('crossings') or []
        if not crossings:
            return False, 'no-pedestrian-crossing-values'
        for crossing in crossings:
            green = float(crossing['greenSeconds'])
            blink = float(crossing['blinkSeconds'])
            if green < 0 or blink < 0 or green + blink > cycle:
                return False, 'crossing-duration-invalid'

    stated_cycles = cycle_text_values(row.get('cycleText'))
    if stated_cycles:
        for profile in row['pedestrianProfiles']:
            cycle = float(profile['cycleSecondsFromRows'])
            closest = min(stated_cycles, key=lambda value: abs(value - cycle))
            tolerance = max(5.0, closest * 0.08)
            if abs(closest - cycle) > tolerance:
                return False, 'table-cycle-mismatch'

    if row.get('url') in MANUAL_SOURCE_URLS:
        return False, 'already-manually-curated'
    return True, 'verified'


def clean_name(title: str, ward: str) -> str:
    name = re.sub(r'[【〖][^】〗]*[】〗]', '', title).strip(' 。')
    for suffix in ('の信号サイクル', '信号サイクル'):
        index = name.find(suffix)
        if index > 0:
            name = name[:index]
            break
    chunks = re.split(r'[！!？?。]', name)
    if len(chunks) > 1 and chunks[-1].strip():
        candidate = chunks[-1].strip(' 、。')
        if any(token in candidate for token in ('交差点', '横断路', '駅前', '入口', '出口', '橋', '門', '信号')):
            name = candidate
    return name.strip(' 、。') or title


def average(values: list[float]) -> float:
    return sum(values) / len(values)


def rounded(value: float) -> float | int:
    value = round(value, 2)
    return int(value) if math.isclose(value, round(value), abs_tol=1e-9) else value


def aggregate(row: dict) -> dict:
    profiles = row['pedestrianProfiles']
    cycle = rounded(average([float(profile['cycleSecondsFromRows']) for profile in profiles]))
    grouped: dict[str, list[dict]] = defaultdict(list)
    order: list[str] = []
    for profile in profiles:
        for crossing in profile['crossings']:
            header = crossing.get('header') or f'crossing-{len(order) + 1}'
            if header not in grouped:
                order.append(header)
            grouped[header].append(crossing)

    crossings = []
    for header in order:
        observations = grouped[header]
        crossings.append({
            'greenSeconds': rounded(average([float(item['greenSeconds']) for item in observations])),
            'blinkSeconds': rounded(average([float(item['blinkSeconds']) for item in observations])),
        })

    note_parts = []
    if row.get('survey'):
        note_parts.append(f"調査: {row['survey']}")
    if len(profiles) > 1:
        note_parts.append(f'複数表{len(profiles)}件を平均')

    return {
        'name': clean_name(row['title'], row['ward']),
        'lat': row.get('lat'),
        'lng': row.get('lng'),
        'ward': row['ward'],
        'cycleSeconds': cycle,
        'crossings': crossings,
        'sourceUrl': row['url'],
        'note': ' / '.join(note_parts) if note_parts else None,
    }


def ts_string(value: str) -> str:
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


def ts_number(value: float | int) -> str:
    if isinstance(value, int):
        return str(value)
    return f'{value:.7f}'.rstrip('0').rstrip('.')


def render(profiles: list[dict]) -> str:
    lines = [
        "import type { MeasuredSignalProfile } from './measuredSignalTimings'",
        '',
        '// AUTO-GENERATED from 都内信号サイクルブログ audit.',
        '// Only rows passing conservative cycle/crossing consistency checks are included.',
        '// Do not edit by hand; sourceUrl remains attached to every profile.',
        'export const GENERATED_MEASURED_SIGNAL_PROFILES: MeasuredSignalProfile[] = [',
    ]
    for profile in profiles:
        lines.append('  {')
        lines.append(f"    name: {ts_string(profile['name'])},")
        if profile.get('lat') is not None and profile.get('lng') is not None:
            lines.append(f"    lat: {ts_number(float(profile['lat']))},")
            lines.append(f"    lng: {ts_number(float(profile['lng']))},")
        lines.append(f"    ward: {ts_string(profile['ward'])},")
        lines.append(f"    cycleSeconds: {ts_number(profile['cycleSeconds'])},")
        lines.append('    crossings: [')
        for crossing in profile['crossings']:
            lines.append(
                '      { greenSeconds: '
                f"{ts_number(crossing['greenSeconds'])}, blinkSeconds: {ts_number(crossing['blinkSeconds'])} }},"
            )
        lines.append('    ],')
        lines.append(f"    sourceUrl: {ts_string(profile['sourceUrl'])},")
        if profile.get('note'):
            lines.append(f"    note: {ts_string(profile['note'])},")
        lines.append('  },')
    lines.append(']')
    lines.append('')
    return '\n'.join(lines)


def main() -> None:
    rows = json.loads(SOURCE.read_text(encoding='utf-8'))
    profiles: list[dict] = []
    excluded: dict[str, int] = defaultdict(int)
    excluded_rows: list[dict] = []

    for row in rows:
        ok, reason = validate(row)
        if ok:
            profiles.append(aggregate(row))
        else:
            excluded[reason] += 1
            excluded_rows.append({'ward': row.get('ward'), 'title': row.get('title'), 'url': row.get('url'), 'reason': reason})

    profiles.sort(key=lambda item: (WARD_ORDER.index(item['ward']), item['name'], item['sourceUrl']))
    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text(render(profiles), encoding='utf-8')

    by_ward = {ward: sum(item['ward'] == ward for item in profiles) for ward in WARD_ORDER}
    summary = {
        'sourceArticleCount': len(rows),
        'generatedProfileCount': len(profiles),
        'manualCuratedProfileCount': len(MANUAL_SOURCE_URLS),
        'combinedProfileCount': len(profiles) + len(MANUAL_SOURCE_URLS),
        'byWardGenerated': by_ward,
        'excludedByReason': dict(sorted(excluded.items())),
        'excludedRows': excluded_rows,
    }
    OUT_SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in summary.items() if key != 'excludedRows'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
