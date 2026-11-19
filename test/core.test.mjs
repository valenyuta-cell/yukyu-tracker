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
  formatBalance,
  formatLeaveAmount,
  makeEntry,
  daysBetween,
  lastUsableDateFor,
} from '../core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const D = (n) => n * DAY_MINUTES;

function state({ date, cur, carry, hourly = 0, statutory = 0, curBank = 0, carryBank = 0, history = [] }) {
  return {
    schemaVersion: 1,
    baseline: {
      date,
      currentMinutes: cur,
      carryoverMinutes: carry,
      hourlyUsedMinutes: hourly,
      statutoryTakenDays: statutory,
      currentBankMinutes: curBank,
      carryoverBankMinutes: carryBank,
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

test('30. 未来の予定は今の残高を動かさず、予定を引いた見通しとして返る', () => {
  const st = state({
    date: '2026-07-31',
    cur: D(11.5),
    carry: 0,
    history: [entry('2026-08-12', 'full'), entry('2026-09-04', 'half-am')],
  });
  const v = replay(st, '2026-07-31');

  // 今の残は動かない
  assert.equal(v.asOf.totalMinutes, D(11.5));
  // 予定は件数・分数・消化後の残として別に返る
  assert.equal(v.plannedCount, 2);
  assert.equal(v.plannedMinutes, D(1.5));
  assert.equal(v.projected.totalMinutes, D(10));

  // 各予定を消化した時点の残高が順に取れる（履歴の予定行に出す用）
  assert.deepEqual(
    v.plannedTimeline.map((p) => [p.date, p.totalMinutes]),
    [['2026-08-12', D(10.5)], ['2026-09-04', D(10)]]
  );

  // 予定日が来れば同じ記録が asOf 側に移り、予定は空になる
  const later = replay(st, '2026-09-30');
  assert.equal(later.asOf.totalMinutes, D(10));
  assert.equal(later.plannedCount, 0);
  assert.equal(later.plannedTimeline.length, 0);
});

test('31. 付与日をまたぐ予定は予定の見通しに含めない', () => {
  const st = state({
    date: '2027-03-01',
    cur: D(5),
    carry: D(2),
    history: [entry('2027-03-10', 'full'), entry('2027-05-20', 'full')],
  });
  const v = replay(st, '2027-03-01');
  // 3/10 のみ。4/1 をまたぐ 5/20 は付与と失効を挟むので単純な引き算にならない
  assert.equal(v.plannedCount, 1);
  assert.equal(v.plannedMinutes, D(1));
  assert.equal(v.projected.totalMinutes, D(6));
});

// ───────────────────── 会社の勤怠表示との突き合わせ ─────────────────────

test('32. formatLeaveAmount は半休を 0.5日 と書く（「4時間」と書かない）', () => {
  assert.equal(formatLeaveAmount(DAY_MINUTES), '1日');
  assert.equal(formatLeaveAmount(DAY_MINUTES / 2), '0.5日');
  assert.equal(formatLeaveAmount(-DAY_MINUTES / 2), '-0.5日');
  assert.equal(formatLeaveAmount(D(1.5)), '1.5日');
  assert.equal(formatLeaveAmount(0), '0時間');
  // 時間単位年休だけは日数へ書き替えない（法定5日に算入されないため）
  assert.equal(formatLeaveAmount(240, 'hourly'), '4時間');
  assert.equal(formatLeaveAmount(480, 'hourly'), '8時間');
  assert.equal(formatLeaveAmount(120, 'hourly'), '2時間');
  assert.equal(formatLeaveAmount(240, 'half-am'), '0.5日');
});

test('33. formatBalance は端数を日数へ繰り上げず「4.5日7時間」と分ける', () => {
  // 2580分 = 43時間。端数(崩した1日の残り)が7時間なら会社と同じ 4.5日7時間 になる。
  assert.equal(formatBalance(2580, 420), '4.5日7時間');
  // 同じ量でも、崩した1日が無ければ従来どおり 5日3時間。
  assert.equal(formatBalance(2580, 0), '5日3時間');
  assert.equal(formatBalance(5520, 240), '11日4時間');
  assert.equal(formatBalance(5520, 0), '11.5日');
  assert.equal(formatBalance(D(20), 0), '20日');
  assert.equal(formatBalance(0, 0), '0日');
  assert.equal(formatBalance(2700, 0), '5日5時間');   // ちょうど半日でない端数は時間のまま
  assert.equal(formatBalance(300, 999), '5時間');     // 範囲外の端数は無視して従来の分解に戻す
  assert.equal(formatBalance(DAY_MINUTES / 2, 0), '0.5日');
  // マイナス残も履歴行と同じ「0.5日」流儀にそろえる（「-4時間」と書かない）
  assert.equal(formatBalance(-240, 0), '-0.5日');
  assert.equal(formatBalance(-420, 0), '-7時間');
  assert.equal(formatBalance(-D(1.5), 0), '-1.5日');
});

test('34. 時間単位年休を取ると1日を8時間に崩し、端数が残る', () => {
  const r = replay(
    state({ date: '2026-04-01', cur: D(20), carry: 0, history: [entry('2026-05-01', 'hourly', 1)] }),
    '2026-06-01'
  );
  assert.equal(r.asOf.totalMinutes, D(20) - 60);
  assert.equal(r.asOf.bankMinutes, 420);            // 8時間崩して1時間使い、7時間残っている
  assert.equal(r.asOf.currentBankMinutes, 420);
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '19日7時間');
});

test('35. 棚卸しの端数は半休を挟んでも日数側へ混ざらない', () => {
  // 会社が「4.5日7時間」と言った状態を棚卸しで入れ、半休を1件取る。
  const r = replay(
    state({
      date: '2026-11-19',
      cur: D(4.5) + 420,
      carry: 0,
      curBank: 420,
      history: [entry('2026-11-20', 'half-am')],
    }),
    '2026-11-25'
  );
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '4日7時間');
  assert.equal(r.asOf.totalMinutes, D(4) + 420);
});

test('36. 端数は当年分にあれば繰り越され、繰越分にあれば付与日に失効する', () => {
  const carried = replay(
    state({ date: '2026-11-19', cur: D(4.5) + 420, carry: 0, curBank: 420 }),
    '2027-04-02'
  );
  assert.equal(carried.asOf.carryoverBankMinutes, 420);
  assert.equal(carried.asOf.currentBankMinutes, 0);
  assert.equal(carried.asOf.carryoverMinutes, D(4.5) + 420);
  assert.equal(formatBalance(carried.asOf.totalMinutes, carried.asOf.bankMinutes), '24.5日7時間');

  // 繰越分側の端数 → 付与日に繰越分ごと失効し、端数も消える
  const expired = replay(
    state({ date: '2026-11-19', cur: D(10), carry: D(2) + 420, carryBank: 420 }),
    '2027-04-02'
  );
  assert.equal(expired.asOf.bankMinutes, 0);
  assert.equal(expired.asOf.carryoverMinutes, D(10));
  assert.equal(formatBalance(expired.asOf.totalMinutes, expired.asOf.bankMinutes), '30日');
});

test('37. 端数を持つ状態は 0.5日 刻みで読め、日数部と時間部の合計が残高と一致する', () => {
  const r = replay(
    state({
      date: '2026-11-19',
      cur: D(4.5) + 420,
      carry: 0,
      curBank: 420,
      history: [entry('2026-11-21', 'hourly', 2), entry('2026-11-22', 'half-pm')],
    }),
    '2026-11-25'
  );
  // 7時間 − 2時間 = 5時間、日数は 4.5 − 0.5 = 4.0
  assert.equal(r.asOf.bankMinutes, 300);
  assert.equal(r.asOf.totalMinutes, D(4) + 300);
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '4日5時間');
});

