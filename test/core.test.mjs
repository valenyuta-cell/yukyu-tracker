import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  VERSION,
  DAY_MINUTES,
  ANNUAL_GRANT_MINUTES,
  HOURLY_CAP_MINUTES,
  replay,
  normalizeState,
  nextGrantDate,
  grantDatesBetween,
  formatMinutes,
  makeEntry,
  daysBetween,
  lastUsableDateFor,
} from '../core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const D = (n) => n * DAY_MINUTES;

function state({ date, cur, carry, hourly = 0, statutory = 0, history = [] }) {
  return {
    schemaVersion: 1,
    baseline: {
      date,
      currentMinutes: cur,
      carryoverMinutes: carry,
      hourlyUsedMinutes: hourly,
      statutoryTakenDays: statutory,
    },
    prevBaseline: null,
    history,
    lastSeenDate: date,
  };
}

let seq = 0;
const entry = (date, kind, hours) => makeEntry({ id: `t${seq++}`, date, kind, hours });

// ───────────────────────── 計算の正常系 ─────────────────────────

test('1. 棚卸し 当年20日・繰越3日 → 残23日、失効は翌4/1（使えるのは3/31まで）', () => {
  const r = replay(state({ date: '2026-07-31', cur: D(20), carry: D(3) }), '2026-07-31');
  assert.equal(r.asOf.totalMinutes, D(23));
  assert.equal(r.expiringMinutes, D(3));
  assert.equal(r.expiryDate, '2027-04-01');
  assert.equal(r.lastUsableDate, '2027-03-31');
});

test('2. 全日1件は繰越分から引かれる（規程）', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [entry('2026-08-12', 'full')] }),
    '2026-08-31'
  );
  assert.equal(r.asOf.carryoverMinutes, D(2));
  assert.equal(r.asOf.currentMinutes, D(20));
});

test('3. 午前半休は240分減り、時間単位年休の枠は減らない', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [entry('2026-08-12', 'half-am')] }),
    '2026-08-31'
  );
  assert.equal(r.asOf.totalMinutes, D(23) - 240);
  assert.equal(r.asOf.hourlyUsedMinutes, 0);
  assert.equal(r.hourlyRemainingMinutes, HOURLY_CAP_MINUTES);
});

test('4. 時間単位2時間で枠が 2400→2280 分になる', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [entry('2026-08-12', 'hourly', 2)] }),
    '2026-08-31'
  );
  assert.equal(r.asOf.hourlyUsedMinutes, 120);
  assert.equal(r.hourlyRemainingMinutes, 2280);
  assert.equal(r.asOf.totalMinutes, D(23) - 120);
});

test('5. 複数年跨ぎでロールオーバーが連続適用される', () => {
  const r = replay(state({ date: '2026-07-31', cur: D(20), carry: D(3) }), '2029-05-01');
  assert.equal(r.events.length, 3); // 2027, 2028, 2029 の4/1
  assert.equal(r.asOf.currentMinutes, ANNUAL_GRANT_MINUTES);
  assert.equal(r.asOf.carryoverMinutes, ANNUAL_GRANT_MINUTES);
  assert.equal(r.events[0].expiredMinutes, D(3)); // 2025年度付与の繰越3日が失効
  // 一切消化しなければ、以後は毎年 前年付与の20日がまるごと失効する
  assert.equal(r.events[1].expiredMinutes, D(20));
  assert.equal(r.events[2].expiredMinutes, D(20));
});

test('6. 履歴を削除すると残高が正しく戻る（再計算方式の要）', () => {
  const h = [entry('2026-08-12', 'full'), entry('2026-09-01', 'half-pm')];
  const before = replay(state({ date: '2026-07-31', cur: D(20), carry: D(3), history: h }), '2026-10-01');
  const after = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [h[0]] }),
    '2026-10-01'
  );
  assert.equal(before.asOf.totalMinutes, D(23) - 480 - 240);
  assert.equal(after.asOf.totalMinutes, D(23) - 480);
});

// ───────────────────────── 境界 ─────────────────────────

