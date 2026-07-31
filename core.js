// 有休管理 — 計算ロジック（純粋関数のみ）
//
// 【最重要の規約】このファイルの中で Date を一切生成しない。
// 日付は "YYYY-MM-DD" 文字列で受け渡し、比較は辞書順で行う。
// new Date("2026-04-01") は UTC 解釈され、new Date(...).toISOString() は UTC の日付を返すため、
// JST の 0〜9時に「前日」が算出される。4月1日の朝に「まだ失効しません」と嘘をつく事故を
// 構造的に防ぐため、Date は UI 層（index.html の todayInTokyo）だけで使う。

export const VERSION = '1.2.0';
export const SCHEMA_VERSION = 1;

// ── 勤務先の就業規則に基づく定数（条項との対応は 根拠メモ.local.md。gitには含めない） ──
export const GRANT_MONTH = 4;                              // 規程 毎年4月1日に付与
export const GRANT_DAY = 1;
export const DAY_MINUTES = 480;                            // 規程 有休1日 = 8時間
export const HALF_DAY_MINUTES = DAY_MINUTES / 2;           // 規程 半日は正午基準
export const ANNUAL_GRANT_MINUTES = 20 * DAY_MINUTES;      // 規程 勤続5年超 = 20日
export const CARRYOVER_CAP_MINUTES = ANNUAL_GRANT_MINUTES; // 規程 該当年度の付与日数分のみ繰越
export const HOURLY_CAP_MINUTES = 5 * DAY_MINUTES;         // 規程 時間単位年休は年5日の範囲
export const HOURLY_UNIT_MINUTES = 60;                     // 規程 1時間単位
export const STATUTORY_REQUIRED_DAYS = 5;                  // 法定 年5日の時季指定義務

// 出勤率の要件を満たさず付与日数が変わる年の例外。例: { '2027': 0 }
export const GRANT_OVERRIDES = {};

// 法定の年5日取得義務に算入される日数。時間単位年休は算入されない。
const STATUTORY_DAY_VALUE = { full: 1, 'half-am': 0.5, 'half-pm': 0.5, hourly: 0 };

export const KIND_MINUTES = {
  full: DAY_MINUTES,
  'half-am': HALF_DAY_MINUTES,
  'half-pm': HALF_DAY_MINUTES,
};

export const KIND_LABEL = {
  full: '全日',
  'half-am': '午前半休',
  'half-pm': '午後半休',
  hourly: '時間単位',
};

// ───────────────────────── 日付ユーティリティ（文字列のみ） ─────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) throw new Error(`invalid date: ${s}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function isValidDate(s) {
  return DATE_RE.test(String(s));
}

/** 辞書順比較。ゼロ埋めISO文字列なので日付順と一致する。 */
export function compareDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function grantDateOf(year) {
  return `${year}-${pad2(GRANT_MONTH)}-${pad2(GRANT_DAY)}`;
}

/** from より「厳密に後」の最初の付与日。from が 4/1 当日なら翌年を返す。 */
export function nextGrantDate(from) {
  const { y, m, d } = parseDate(from);
  const beforeThisYear = m < GRANT_MONTH || (m === GRANT_MONTH && d < GRANT_DAY);
  return grantDateOf(beforeThisYear ? y : y + 1);
}

/** after < 付与日 <= upto を満たす付与日の一覧（昇順）。 */
export function grantDatesBetween(after, upto) {
  const out = [];
  let gd = nextGrantDate(after);
  while (compareDate(gd, upto) <= 0) {
    out.push(gd);
    gd = nextGrantDate(gd);
  }
  return out;
}

/** その日が属する年度（4/1 始まり）。 */
export function fiscalYearOf(date) {
  const { y, m } = parseDate(date);
  return m >= GRANT_MONTH ? y : y - 1;
}

export function fiscalYearRange(fy) {
  return { start: grantDateOf(fy), end: `${fy + 1}-03-31` };
}

// ───────────────────────── 表示フォーマット ─────────────────────────

/**
 * 分を「9日3時間」形式へ。負値は符号を分離してから桁分解する
 * （Math.floor(-240/480) は -1 になり「-1日4時間」と表示されてしまうため）。
 */