test('38. 端数は引いた枠だけで動く（繰越分に収まる消費で当年分の内訳を汚さない）', () => {
  // 繰越1.5日から時間単位を 2h → 4h → 3h。3手目は繰越に無傷の半日しか無いので、
  // 崩せるのは8時間ではなく4時間。480で崩すと実在しない4時間が端数に湧く。
  const r = replay(
    state({
      date: '2026-05-01',
      cur: D(20),
      carry: D(1.5),
      history: [
        entry('2026-06-01', 'hourly', 2),
        entry('2026-06-08', 'hourly', 4),
        entry('2026-06-15', 'hourly', 3),
      ],
    }),
    '2026-06-20'
  );
  assert.equal(r.asOf.currentMinutes, D(20));            // 当年分は1分も引かれていない
  assert.equal(r.asOf.currentBankMinutes, 0);            // ので端数も付かない
  assert.equal(r.asOf.carryoverMinutes, 180);
  assert.equal(r.asOf.carryoverBankMinutes, 180);
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '20日3時間');
  // 内訳の和＝合計
  assert.equal(
    formatBalance(r.asOf.currentMinutes, r.asOf.currentBankMinutes) +
      '+' + formatBalance(r.asOf.carryoverMinutes, r.asOf.carryoverBankMinutes),
    '20日+3時間'
  );
});