test('7. 4/1当日はロールオーバーが先、その後に同日エントリを消費する', () => {
  const r = replay(
    state({ date: '2027-03-01', cur: D(20), carry: D(3), history: [entry('2027-04-01', 'full')] }),
    '2027-04-01'
  );
  assert.equal(r.asOf.carryoverMinutes, 9120); // 9600 - 480
  assert.equal(r.asOf.currentMinutes, 9600);
  assert.equal(r.asOf.totalMinutes, 18720); // 消費先行だと 19200 になり1日過大
  assert.equal(r.events[0].expiredMinutes, D(3));
});

test('8. 境界の対: 3/31では未発火、4/1で発火', () => {
  const s = state({ date: '2027-03-01', cur: D(20), carry: D(3) });
  const before = replay(s, '2027-03-31');
  assert.equal(before.events.length, 0);
  assert.equal(before.asOf.carryoverMinutes, D(3));

  const after = replay(s, '2027-04-01');
  assert.equal(after.events.length, 1);
  assert.equal(after.asOf.carryoverMinutes, D(20));
});

test('9. nextGrantDate は当日を返さない', () => {
  assert.equal(nextGrantDate('2027-04-01'), '2028-04-01');
  assert.equal(nextGrantDate('2027-03-31'), '2027-04-01');
  assert.equal(nextGrantDate('2026-07-31'), '2027-04-01');
  assert.deepEqual(grantDatesBetween('2026-07-31', '2029-05-01'), [
    '2027-04-01',
    '2028-04-01',
    '2029-04-01',
  ]);
});

test('10. 順序不変性: 入力順を入れ替えても結果が完全一致する', () => {
  const a = entry('2027-06-01', 'full');
  const b = entry('2026-12-20', 'full');
  const base = { date: '2026-07-31', cur: D(20), carry: D(3) };
  const ab = replay(state({ ...base, history: [a, b] }), '2027-07-01');
  const ba = replay(state({ ...base, history: [b, a] }), '2027-07-01');

  assert.deepEqual(ab.asOf, ba.asOf);
  assert.deepEqual(ab.events, ba.events);
  // 12/20 に繰越3日から1日引かれ、4/1に残2日が失効
  assert.equal(ab.events[0].expiredMinutes, D(2));
  assert.equal(ab.asOf.carryoverMinutes, D(20) - 480);
  assert.equal(ab.asOf.currentMinutes, D(20));
});

test('11. baseline より前のエントリは計算対象外で warnings に出る', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [entry('2026-06-01', 'full')] }),
    '2026-08-01'
  );
  assert.equal(r.asOf.totalMinutes, D(23));
  assert.equal(r.warnings.filter((w) => w.code === 'pre-baseline').length, 1);
});

test('12. baseline と同日のエントリは計算対象に含める', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: D(20), carry: D(3), history: [entry('2026-07-31', 'full')] }),
    '2026-08-01'
  );
  assert.equal(r.asOf.totalMinutes, D(23) - 480);
});

test('13. 同日同種2件は重複除去されず両方引かれる', () => {
  const r = replay(
    state({
      date: '2026-07-31',
      cur: D(20),
      carry: D(3),
      history: [entry('2026-08-12', 'full'), entry('2026-08-12', 'full')],
    }),
    '2026-08-31'
  );
  assert.equal(r.asOf.totalMinutes, D(23) - 960);
});

test('14. うるう年 2028-02-29 を baseline にしてもロールオーバーは1回', () => {
  const r = replay(state({ date: '2028-02-29', cur: D(20), carry: D(3) }), '2028-04-01');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].date, '2028-04-01');
  assert.equal(daysBetween('2028-02-29', '2028-04-01'), 32);
  assert.equal(daysBetween('2027-02-28', '2027-04-01'), 32);
});

test('15. 未来の予定を織り込むと失効見込みが減る（asOf と projected の差）', () => {
  const r = replay(
    state({
      date: '2027-01-10',
      cur: D(20),
      carry: D(3),
      history: [entry('2027-03-20', 'full'), entry('2027-03-25', 'full')],
    }),
    '2027-01-10'
  );
  assert.equal(r.expiringMinutes, D(3)); // 今日時点の繰越は3日
  assert.equal(r.projectedExpiringMinutes, D(1)); // 予定2日を消化すれば失効は1日
  assert.equal(r.statutory.plannedDays, 2);
});