export function formatMinutes(m) {
  const n = Math.round(Number(m) || 0);
  const sign = n < 0 ? '-' : '';
  let rest = Math.abs(n);
  const days = Math.floor(rest / DAY_MINUTES);
  rest -= days * DAY_MINUTES;
  const hours = Math.floor(rest / 60);
  const mins = rest - hours * 60;
  const parts = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (mins) parts.push(`${mins}分`);
  if (parts.length === 0) parts.push('0時間');
  return sign + parts.join('');
}

export function formatDays(minutes) {
  const d = minutes / DAY_MINUTES;
  return Number.isInteger(d) ? `${d}日` : `${d.toFixed(1)}日`;
}

// ───────────────────────── 状態の正規化 ─────────────────────────

const toInt = (v, fallback) => {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

// 法定取得日数は半休を 0.5 日と数えるため、整数に丸めず 0.5 刻みに寄せる。
const toHalf = (v, fallback) => {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 2) / 2 : fallback;
};

export function emptyState(today) {
  return {
    schemaVersion: SCHEMA_VERSION,
    baseline: {
      date: today,
      currentMinutes: 0,
      carryoverMinutes: 0,
      hourlyUsedMinutes: 0,
      statutoryTakenDays: 0,
    },
    prevBaseline: null,
    history: [],
    lastSeenDate: today,
  };
}

/**
 * localStorage / JSON 往復で混入する文字列・空文字・null を数値へ正規化する。
 * schemaVersion が未知（未来のバージョン）なら readOnly を立てる。呼び出し側は
 * readOnly の状態を絶対に書き戻してはならない（新しい版のデータを古い版で破壊しないため）。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
  const sv = toInt(raw.schemaVersion, SCHEMA_VERSION);
  const readOnly = sv > SCHEMA_VERSION;

  const b = raw.baseline;
  if (!b || typeof b !== 'object' || !isValidDate(b.date)) {
    throw new Error('baseline is missing or has an invalid date');
  }
  const baseline = {
    date: b.date,
    currentMinutes: toInt(b.currentMinutes, 0),
    carryoverMinutes: toInt(b.carryoverMinutes, 0),
    hourlyUsedMinutes: toInt(b.hourlyUsedMinutes, 0),
    // 棚卸し時点で、その年度に既に取得済みの法定日数。履歴を持たない過去の取得分を
    // 法定5日カウントに反映するための項目（半休 0.5 日があるので整数に丸めない）。
    statutoryTakenDays: toHalf(b.statutoryTakenDays, 0),
  };

  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((e) => e && isValidDate(e.date) && KIND_LABEL[e.kind])
    .map((e, i) => ({
      id: String(e.id ?? `e${i}`),
      date: e.date,
      kind: e.kind,
      minutes: toInt(e.minutes, KIND_MINUTES[e.kind] ?? 0),
      note: typeof e.note === 'string' ? e.note : '',
    }));

  const pb = raw.prevBaseline;
  const prevBaseline =
    pb && typeof pb === 'object' && isValidDate(pb.date)
      ? {
          date: pb.date,
          currentMinutes: toInt(pb.currentMinutes, 0),
          carryoverMinutes: toInt(pb.carryoverMinutes, 0),
          hourlyUsedMinutes: toInt(pb.hourlyUsedMinutes, 0),
        }
      : null;

  return {
    schemaVersion: sv,
    readOnly,
    baseline,
    prevBaseline,
    history,
    lastSeenDate: isValidDate(raw.lastSeenDate) ? raw.lastSeenDate : baseline.date,
  };
}

// ───────────────────────── 中核: 再計算 ─────────────────────────

function applyRollover(bal, gd, events) {
  const year = parseDate(gd).y;
  const grant = Object.prototype.hasOwnProperty.call(GRANT_OVERRIDES, String(year))
    ? GRANT_OVERRIDES[String(year)]
    : ANNUAL_GRANT_MINUTES;

  // 繰越分がマイナス（記録が実態より多い）の場合、その不足は消さずに持ち越す。
  const deficit = Math.min(0, bal.carryoverMinutes);
  const expired = Math.max(0, bal.carryoverMinutes);          // 規程 繰越分は全額失効
  const carryable = bal.currentMinutes + deficit;
  const carried = Math.min(carryable, CARRYOVER_CAP_MINUTES); // 規程 上限clamp
  const clamped = Math.max(0, carryable - carried);

  bal.carryoverMinutes = carried;
  bal.currentMinutes = grant;
  bal.hourlyUsedMinutes = 0;

  events.push({
    date: gd,
    type: 'rollover',
    grantMinutes: grant,
    expiredMinutes: expired + clamped,
    clampedMinutes: clamped,
  });
}

function applyConsume(bal, e, warnings) {
  const min = e.minutes;
  if (e.kind === 'hourly') {
    bal.hourlyUsedMinutes += min;
    if (min % HOURLY_UNIT_MINUTES !== 0) {
      warnings.push({ code: 'hourly-not-unit', id: e.id, date: e.date, minutes: min });
    }
    if (bal.hourlyUsedMinutes > HOURLY_CAP_MINUTES) {
      warnings.push({ code: 'hourly-cap-exceeded', id: e.id, date: e.date, used: bal.hourlyUsedMinutes });
    }
  }
  // 規程 前年度に付与した日数（＝繰越分）から先に消費する
  const fromCarry = Math.max(0, Math.min(bal.carryoverMinutes, min));
  bal.carryoverMinutes -= fromCarry;
  bal.currentMinutes -= min - fromCarry;
  if (bal.currentMinutes < 0) {
    warnings.push({ code: 'negative-balance', id: e.id, date: e.date, currentMinutes: bal.currentMinutes });
  }
}

const cloneBal = (b) => ({
  currentMinutes: b.currentMinutes,
  carryoverMinutes: b.carryoverMinutes,
  hourlyUsedMinutes: b.hourlyUsedMinutes,
});

/**
 * baseline（棚卸しチェックポイント）と history から、today 時点の残高を再計算する。
 *
 * 仕様として固定していること:
 *  - history は日付昇順に安定ソートする（入力順に結果が依存してはならない）
 *  - baseline.date より前のエントリは計算対象外（warnings に pre-baseline を積む）
 *  - baseline.date と同日のエントリは計算対象に含める
 *  - 4月1日ちょうどは「その日の先頭でロールオーバー → その後に同日エントリを消費」。
 *    規程により4/1時点で旧繰越は既に消滅しているため
 *  - baseline.date 当日の付与日は適用しない（棚卸しの値は付与後の残高を見て入力するため）
 */
