/**
 * 自然语言日期解析：从一句人话里认出「截止日期 / 时间」，并把认出来的词从标题里摘掉。
 *
 * 设计原则（保守优先）：
 *   1. 只认**明确的日期词**，宁可漏也不误吞（"买3个苹果" 里的 3 不能变成"3 天后"）；
 *   2. 出现多个星期几时取**最后**一个（"周一例会改到周三" → 周三）；
 *   3. 结果的每一处都能追溯到原文片段（matched），人类侧据此显示"从标题识别"并可撤销；
 *   4. 与 `normalizeDue` 的既有说法保持兼容（今天/明天/昨天/+3d/本周）。
 *
 * 人类面板与 worktodo_* 工具共用这一份实现，避免两边理解不一致。
 */
import { dayKey, weekStartKey } from './records.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const PERIOD_HOUR = { 今早: 9, 早上: 9, 早晨: 9, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 今晚: 20, 明晚: 20, 晚上: 20, 晚: 20, 夜里: 21 };

const toCnNumber = (raw) => {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (CN_NUM[raw[1]] ?? 0);
  if (raw.includes('十')) {
    const [a, b] = raw.split('十');
    return (CN_NUM[a] ?? 1) * 10 + (CN_NUM[b] ?? 0);
  }
  return CN_NUM[raw] ?? null;
};

/**
 * @param {string} text 用户输入
 * @param {number} [now] 基准时刻
 * @returns {{title:string, due:string|null, dueTime:string|null, matched:string[]}}
 */
export function parseNaturalDue(text, now = Date.now()) {
  const source = typeof text === 'string' ? text : '';
  const spans = []; // {start, end, kind:'date'|'time'}
  let due = null;
  let dueTime = null;
  let hourFromPeriod = null; // 「今晚」这类只给时段，兜底时间

  const today = dayKey(now);
  const todayStart = new Date(`${today}T00:00:00`).getTime();

  // ---------- 1) 绝对日期：2026-10-20 / 10月20日 / 10/20 ----------
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(source);
  if (m) {
    due = dayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
    spans.push({ start: m.index, end: m.index + m[0].length, kind: 'date' });
  } else {
    m = /(\d{1,2})月(\d{1,2})日?/.exec(source);
    if (m) {
      // 省略年份：取「最近一次」（已过去就顺延到明年）
      let year = new Date(now).getFullYear();
      let candidate = dayKey(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
      if (candidate < today) candidate = dayKey(new Date(year + 1, Number(m[1]) - 1, Number(m[2])).getTime());
      due = candidate;
      spans.push({ start: m.index, end: m.index + m[0].length, kind: 'date' });
    }
  }

  // ---------- 2) 星期：周X / 星期X / 礼拜X / 下周一（多个取最后一个） ----------
  const weekRe = /(下下|下个|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])/g;
  for (let w = weekRe.exec(source); w; w = weekRe.exec(source)) {
    const offsetWeeks = w[1] === '下' || w[1] === '下个' ? 1 : w[1] === '下下' ? 2 : 0;
    const target = WEEKDAY[w[2]] ?? Number(w[2]);
    const thisWeekStart = new Date(`${weekStartKey(now)}T00:00:00`).getTime();
    let stamp = thisWeekStart + (target - 1) * DAY_MS + offsetWeeks * 7 * DAY_MS;
    if (offsetWeeks === 0 && stamp < todayStart) stamp += 7 * DAY_MS; // 已过则算下周
    const candidate = dayKey(stamp);
    // 后面的星期几覆盖前面的（"改到周三"的语义）
    if (due === null || spans.some((s) => s.kind === 'date' && s.weekday)) {
      spans.filter((s) => s.weekday).forEach((s) => { s.dropped = true; });
    }
    due = candidate;
    spans.push({ start: w.index, end: w.index + w[0].length, kind: 'date', weekday: true });
  }

  // ---------- 3) 相对天数：今天/明天/后天/大后天/3天后/+3d ----------
  if (due === null) {
    const relWords = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨: -1 };
    for (const [word, offset] of Object.entries(relWords)) {
      const at = source.indexOf(word);
      if (at !== -1) {
        due = dayKey(now + offset * DAY_MS);
        spans.push({ start: at, end: at + word.length, kind: 'date' });
        break;
      }
    }
  }
  if (due === null) {
    const plus = /\+(\d{1,3})\s*d(?:ay)?s?/.exec(source);
    const cn = /([0-9零一两二三四五六七八九十]+)\s*天\s*(?:后|以后|之后)/.exec(source);
    if (plus) {
      due = dayKey(now + Number(plus[1]) * DAY_MS);
      spans.push({ start: plus.index, end: plus.index + plus[0].length, kind: 'date' });
    } else if (cn) {
      const n = toCnNumber(cn[1]);
      if (n !== null) {
        due = dayKey(now + n * DAY_MS);
        spans.push({ start: cn.index, end: cn.index + cn[0].length, kind: 'date' });
      }
    }
  }

  // ---------- 4) 时段词：今晚 / 明早 / 下午 / 早上 ----------
  const periodRe = /(今晚|明晚|明早|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/;
  const period = periodRe.exec(source);
  if (period) {
    hourFromPeriod = PERIOD_HOUR[period[1]] ?? null;
    if (due === null) {
      if (period[1] === '今晚' || period[1] === '明晚') due = dayKey(now + (period[1] === '明晚' ? 1 : 0) * DAY_MS);
      if (period[1] === '明早') due = dayKey(now + DAY_MS);
    }
    spans.push({ start: period.index, end: period.index + period[1].length, kind: 'time' });
  }

  // ---------- 5) 具体时间：下午3点 / 3点半 / 15:00 / 上午10点 ----------
  const hm = /(\d{1,2})[:：](\d{2})/.exec(source);
  const cnHour = /([0-9零一两二三四五六七八九十]+)\s*[点时](半|[0-9零一两二三四五六七八九十]{1,3}分)?/.exec(source);
  if (hm) {
    const h = Number(hm[1]);
    if (h <= 23 && Number(hm[2]) <= 59) dueTime = `${String(h).padStart(2, '0')}:${hm[2]}`;
    spans.push({ start: hm.index, end: hm.index + hm[0].length, kind: 'time' });
  } else if (cnHour) {
    let h = toCnNumber(cnHour[1]);
    if (h !== null && h <= 23) {
      if (h <= 12 && hourFromPeriod !== null && hourFromPeriod >= 12) h = h === 12 ? 12 : h + 12; // 下午3点 → 15
      const minute = cnHour[2] === '半' ? 30 : cnHour[2] ? (toCnNumber(cnHour[2].replace('分', '')) ?? 0) : 0;
      if (minute <= 59) dueTime = `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      spans.push({ start: cnHour.index, end: cnHour.index + cnHour[0].length, kind: 'time' });
    }
  } else if (hourFromPeriod !== null) {
    dueTime = `${String(hourFromPeriod).padStart(2, '0')}:00`; // 只有时段词 → 用该时段默认钟点
  }

  // 只认到时间、没认到日期 → 今天（用户决定④）
  if (dueTime && !due) due = today;

  // ---------- 6) 摘除：把认出来的片段从标题里去掉 ----------
  const kept = spans.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  let title = source;
  for (const span of [...kept].reverse()) {
    title = title.slice(0, span.start) + ' ' + title.slice(span.end);
  }
  title = title.replace(/\s+/g, ' ').trim();

  return {
    title: title || source.trim(),
    due,
    dueTime,
    matched: kept.map((s) => source.slice(s.start, s.end)),
  };
}