test('16. 時間単位が60分の倍数でなければ warning、枠超過でも記録は成功する', () => {
  const odd = replay(
    state({
      date: '2026-07-31',
      cur: D(20),
      carry: D(3),
      history: [makeEntry({ id: 'x', date: '2026-08-01', kind: 'hourly', hours: 1.5 })],
    }),
    '2026-08-31'
  );
  assert.equal(odd.warnings.some((w) => w.code === 'hourly-not-unit'), true);
  assert.equal(odd.asOf.hourlyUsedMinutes, 90);

  const over = replay(
    state({
      date: '2026-07-31',
      cur: D(20),
      carry: D(3),
      hourly: 2340,
      history: [entry('2026-08-01', 'hourly', 2)],
    }),
    '2026-08-31'
  );
  assert.equal(over.warnings.some((w) => w.code === 'hourly-cap-exceeded'), true);
  assert.equal(over.hourlyRemainingMinutes, -60);
});

test('16b. 残高不足でもマイナスを許容し warning を返す（記録は拒否しない）', () => {
  const r = replay(
    state({ date: '2026-07-31', cur: 0, carry: 0, history: [entry('2026-08-01', 'full')] }),
    '2026-08-31'
  );
  assert.equal(r.asOf.totalMinutes, -480);
  assert.equal(r.warnings.some((w) => w.code === 'negative-balance'), true);
});

test('16c. 繰越上限（規程）は棚卸しで壊された場合に clamp する', () => {
  // 棚卸しで当年分に23日を入れてしまった場合（会社表示の合計を丸ごと入れた事故）
  const r = replay(state({ date: '2027-03-01', cur: D(23), carry: 0 }), '2027-04-01');
  assert.equal(r.asOf.carryoverMinutes, ANNUAL_GRANT_MINUTES); // 20日でclamp
  assert.equal(r.events[0].clampedMinutes, D(3));
  assert.equal(r.events[0].expiredMinutes, D(3));
});

// ───────────────────────── 表示・入出力 ─────────────────────────

test('17. formatMinutes の境界（負値は符号を分離してから桁分解する）', () => {
  assert.equal(formatMinutes(0), '0時間');
  assert.equal(formatMinutes(60), '1時間');
  assert.equal(formatMinutes(480), '1日');
  assert.equal(formatMinutes(4500), '9日3時間');
  assert.equal(formatMinutes(9600), '20日');
  assert.equal(formatMinutes(19200), '40日');
  assert.equal(formatMinutes(-240), '-4時間');
  assert.equal(formatMinutes(-480), '-1日');
  assert.equal(formatMinutes(-720), '-1日4時間');
  assert.equal(formatMinutes(90), '1時間30分');
});

test('18. normalizeState は文字列・空文字・null を数値へ正規化する', () => {
  const st = normalizeState({
    schemaVersion: '1',
    baseline: { date: '2026-07-31', currentMinutes: '9600', carryoverMinutes: '', hourlyUsedMinutes: null },
    history: [{ id: 1, date: '2026-08-01', kind: 'full', minutes: '480' }],
  });
  assert.equal(st.baseline.currentMinutes, 9600);
  assert.equal(st.baseline.carryoverMinutes, 0);
  assert.equal(st.baseline.hourlyUsedMinutes, 0);
  assert.equal(st.history[0].minutes, 480);
  assert.equal(st.readOnly, false);

  const r = replay(st, '2026-08-31');
  assert.equal(r.asOf.totalMinutes, 9120);
});

test('19. replay の数値出力はすべて整数', () => {
  const r = replay(
    state({
      date: '2026-07-31',
      cur: D(20),
      carry: D(3),
      history: [entry('2026-08-12', 'half-am'), entry('2026-09-01', 'hourly', 3)],
    }),
    '2027-05-01'
  );
  for (const bucket of [r.asOf, r.projected]) {
    for (const [k, v] of Object.entries(bucket)) {
      assert.equal(Number.isInteger(v), true, `${k} = ${v} is not an integer`);
    }
  }
  assert.equal(Number.isInteger(r.expiringMinutes), true);
  assert.equal(Number.isInteger(r.hourlyRemainingMinutes), true);
});