export function replay(state, today) {
  if (!isValidDate(today)) throw new Error(`invalid today: ${today}`);
  const st = state.readOnly === undefined ? normalizeState(state) : state;
  const warnings = [];

  const entries = st.history
    .map((e, i) => ({ ...e, _i: i }))
    .filter((e) => {
      if (compareDate(e.date, st.baseline.date) < 0) {
        warnings.push({ code: 'pre-baseline', id: e.id, date: e.date });
        return false;
      }
      return true;
    })
    .sort((a, b) => compareDate(a.date, b.date) || a._i - b._i);

  const bal = cloneBal(st.baseline);
  const events = [];
  const grantDates = grantDatesBetween(st.baseline.date, today);
  let gi = 0;

  for (const e of entries) {
    if (compareDate(e.date, today) > 0) break;
    while (gi < grantDates.length && compareDate(grantDates[gi], e.date) <= 0) {
      applyRollover(bal, grantDates[gi], events);
      gi++;
    }
    applyConsume(bal, e, warnings);
  }
  while (gi < grantDates.length) {
    applyRollover(bal, grantDates[gi], events);
    gi++;
  }

  // 次の失効日までに登録済みの「予定」を消化した場合の見込み。
  // これが無いと、3月に休む予定を入れてあっても「3日失効します」と誤警報を出す。
  const expiryDate = nextGrantDate(today);
  const projected = cloneBal(bal);
  const plannedEntries = entries.filter(
    (e) => compareDate(e.date, today) > 0 && compareDate(e.date, expiryDate) < 0
  );
  // 予定を1件ずつ消化しながら、その時点の残高を控える。
  // 履歴の予定行に「この休みを取ったら残いくつになるか」を出すために使う。
  const plannedTimeline = [];
  for (const e of plannedEntries) {
    applyConsume(projected, e, []);
    plannedTimeline.push({
      id: e.id,
      date: e.date,
      totalMinutes: projected.currentMinutes + projected.carryoverMinutes,
    });
  }

  const fy = fiscalYearOf(today);
  const { start, end } = fiscalYearRange(fy);
  // 棚卸しが同じ年度内にあるときだけ、棚卸し時点までの取得実績を初期値にする。
  // 年度をまたいだ値を持ち越すと、新年度の5日カウントが最初から埋まった状態になる。
  // 集計対象は entries（棚卸しより前を除外済み）。st.history をそのまま使うと、
  // 残高計算では無視した棚卸し前の記録が法定カウントにだけ二重に乗る。
  let takenDays =
    fiscalYearOf(st.baseline.date) === fy ? (st.baseline.statutoryTakenDays ?? 0) : 0;
  let plannedDays = 0;
  for (const e of entries) {
    if (compareDate(e.date, start) < 0 || compareDate(e.date, end) > 0) continue;
    const v = STATUTORY_DAY_VALUE[e.kind] ?? 0;
    if (compareDate(e.date, today) <= 0) takenDays += v;
    else plannedDays += v;
  }

  return {
    asOf: { ...bal, totalMinutes: bal.currentMinutes + bal.carryoverMinutes },
    projected: { ...projected, totalMinutes: projected.currentMinutes + projected.carryoverMinutes },
    expiryDate,
    lastUsableDate: lastUsableDateFor(expiryDate),
    expiringMinutes: Math.max(0, bal.carryoverMinutes),
    projectedExpiringMinutes: Math.max(0, projected.carryoverMinutes),
    // 未来日付で登録済みの「予定」。horizon は次の失効日の前日で、
    // 付与日をまたぐ予定は含めない（付与と失効を挟むと単純な引き算にならないため）。
    plannedCount: plannedEntries.length,
    plannedMinutes: plannedEntries.reduce((s, e) => s + e.minutes, 0),
    plannedTimeline,
    hourlyRemainingMinutes: HOURLY_CAP_MINUTES - bal.hourlyUsedMinutes,
    statutory: {
      takenDays,
      plannedDays,
      requiredDays: STATUTORY_REQUIRED_DAYS,
      deadline: end,
      fiscalYear: fy,
    },
    events,
    warnings,
  };
}

