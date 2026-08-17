export type MeasuredCrossingTiming = {
  greenSeconds: number
  blinkSeconds: number
}

export type MeasuredSignalProfile = {
  name: string
  cycleSeconds: number
  crossings: MeasuredCrossingTiming[]
  lat?: number
  lng?: number
  ward?: string
  osmNodeIds?: readonly number[]
  noPedestrianCrossing?: boolean
  sourceUrl: string
  note?: string
}

// Measurements collected from 都内信号サイクルブログ.
// Signal timings can change by weekday, time of day and traffic control,
// so these values are treated as measured reference data rather than live phase data.
//
// osmNodeIds is intentionally optional. Only IDs that have been positively verified
// against OpenStreetMap should be added; unknown IDs must not be guessed.
export const MEASURED_SIGNAL_PROFILES: MeasuredSignalProfile[] = [
  {
    name: '東京ビッグサイト東',
    lat: 35.6343019,
    lng: 139.7987797,
    ward: '江東区',
    cycleSeconds: 150,
    crossings: [
      { greenSeconds: 31, blinkSeconds: 10 },
      { greenSeconds: 29, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight-e.html',
  },
  {
    name: '亀戸駅前',
    lat: 35.696575,
    lng: 139.825765,
    ward: '江東区',
    cycleSeconds: 157,
    crossings: [],
    noPedestrianCrossing: true,
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/kameido-sta.html',
    note: '交差点横断歩道なし。歩行者は歩道橋を利用。',
  },
  {
    name: '豊洲駅前',
    lat: 35.654525,
    lng: 139.796565,
    ward: '江東区',
    cycleSeconds: 149.5,
    crossings: [
      { greenSeconds: 33, blinkSeconds: 10 },
      { greenSeconds: 38, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2020/10/toyosu-sta.html',
    note: '実測サイクル149〜150秒の中央値。',
  },
  {
    name: '木場五丁目',
    lat: 35.6694401,
    lng: 139.8057602,
    ward: '江東区',
    cycleSeconds: 138.5,
    crossings: [
      { greenSeconds: 39.5, blinkSeconds: 10 },
      { greenSeconds: 33, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/kiba-5.html',
    note: '実測サイクル136〜141秒、青39〜40秒の中央値。',
  },
  {
    name: '枝川一丁目',
    lat: 35.658359,
    lng: 139.802222,
    ward: '江東区',
    cycleSeconds: 130,
    crossings: [
      { greenSeconds: 60, blinkSeconds: 10 },
      { greenSeconds: 59, blinkSeconds: 10 },
      { greenSeconds: 26, blinkSeconds: 10 },
      { greenSeconds: 31, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2020/10/edagawa-1.html',
  },
  {
    name: '東京湾岸警察署前',
    lat: 35.619131,
    lng: 139.774891,
    ward: '江東区',
    cycleSeconds: 110,
    crossings: [
      { greenSeconds: 52, blinkSeconds: 6 },
      { greenSeconds: 25, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2020/10/tokyo-wangan-police.html',
  },
  {
    name: '東京ビッグサイト前',
    lat: 35.632283,
    lng: 139.795195,
    ward: '江東区',
    cycleSeconds: 150,
    crossings: [
      { greenSeconds: 31, blinkSeconds: 10 },
      { greenSeconds: 30, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight.html',
  },
  {
    name: '東京ビッグサイト正門',
    lat: 35.630545,
    lng: 139.791979,
    ward: '江東区',
    cycleSeconds: 147,
    crossings: [
      { greenSeconds: 54, blinkSeconds: 7 },
      { greenSeconds: 32, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/tokyo-big-sight-seimon.html',
  },
  {
    name: '森下駅前',
    lat: 35.688022,
    lng: 139.798283,
    ward: '江東区',
    cycleSeconds: 119,
    crossings: [
      { greenSeconds: 28.5, blinkSeconds: 10 },
      { greenSeconds: 22.5, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/morishita-sta.html',
    note: '実測サイクル117〜121秒、青28〜29秒/21〜24秒の中央値。',
  },
  {
    name: '高森公園北側',
    ward: '江東区',
    cycleSeconds: 60,
    crossings: [
      { greenSeconds: 22, blinkSeconds: 4 },
      { greenSeconds: 16, blinkSeconds: 4 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/fukagawa-771-202.html',
    note: '秒数は収録済み。交差点中心座標を未確定のため自動位置マッチ対象外。',
  },
  {
    name: '首都高・木場出入口',
    ward: '江東区',
    cycleSeconds: 119.5,
    crossings: [
      { greenSeconds: 32.5, blinkSeconds: 10 },
      { greenSeconds: 20, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/expwy-kiba-ent.html',
    note: '実測サイクル119〜120秒、青32〜33秒の中央値。交差点中心座標を未確定のため自動位置マッチ対象外。',
  },
  {
    name: '千石橋北',
    lat: 35.644444,
    lng: 139.825325,
    ward: '江東区',
    cycleSeconds: 140,
    crossings: [
      { greenSeconds: 35, blinkSeconds: 10 },
      { greenSeconds: 35, blinkSeconds: 10 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2018/08/sengoku-brdg-n.html',
  },
  {
    name: '深川暁橋南',
    ward: '江東区',
    cycleSeconds: 85,
    crossings: [
      { greenSeconds: 26, blinkSeconds: 10 },
      { greenSeconds: 28, blinkSeconds: 8 },
    ],
    sourceUrl: 'https://www.shingou-saikuru.com/2020/10/fukagawa-akatsukibashi-s.html',
    note: '歩車分離式。交差点中心座標を未確定のため自動位置マッチ対象外。',
  },
]