test('20. 壊れた state は例外か readOnly に落ち、書き戻し可能な形にはしない', () => {
  assert.throws(() => normalizeState(null));
  assert.throws(() => normalizeState({ baseline: null }));
  assert.throws(() => normalizeState({ baseline: { date: 'not-a-date' } }));

  const future = normalizeState({
    schemaVersion: 2,
    baseline: { date: '2026-07-31', currentMinutes: 9600, carryoverMinutes: 0, hourlyUsedMinutes: 0 },
    history: [],
  });
  assert.equal(future.readOnly, true);
});

test('21. 法定の年5日取得義務は full=1.0 / half=0.5 / hourly=0 で数える（法定）', () => {
  const r = replay(
    state({
      date: '2026-07-31',
      cur: D(20),
      carry: D(3),
      history: [
        entry('2026-08-12', 'full'),
        entry('2026-09-01', 'half-am'),
        entry('2026-10-01', 'hourly', 8), // 1日分の時間だが法定日数には算入されない
      ],
    }),
    '2026-12-01'
  );
  assert.equal(r.statutory.takenDays, 1.5);
  assert.equal(r.statutory.requiredDays, 5);
  assert.equal(r.statutory.fiscalYear, 2026);
  assert.equal(r.statutory.deadline, '2027-03-31');
});

// ───────────────────────── メタ（規約が守られていることの検査） ─────────────────────────

test('22. core.js は Date を生成しない（タイムゾーン汚染の構造的な防止）', () => {
  const src = readFileSync(join(ROOT, 'core.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, ''); // 行コメントを除去してから検査
  assert.equal(/new Date\s*\(/.test(code), false, 'core.js に new Date( がある');
  assert.equal(/toISOString/.test(code), false, 'core.js に toISOString がある');
  assert.equal(/Date\.now/.test(code), false, 'core.js に Date.now がある');
});

test('23. sw.js の CACHE_NAME と core.js の VERSION が一致する（上げ忘れ検出）', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const m = /const CACHE_NAME = ['"]yukyu-([^'"]+)['"]/.exec(sw);
  assert.ok(m, 'sw.js に CACHE_NAME が見つからない');
  assert.equal(m[1], VERSION, `CACHE_NAME(${m[1]}) と VERSION(${VERSION}) が不一致`);
});

test('24. index.html は日付生成に Asia/Tokyo を明示し、toISOString を使わない', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.equal(/Asia\/Tokyo/.test(html), true, 'todayInTokyo が Asia/Tokyo を指定していない');
  assert.equal(/toISOString/.test(stripComments(html)), false, 'index.html に toISOString がある');
});

/** コメントを除去する。規約違反の検査が、規約を説明したコメント自身に反応しないようにするため。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('27. 棚卸しの statutoryTakenDays が法定5日カウントの初期値になる', () => {
  // 履歴を持たない棚卸し前の取得分を、法定カウントに反映できること。
  const st = state({ date: '2026-07-31', cur: 5520, carry: 0, statutory: 8.5 });
  assert.equal(replay(st, '2026-07-31').statutory.takenDays, 8.5);

  // 棚卸し後の記録は積み上がる（全日1 + 半休0.5）。
  st.history = [entry('2026-08-12', 'full'), entry('2026-08-13', 'half-am')];
  assert.equal(replay(st, '2026-08-31').statutory.takenDays, 10);

  // 時間単位年休は法定カウントに算入しない。
  st.history.push(entry('2026-08-14', 'hourly', 2));
  assert.equal(replay(st, '2026-08-31').statutory.takenDays, 10);
});

test('28. 年度をまたぐと棚卸しの statutoryTakenDays は持ち越さない', () => {
  const st = state({ date: '2026-07-31', cur: 5520, carry: 0, statutory: 8.5 });
  assert.equal(replay(st, '2027-03-31').statutory.takenDays, 8.5);
  assert.equal(replay(st, '2027-04-01').statutory.takenDays, 0);
});

test('29. 棚卸しより前の記録は法定カウントにも二重計上しない', () => {
  const st = state({
    date: '2026-07-31',
    cur: 5520,
    carry: 0,
    statutory: 8.5,
    history: [entry('2026-06-10', 'full')],
  });
  const v = replay(st, '2026-07-31');
  assert.equal(v.statutory.takenDays, 8.5);
  assert.ok(v.warnings.some((w) => w.code === 'pre-baseline'));
});