/** 失効日（4/1）の前日 = 実際に使える最終日（3/31）。「4/1に失効」を「4/1まで使える」と誤読させないため。 */
export function lastUsableDateFor(grantDate) {
  const { y } = parseDate(grantDate);
  return `${y}-03-31`;
}

/** 2つの日付の差（日数）。表示用の概算に使う（うるう年を正しく扱う）。 */
export function daysBetween(from, to) {
  return toEpochDay(parseDate(to)) - toEpochDay(parseDate(from));
}

/** 日付の加減算。Date を使わずに行う（昨日・明日チップ用）。 */
export function addDays(date, n) {
  return fromEpochDay(toEpochDay(parseDate(date)) + n);
}

function fromEpochDay(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// 1970-01-01 からの通算日数。Date を使わずに計算する。
function toEpochDay({ y, m, d }) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  const jdn =
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045;
  return jdn - 2440588;
}

/** 記録エントリを作る。hourly のみ minutes を指定する。 */
export function makeEntry({ id, date, kind, hours = 0, note = '' }) {
  if (!isValidDate(date)) throw new Error(`invalid date: ${date}`);
  if (!KIND_LABEL[kind]) throw new Error(`invalid kind: ${kind}`);
  const minutes = kind === 'hourly' ? Math.round(hours * 60) : KIND_MINUTES[kind];
  return { id: String(id), date, kind, minutes, note: String(note ?? '') };
}