test('39. 繰越上限clampで切り捨てた分に端数が含まれていたら、端数も失効する', () => {
  const r = replay(
    state({
      date: '2026-11-19',
      cur: D(20) + 420,          // 棚卸しで「20日7時間」を入れた状態
      carry: 0,
      curBank: 420,
      history: [entry('2027-05-01', 'half-am')],
    }),
    '2027-05-02'
  );
  assert.equal(r.asOf.bankMinutes, 0);     // 7時間は上限clampで切り捨てられている
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '39.5日');
});

test('40. 端数を抱えた繰越分が尽きて当年分へ食い込む場合', () => {
  const r = replay(
    state({
      date: '2026-11-19',
      cur: D(5),
      carry: 60,
      carryBank: 60,
      history: [entry('2026-11-20', 'hourly', 3)],
    }),
    '2026-11-25'
  );
  assert.equal(r.asOf.carryoverMinutes, 0);
  assert.equal(r.asOf.carryoverBankMinutes, 0);
  assert.equal(r.asOf.currentBankMinutes, 360);   // 当年分の1日を崩して6時間残った
  assert.equal(formatBalance(r.asOf.totalMinutes, r.asOf.bankMinutes), '4日6時間');

  // 付与日を越えても当年分側の端数は失効せず、繰越分として残る
  const next = replay(
    state({
      date: '2026-11-19',
      cur: D(5),
      carry: 60,
      carryBank: 60,
      history: [entry('2026-11-20', 'hourly', 3)],
    }),
    '2027-04-02'
  );
  assert.equal(next.asOf.carryoverBankMinutes, 360);
  assert.equal(next.asOf.totalMinutes, D(20) + 2280);
});

test('41. 不変条件: 端数は枠を超えず、日数部は必ず0.5日刻みになる（総当たり）', () => {
  // 端数が枠と整合しなくなると formatBalance が存在しない 0.5日 を作り、
  // 「当年 + 繰越 = 残」が画面上で崩れる。消費の組み合わせを総当たりで検査する。
  const KINDS = ['full', 'half-am', 'half-pm', 'hourly'];
  const HOURS = [1, 2, 3, 4];
  const CARRY = [0, 60, 240, 300, 480, 720, D(1.5), D(3)];
  const CUR = [0, 240, D(5), D(20)];
  let cases = 0;

  const checkFrame = (frame, bank, where) => {
    if (frame <= 0) {
      assert.equal(bank, 0, `${where}: 枠が空なのに端数 ${bank}`);
      return;
    }
    assert.ok(bank >= 0 && bank <= frame, `${where}: 端数 ${bank} が枠 ${frame} を超えている`);
    assert.ok(bank < DAY_MINUTES, `${where}: 端数 ${bank} が1日以上`);
    assert.equal(bank % 240, frame % 240, `${where}: 日数部が0.5日刻みでない (${frame}/${bank})`);
  };

  for (const carry of CARRY) {
    for (const cur of CUR) {
      for (const k1 of KINDS) {
        for (const h1 of k1 === 'hourly' ? HOURS : [0]) {
          for (const k2 of KINDS) {
            for (const h2 of k2 === 'hourly' ? HOURS : [0]) {
              const st = state({
                date: '2026-05-01',
                cur,
                carry,
                history: [entry('2026-06-01', k1, h1), entry('2026-06-02', k2, h2)],
              });
              for (const today of ['2026-06-10', '2027-04-02']) {
                const a = replay(st, today).asOf;
                cases += 1;
                checkFrame(a.currentMinutes, a.currentBankMinutes, `当年 ${today}`);
                checkFrame(a.carryoverMinutes, a.carryoverBankMinutes, `繰越 ${today}`);
                // 両枠が同時に端数を持つことはない（消化は繰越分が先）
                assert.ok(
                  a.currentBankMinutes === 0 || a.carryoverBankMinutes === 0,
                  `両枠に端数 (${a.currentBankMinutes}/${a.carryoverBankMinutes})`
                );
                // 内訳の表示の和が合計の表示と一致する
                if (a.currentMinutes >= 0 && a.carryoverMinutes >= 0) {
                  const sum =
                    (a.currentMinutes - a.currentBankMinutes) +
                    (a.carryoverMinutes - a.carryoverBankMinutes);
                  assert.equal(sum % 240, 0, '合計の日数部が0.5日刻みでない');
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 2000, `総当たり件数が少なすぎる: ${cases}`);
});
