window.__ModuleLoader__.load({ id: "dsh-worktodo", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  CELEBRATE_MS: () => CELEBRATE_MS,
  CELEBRATE_REFRESH_MS: () => CELEBRATE_REFRESH_MS,
  CHANGE_POLL_MS: () => CHANGE_POLL_MS,
  CHECK_HIT_PX: () => CHECK_HIT_PX,
  CHECK_POP_MS: () => CHECK_POP_MS,
  CHECK_SIZE_PX: () => CHECK_SIZE_PX,
  DATE_POPOVER_HEIGHT_PX: () => DATE_POPOVER_HEIGHT_PX,
  EDIT_PRIORITY_OPTIONS: () => EDIT_PRIORITY_OPTIONS,
  MARK_DRAW_DELAY_MS: () => MARK_DRAW_DELAY_MS,
  MARK_DRAW_MS: () => MARK_DRAW_MS,
  ROW_CELEBRATE_DELAY_MS: () => ROW_CELEBRATE_DELAY_MS,
  ROW_CELEBRATE_MS: () => ROW_CELEBRATE_MS,
  ROW_MIN_HEIGHT_PX: () => ROW_MIN_HEIGHT_PX,
  STYLE_TEXT: () => STYLE_TEXT,
  TITLE_SETTLE_MS: () => TITLE_SETTLE_MS,
  UPDATE_MODE_OPTIONS: () => UPDATE_MODE_OPTIONS,
  UPDATE_POLL_MS: () => UPDATE_POLL_MS,
  VIEW_SHAPES: () => VIEW_SHAPES,
  WorkTodoErrorBoundary: () => WorkTodoErrorBoundary,
  apply: () => apply,
  buildEditDraft: () => buildEditDraft,
  checkHitGeometry: () => checkHitGeometry,
  chooseDatePopoverPlacement: () => chooseDatePopoverPlacement,
  createCelebrationRefresh: () => createCelebrationRefresh,
  hasViewShape: () => hasViewShape,
  inject: () => inject,
  isUpdateBusy: () => isUpdateBusy,
  isWindowHidden: () => isWindowHidden,
  matchExistingProject: () => matchExistingProject,
  payloadRecordIds: () => payloadRecordIds,
  prefersReducedMotion: () => prefersReducedMotion,
  priorityColor: () => priorityColor,
  priorityFlagOptions: () => priorityFlagOptions,
  restartNotice: () => restartNotice,
  shapesForView: () => shapesForView,
  shouldCelebrate: () => shouldCelebrate,
  storeAlerts: () => storeAlerts,
  storeLocationLabel: () => storeLocationLabel,
  updateBadgeState: () => updateBadgeState,
  updateFailureDetail: () => updateFailureDetail
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);

// src/parse-due.mjs
var DAY_MS = 24 * 60 * 60 * 1e3;
function dayKey(stamp) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function weekStartKey(stamp) {
  const d = new Date(stamp);
  const day = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return dayKey(monday.getTime());
}
var CN_NUM = { \u96F6: 0, \u4E00: 1, \u4E24: 2, \u4E8C: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9, \u5341: 10 };
var WEEKDAY = { \u4E00: 1, \u4E8C: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u65E5: 7, \u5929: 7 };
var PERIOD_HOUR = { \u4ECA\u65E9: 9, \u65E9\u4E0A: 9, \u65E9\u6668: 9, \u4E0A\u5348: 9, \u4E2D\u5348: 12, \u4E0B\u5348: 15, \u508D\u665A: 18, \u4ECA\u665A: 20, \u660E\u665A: 20, \u665A\u4E0A: 20, \u665A: 20, \u591C\u91CC: 21 };
var toCnNumber = (raw) => {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "\u5341") return 10;
  if (raw.startsWith("\u5341")) return 10 + (CN_NUM[raw[1]] ?? 0);
  if (raw.includes("\u5341")) {
    const [a, b] = raw.split("\u5341");
    return (CN_NUM[a] ?? 1) * 10 + (CN_NUM[b] ?? 0);
  }
  return CN_NUM[raw] ?? null;
};
function parseNaturalDue(text, now = Date.now()) {
  const source = typeof text === "string" ? text : "";
  const spans = [];
  let due = null;
  let dueTime = null;
  let hourFromPeriod = null;
  const today = dayKey(now);
  const todayStart = (/* @__PURE__ */ new Date(`${today}T00:00:00`)).getTime();
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(source);
  if (m) {
    due = dayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
    spans.push({ start: m.index, end: m.index + m[0].length, kind: "date" });
  } else {
    m = /(\d{1,2})月(\d{1,2})日?/.exec(source);
    if (m) {
      let year = new Date(now).getFullYear();
      let candidate = dayKey(new Date(year, Number(m[1]) - 1, Number(m[2])).getTime());
      if (candidate < today) candidate = dayKey(new Date(year + 1, Number(m[1]) - 1, Number(m[2])).getTime());
      due = candidate;
      spans.push({ start: m.index, end: m.index + m[0].length, kind: "date" });
    }
  }
  const weekRe = /(下下|下个|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])/g;
  for (let w = weekRe.exec(source); w; w = weekRe.exec(source)) {
    const offsetWeeks = w[1] === "\u4E0B" || w[1] === "\u4E0B\u4E2A" ? 1 : w[1] === "\u4E0B\u4E0B" ? 2 : 0;
    const target = WEEKDAY[w[2]] ?? Number(w[2]);
    const thisWeekStart = (/* @__PURE__ */ new Date(`${weekStartKey(now)}T00:00:00`)).getTime();
    let stamp = thisWeekStart + (target - 1) * DAY_MS + offsetWeeks * 7 * DAY_MS;
    if (offsetWeeks === 0 && stamp < todayStart) stamp += 7 * DAY_MS;
    const candidate = dayKey(stamp);
    if (due === null || spans.some((s) => s.kind === "date" && s.weekday)) {
      spans.filter((s) => s.weekday).forEach((s) => {
        s.dropped = true;
      });
    }
    due = candidate;
    spans.push({ start: w.index, end: w.index + w[0].length, kind: "date", weekday: true });
  }
  if (due === null) {
    const relWords = { \u4ECA\u5929: 0, \u4ECA\u65E5: 0, \u660E\u5929: 1, \u660E\u65E5: 1, \u540E\u5929: 2, \u5927\u540E\u5929: 3, \u6628\u5929: -1, \u6628: -1 };
    for (const [word, offset] of Object.entries(relWords)) {
      const at = source.indexOf(word);
      if (at !== -1) {
        due = dayKey(now + offset * DAY_MS);
        spans.push({ start: at, end: at + word.length, kind: "date" });
        break;
      }
    }
  }
  if (due === null) {
    const plus = /\+(\d{1,3})\s*d(?:ay)?s?/.exec(source);
    const cn = /([0-9零一两二三四五六七八九十]+)\s*天\s*(?:后|以后|之后)/.exec(source);
    if (plus) {
      due = dayKey(now + Number(plus[1]) * DAY_MS);
      spans.push({ start: plus.index, end: plus.index + plus[0].length, kind: "date" });
    } else if (cn) {
      const n = toCnNumber(cn[1]);
      if (n !== null) {
        due = dayKey(now + n * DAY_MS);
        spans.push({ start: cn.index, end: cn.index + cn[0].length, kind: "date" });
      }
    }
  }
  const periodRe = /(今晚|明晚|明早|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/;
  const period = periodRe.exec(source);
  if (period) {
    hourFromPeriod = PERIOD_HOUR[period[1]] ?? null;
    if (due === null) {
      if (period[1] === "\u4ECA\u665A" || period[1] === "\u660E\u665A") due = dayKey(now + (period[1] === "\u660E\u665A" ? 1 : 0) * DAY_MS);
      if (period[1] === "\u660E\u65E9") due = dayKey(now + DAY_MS);
    }
    spans.push({ start: period.index, end: period.index + period[1].length, kind: "time" });
  }
  const hm = /(\d{1,2})[:：](\d{2})/.exec(source);
  const cnHour = /([0-9零一两二三四五六七八九十]+)\s*[点时](半|[0-9零一两二三四五六七八九十]{1,3}分)?/.exec(source);
  if (hm) {
    const h = Number(hm[1]);
    if (h <= 23 && Number(hm[2]) <= 59) dueTime = `${String(h).padStart(2, "0")}:${hm[2]}`;
    spans.push({ start: hm.index, end: hm.index + hm[0].length, kind: "time" });
  } else if (cnHour) {
    let h = toCnNumber(cnHour[1]);
    if (h !== null && h <= 23) {
      if (h <= 12 && hourFromPeriod !== null && hourFromPeriod >= 12) h = h === 12 ? 12 : h + 12;
      const minute = cnHour[2] === "\u534A" ? 30 : cnHour[2] ? toCnNumber(cnHour[2].replace("\u5206", "")) ?? 0 : 0;
      if (minute <= 59) dueTime = `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      spans.push({ start: cnHour.index, end: cnHour.index + cnHour[0].length, kind: "time" });
    }
  } else if (hourFromPeriod !== null) {
    dueTime = `${String(hourFromPeriod).padStart(2, "0")}:00`;
  }
  if (dueTime && !due) due = today;
  const kept = spans.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  let title = source;
  for (const span of [...kept].reverse()) {
    title = title.slice(0, span.start) + " " + title.slice(span.end);
  }
  title = title.replace(/\s+/g, " ").trim();
  return {
    title: title || source.trim(),
    due,
    dueTime,
    matched: kept.map((s) => source.slice(s.start, s.end))
  };
}

// src/client/index.js
var PKG_NAME = true ? "dsh-worktodo" : "dsh-worktodo";
var DERIVED_NAME = PKG_NAME.replace(/^dsh-/, "");
var SHORT_NAME = DERIVED_NAME === "worktodo" ? DERIVED_NAME : "worktodo";
var SLOT_ID = SHORT_NAME;
var ROUTE_BASE = `/${SHORT_NAME}`;
var LOCALE_NS = SHORT_NAME;
var ROUTE_LIST = `${ROUTE_BASE}/list`;
var FALLBACK_T = (key) => zh[key] ?? key;
var CHANGE_POLL_MS = 3e4;
var UPDATE_POLL_MS = 2e3;
function isWindowHidden(doc = typeof document !== "undefined" ? document : void 0) {
  return Boolean(doc && doc.visibilityState === "hidden");
}
var EDIT_PRIORITY_OPTIONS = ["high", "normal", "low", "none"];
function shouldCelebrate(panel) {
  return panel?.celebrate !== false;
}
var PRIORITY_LABEL_KEYS = {
  high: "prioHigh",
  normal: "prioNormal",
  low: "prioLow",
  none: "prioNone"
};
function buildEditDraft(row = {}) {
  return {
    title: typeof row.title === "string" ? row.title : "",
    due: typeof row.due === "string" ? row.due : "",
    priority: EDIT_PRIORITY_OPTIONS.includes(row.priority) ? row.priority : "normal",
    project: typeof row.project === "string" ? row.project : "",
    dueTime: typeof row.dueTime === "string" ? row.dueTime : "",
    notes: typeof row.notes === "string" ? row.notes : ""
  };
}
var zh = {
  "nav": "\u5F85\u529E",
  "title": "\u5DE5\u4F5C\u5F85\u529E",
  "panelCrashTitle": "\u5DE5\u4F5C\u5F85\u529E\u9762\u677F\u51FA\u9519\u4E86",
  "panelCrashHint": "\u6E32\u67D3\u8FD9\u5757\u9762\u677F\u65F6\u629B\u4E86\u5F02\u5E38\uFF0C\u5DF2\u5728\u8FD9\u91CC\u515C\u4F4F\uFF0C\u5F85\u529E\u6570\u636E\u672C\u8EAB\u6CA1\u4E22\u3002\u70B9\u300C\u91CD\u8BD5\u300D\u53EF\u4EE5\u91CD\u65B0\u6302\u8F7D\uFF0C\u65E0\u9700\u91CD\u542F DSH\uFF1B\u82E5\u53CD\u590D\u51FA\u73B0\uFF0C\u8BF7\u628A\u63A7\u5236\u53F0\u91CC\u7684\u5B8C\u6574\u62A5\u9519\u53D1\u51FA\u6765\u3002",
  "statOpen": "\u672A\u5B8C\u6210",
  "statOverdue": "\u903E\u671F",
  "statToday": "\u4ECA\u5929",
  "statDoing": "\u8FDB\u884C\u4E2D",
  "statDoneToday": "\u4ECA\u65E5\u5B8C\u6210",
  "refresh": "\u5237\u65B0",
  "loading": "\u8BFB\u53D6\u5F85\u529E\u2026",
  "failed": "\u8BFB\u53D6\u5931\u8D25",
  "retry": "\u91CD\u8BD5",
  "dismiss": "\u5173\u95ED",
  "storeAt": "\u5B58\u50A8\u4F4D\u7F6E",
  "storeDomain": "\u5B98\u65B9 storage",
  "storeFile": "JSON \u6587\u4EF6",
  "storeMismatch": "\u5B58\u50A8\u540E\u7AEF\u4E0D\u4E00\u81F4",
  "storeSplit": "\u4E24\u5904\u6570\u636E\u4E0D\u4E00\u81F4",
  "storeError": "\u5B58\u50A8\u8BFB\u5199\u5931\u8D25",
  "storeRetired": "\u56DE\u9000\u6587\u4EF6\u5DF2\u8FC1\u79FB\u5E76\u9000\u5F79",
  "storeRetiredArchive": "\u9000\u5F79\u6863\u6848",
  "storeUnavailable": "\u4E0D\u53EF\u7528",
  "storeRetiredUnavailable": "\u5B98\u65B9\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u4E14\u56DE\u9000\u6587\u4EF6\u5DF2\u9000\u5F79",
  "storeRetiredUnavailableHint": "\u56DE\u9000\u6587\u4EF6\u5DF2\u4E8E {when} \u9000\u5F79\uFF0C\u672C\u6B21\u8BFB\u4E0D\u5230\u5F85\u529E\uFF1B\u6863\u6848\uFF1A{archive}\u3002\u8BF7\u5728\u5E26 storage \u7684\u7EC4\u5408\u91CC\u542F\u52A8\uFF0C\u6216\u624B\u52A8\u6062\u590D\u8BE5\u6587\u4EF6",
  "storeRetiredFailed": "\u56DE\u9000\u6587\u4EF6\u9000\u5F79\u5931\u8D25\uFF08\u6587\u4EF6\u4ECD\u5728\uFF0C\u5DF2\u88AB\u6392\u9664\u5728\u5408\u5E76\u6E90\u4E4B\u5916\uFF09",
  "storeRetiredFailedHint": "\u6587\u4EF6\u4ECD\u5728 {path}\uFF1A\u8BF7\u624B\u52A8\u6539\u540D\u6216\u5220\u9664\uFF0C\u5426\u5219\u5B83\u53EF\u80FD\u8BA9\u5DF2\u5220\u9664\u7684\u5F85\u529E\u590D\u6D3B",
  "storeMergeAborted": "\u5408\u5E76\u4E24\u5904\u6570\u636E\u5931\u8D25\uFF08\u5DF2\u56DE\u6EDA\uFF0C\u672A\u7559\u4E0B\u534A\u622A\u6570\u636E\uFF09",
  "storeMergeNote": "\u5DF2\u6309 id \u5408\u5E76\u4E24\u5904\u6570\u636E\uFF1A{merged} \u6761\uFF08\u540C id \u51B2\u7A81 {conflicts}\uFF0C\u8865\u5165 {added}\uFF09",
  "addPlaceholder": "\u52A0\u4E00\u4EF6\u8981\u505A\u7684\u4E8B\uFF0C\u56DE\u8F66\u4FDD\u5B58",
  "add": "\u6DFB\u52A0",
  "dueLabel": "\u622A\u6B62",
  "priorityLabel": "\u4F18\u5148\u7EA7",
  "prioHigh": "\u9AD8",
  "prioNormal": "\u666E\u901A",
  "prioLow": "\u4F4E",
  "groupOverdue": "\u903E\u671F",
  "groupToday": "\u4ECA\u5929",
  "groupWeek": "\u672C\u5468",
  "groupLater": "\u4EE5\u540E",
  "groupCompleted": "\u5DF2\u5B8C\u6210",
  "viewDue": "\u6309\u622A\u6B62",
  "viewProject": "\u6309\u9879\u76EE",
  "noProject": "\u672A\u5F52\u7C7B",
  "sortLabel": "\u6392\u5E8F",
  "sortManual": "\u624B\u52A8",
  "sortPriority": "\u4F18\u5148\u7EA7",
  "sortCreated": "\u521B\u5EFA\u65F6\u95F4",
  "dragHint": "\u62D6\u52A8\u8C03\u6574\u987A\u5E8F\uFF08\u4F1A\u81EA\u52A8\u5207\u5230\u624B\u52A8\u6392\u5E8F\uFF09",
  "versionLabel": "\u7248\u672C",
  "versionHint": "\u5F53\u524D\u5B89\u88C5\u7684 dsh-worktodo \u7248\u672C",
  "updateAvailable": "\u6709\u65B0\u7248\u672C",
  "updateHint": "\u70B9\u300C\u4E0B\u8F7D\u300D\u628A\u65B0\u7248\u672C\u53D6\u5230\u672C\u5730\uFF0C\u4E0B\u597D\u540E\u518D\u70B9\u300C\u5B89\u88C5\u5E76\u91CD\u542F\u300D",
  "updateNow": "\u7ACB\u5373\u66F4\u65B0",
  "updateDownload": "\u4E0B\u8F7D",
  "updateDownloadHint": "\u4E0B\u8F7D\u65B0\u7248\u672C\u5230\u672C\u5730\uFF08\u8FD9\u4E00\u6B65\u4E0D\u6539\u52A8\u5DF2\u5B89\u88C5\u7684\u7248\u672C\uFF09",
  "updateChecking": "\u6B63\u5728\u68C0\u67E5\u66F4\u65B0\u2026",
  // 检查失败是温和态，不是插件故障：不出现「失败」字样，也不展示原始网络错误。
  "updateCheckFailed": "\u6682\u65F6\u65E0\u6CD5\u68C0\u67E5\u66F4\u65B0\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5",
  "updateCheckFailedHint": "\u66F4\u65B0\u670D\u52A1\u6682\u65F6\u8FDE\u4E0D\u4E0A\uFF1B\u5F85\u529E\u5217\u8868\u4E0E\u7F16\u8F91\u4E0D\u53D7\u5F71\u54CD\uFF0C\u540E\u53F0\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002",
  "updateDownloading": "\u4E0B\u8F7D\u4E2D {percent}%",
  "updateDownloadingBytes": "\u4E0B\u8F7D\u4E2D \xB7 \u5DF2\u6536\u5230 {bytes}",
  "updateVerifying": "\u6B63\u5728\u6821\u9A8C\u66F4\u65B0\u6587\u4EF6\u2026",
  "updateDownloadedState": "\u5DF2\u4E0B\u8F7D {version}",
  "updateInstallRestart": "\u5B89\u88C5\u5E76\u91CD\u542F",
  "updateInstallHint": "\u5E94\u7528\u5DF2\u4E0B\u8F7D\u7684 {version}\uFF0C\u7136\u540E\u8BF7\u6C42\u91CD\u542F DSH",
  "updateInstalling": "\u6B63\u5728\u5B89\u88C5\uFF08\u540E\u53F0\uFF09\u2026",
  "updateInstalledManual": "\u5DF2\u5B89\u88C5 {version}\uFF0C\u8BF7\u624B\u52A8\u91CD\u542F DSH",
  "updateInstalledManualHint": "DSH \u6CA1\u6709\u5411\u63D2\u4EF6\u66B4\u9732\u91CD\u542F\u5165\u53E3\uFF08\u91CD\u542F\u7531 Electron \u4E3B\u8FDB\u7A0B\u72EC\u5360\uFF09\uFF0C\u6240\u4EE5\u9700\u8981\u4F60\u624B\u52A8\u9000\u51FA\u5E76\u91CD\u65B0\u6253\u5F00 DSH \u624D\u4F1A\u52A0\u8F7D\u65B0\u7248\u672C\u3002",
  "updateRestarting": "\u91CD\u542F\u4E2D\u2026",
  "updateRestart": "\u91CD\u542F DSH",
  "updateRestartHint2": "\u7528\u5DF2\u914D\u7F6E\u7684\u91CD\u542F\u547D\u4EE4\u91CD\u542F DSH",
  "updating": "\u6B63\u5728\u66F4\u65B0\u2026",
  "updatedRestart": "\u5DF2\u66F4\u65B0\u5230 {version}\uFF0C\u91CD\u542F DSH \u751F\u6548",
  "updateRestartHint": "\u5DF2\u66F4\u65B0\u5B8C\u6210\uFF0C\u91CD\u542F DSH \u751F\u6548",
  "updateFailed": "\u66F4\u65B0\u5931\u8D25",
  "updateDownloadFailed": "\u4E0B\u8F7D\u5931\u8D25",
  "updateLinked": "\u8FD9\u662F\u672C\u5730\u94FE\u63A5\u5B89\u88C5\uFF08link:\uFF09\uFF0C\u8BF7\u5728\u4ED3\u5E93\u91CC\u7528 git/pnpm \u5DE5\u4F5C\u6D41\u66F4\u65B0",
  // 预期内的不适用（不是失败）：淡色提示、不亮红、不出现「失败」、不给重试。
  "updateUnsupportedLink": "\u5F53\u524D\u662F\u672C\u5730\u94FE\u63A5\u5B89\u88C5\uFF08\u5F00\u53D1\u6A21\u5F0F\uFF09\uFF0C\u9762\u677F\u4E0D\u80FD\u81EA\u66F4\u65B0\uFF1B\u8BF7\u7528 git/pnpm \u5DE5\u4F5C\u6D41\u66F4\u65B0",
  "updateUnsupportedProfile": "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D profile \u4F4D\u7F6E\uFF0C\u4E3A\u5B89\u5168\u8D77\u89C1\u672A\u6267\u884C\u5347\u7EA7\uFF08\u672A\u6539\u52A8\u4EFB\u4F55\u6587\u4EF6\uFF09",
  "updateRetry": "\u91CD\u8BD5",
  "updateRetryHint": "\u70B9\u51FB\u91CD\u8BD5",
  "updateFailureDetail": "\u8BE6\u60C5",
  "updateDetailStep": "\u6B65\u9AA4",
  "updateDetailCommand": "\u547D\u4EE4",
  "updateDetailExit": "\u9000\u51FA\u7801",
  "updateDetailSpawn": "\u542F\u52A8\u9519\u8BEF",
  "updateDetailVersion": "\u7248\u672C",
  "updateDetailLog": "\u65E5\u5FD7\u5C3E\u90E8",
  // 更新方式（三档）+ 设置小浮层 + 重启提醒条
  "updateSettings": "\u66F4\u65B0\u8BBE\u7F6E",
  "updateSettingsTitle": "\u66F4\u65B0\u65B9\u5F0F",
  "updateSettingsHint": "\u9009\u62E9\u63D2\u4EF6\u5982\u4F55\u68C0\u67E5\u4E0E\u5B89\u88C5\u65B0\u7248\u672C\uFF1B\u8FD9\u4E2A\u8BBE\u7F6E\u4F18\u5148\u4E8E\u63D2\u4EF6\u914D\u7F6E\u3002",
  "updateSettingsCurrentVersion": "\u5F53\u524D\u7248\u672C {version}",
  "updateModeOff": "\u7981\u7528\u66F4\u65B0",
  "updateModeOffHint": "\u5B8C\u5168\u4E0D\u68C0\u67E5\u66F4\u65B0\uFF0C\u4E5F\u4E0D\u53D1\u4EFB\u4F55\u7F51\u7EDC\u8BF7\u6C42\uFF1B\u9762\u677F\u53EA\u663E\u793A\u5F53\u524D\u7248\u672C\u3002",
  "updateModeManual": "\u4EC5\u63D0\u793A\u65B0\u7248\u672C",
  "updateModeManualHint": "\u540E\u53F0\u53EA\u68C0\u67E5\uFF1B\u53D1\u73B0\u6709\u65B0\u7248\u672C\u65F6\u7531\u4F60\u51B3\u5B9A\u662F\u5426\u4E0B\u8F7D\u3001\u5B89\u88C5\u3002",
  "updateModeAuto": "\u81EA\u52A8\u66F4\u65B0",
  "updateModeAutoHint": "\u540E\u53F0\u81EA\u52A8\u4E0B\u8F7D\u5E76\u5B89\u88C5\uFF1B\u88C5\u597D\u540E\u63D0\u793A\u4F60\u91CD\u542F DSH\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u91CD\u542F\u3002",
  "updateModeLabel": "\u66F4\u65B0\u65B9\u5F0F",
  "updateCheckNow": "\u68C0\u67E5\u66F4\u65B0",
  "updateCheckNowHint": "\u7ACB\u5373\u5728\u540E\u53F0\u68C0\u67E5\u4E00\u6B21\u65B0\u7248\u672C",
  "updateCheckDisabledOff": "\u5DF2\u7981\u7528\u66F4\u65B0\uFF0C\u4E0D\u4F1A\u68C0\u67E5\u3002",
  "updateSettingsSaving": "\u4FDD\u5B58\u4E2D\u2026",
  "updateSettingsFailed": "\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25",
  "updateRestartBanner": "\u5DF2\u66F4\u65B0\u5230 {version}\uFF0C\u8BF7\u91CD\u542F DSH \u751F\u6548",
  "updateRestartBannerNoVersion": "\u66F4\u65B0\u5DF2\u5B89\u88C5\uFF0C\u8BF7\u91CD\u542F DSH \u751F\u6548",
  "updateRestartBannerHint": "\u65B0\u7248\u672C\u5DF2\u7ECF\u88C5\u597D\u4F46\u8FD8\u6CA1\u751F\u6548\uFF1BDSH \u6CA1\u6709\u5411\u63D2\u4EF6\u63D0\u4F9B\u91CD\u542F\u5165\u53E3\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u81EA\u52A8\u91CD\u542F\u3002",
  "addOpen": "\u65B0\u589E\u5F85\u529E",
  "addCancel": "\u53D6\u6D88",
  "prioNone": "\u65E0",
  "dateUnset": "\u65E5\u671F \xB7 \u672A\u8BBE",
  "timeUnset": "\u65F6\u95F4 \xB7 \u672A\u8BBE",
  "todayWord": "\u4ECA\u5929",
  "fromParsed": "\u8BC6\u522B",
  "dueTimeLabel": "\u65F6\u95F4",
  // 行内日期编辑：日期本身就是按钮（有日期＝修改，没日期＝添加）
  "editDate": "\u4FEE\u6539\u65E5\u671F",
  "addDate": "\uFF0B \u65E5\u671F",
  "addDateLabel": "\u6DFB\u52A0\u65E5\u671F",
  "datePopover": "\u4FEE\u6539\u622A\u6B62\u65E5\u671F",
  "clearDate": "\u6E05\u9664\u65E5\u671F",
  // 保存失败的温和提示：不出现原始异常/状态码，也不说「读取失败」
  "dateSaveFailed": "\u65E5\u671F\u6CA1\u4FDD\u5B58\u4E0A\uFF0C\u5DF2\u6062\u590D\u539F\u503C",
  "expand": "\u5C55\u5F00",
  "collapse": "\u6536\u8D77",
  "empty": "\u8FD8\u6CA1\u6709\u5F85\u529E",
  "emptyHint": "\u5728\u4E0A\u9762\u8F93\u5165\u6846\u52A0\u7B2C\u4E00\u4EF6\u4E8B",
  "overdueTag": "\u903E\u671F",
  "sourceAgent": "AI",
  "sourceSession": "\u4F1A\u8BDD",
  "markDone": "\u6807\u4E3A\u5B8C\u6210",
  "unmarkDone": "\u53D6\u6D88\u5B8C\u6210",
  "editHint": "\u70B9\u51FB\u6807\u9898\u53EF\u7F16\u8F91",
  "editTitle": "\u7F16\u8F91\u6807\u9898",
  "titleSaveFailed": "\u6807\u9898\u6CA1\u4FDD\u5B58\u4E0A\uFF0C\u5DF2\u6062\u590D\u539F\u6587",
  "titleEmptyHint": "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u5DF2\u8FD8\u539F",
  "deleteBtn": "\u5220\u9664",
  "confirmDelete": "\u786E\u8BA4\u5220\u9664\uFF1F",
  "editDetails": "\u7F16\u8F91\u8BE6\u60C5",
  "save": "\u4FDD\u5B58",
  "cancel": "\u53D6\u6D88",
  "projectLabel": "\u9879\u76EE",
  "editProject": "\u4FEE\u6539\u9879\u76EE",
  "addProject": "\uFF0B \u9879\u76EE",
  "addProjectLabel": "\u6DFB\u52A0\u9879\u76EE",
  "projectSaveFailed": "\u9879\u76EE\u6CA1\u4FDD\u5B58\u4E0A\uFF0C\u5DF2\u6062\u590D\u539F\u503C",
  "projectPlaceholder": "\u9879\u76EE\u540D\uFF08\u53EF\u9009\uFF09",
  "projectNew": "\u65B0\u5EFA",
  "projectNewPlaceholder": "\u65B0\u9879\u76EE\u540D",
  "projectListTruncated": "\u9879\u76EE\u8F83\u591A\uFF0C\u53EA\u663E\u793A\u6700\u5E38\u7528\u7684 {count} \u4E2A",
  "titlePlaceholder": "\u5F85\u529E\u6807\u9898",
  "notesLabel": "\u5907\u6CE8",
  "notesPlaceholder": "\u5907\u6CE8\uFF08\u53EF\u9009\uFF09",
  "notesAdd": "\u52A0\u5907\u6CE8",
  "notesHide": "\u6536\u8D77\u5907\u6CE8",
  "adoptPre": "\u628A\u672C\u4F1A\u8BDD\u7684",
  "adoptPost": "\u6761\u5F85\u529E\u63D0\u5347\u4E3A\u5DE5\u4F5C\u5F85\u529E",
  "adoptHint": "\u8FD9\u662F\u6A21\u578B\u5728\u672C\u4F1A\u8BDD\u91CC\u5217\u7684\u5F85\u529E\u3002\u63D0\u5347\u540E\u5F52\u4F60\u6240\u6709\uFF1A\u8DE8\u4F1A\u8BDD\u4FDD\u7559\uFF0C\u8FD8\u80FD\u52A0\u4F18\u5148\u7EA7\u548C\u622A\u6B62\u65E5\u671F\u3002",
  "adoptPending": "\u5F85\u5B8C\u6210",
  "adoptDone": "\u5DF2\u63D0\u5347",
  "adoptSkipped": "\u8DF3\u8FC7",
  "titleEmpty": "\u8BF7\u5148\u5199\u70B9\u4EC0\u4E48",
  "untitled": "\uFF08\u65E0\u6807\u9898\uFF09"
};
var en = {
  "nav": "To-dos",
  "title": "Work to-dos",
  "panelCrashTitle": "Work to-dos panel crashed",
  "panelCrashHint": "Rendering this panel threw an exception; it is caught here and your to-dos are safe. Click Retry to remount it without restarting DSH \u2014 if it keeps happening, please share the full console error.",
  "statOpen": "Open",
  "statOverdue": "Overdue",
  "statToday": "Today",
  "statDoing": "In progress",
  "statDoneToday": "Done today",
  "refresh": "Refresh",
  "loading": "Loading to-dos\u2026",
  "failed": "Failed to load",
  "retry": "Retry",
  "dismiss": "Dismiss",
  "storeAt": "Stored at",
  "storeDomain": "official storage",
  "storeFile": "JSON file",
  "storeMismatch": "Storage backend mismatch",
  "storeSplit": "Data split across two locations",
  "storeError": "Storage read/write failed",
  "storeRetired": "Legacy file migrated and retired",
  "storeRetiredArchive": "archive",
  "storeUnavailable": "unavailable",
  "storeRetiredUnavailable": "Official storage unavailable and the legacy file was retired",
  "storeRetiredUnavailableHint": "the legacy file was retired at {when}, so to-dos cannot be read now; archive: {archive}. Start with the storage service, or restore that file manually",
  "storeRetiredFailed": "Retiring the legacy file failed (it still exists and is excluded as a merge source)",
  "storeRetiredFailedHint": "the file is still at {path}: rename or delete it manually, otherwise it may resurrect deleted to-dos",
  "storeMergeAborted": "Merging the two copies failed (rolled back, nothing half-written)",
  "storeMergeNote": "Merged both copies by id: {merged} items ({conflicts} id conflicts, {added} added)",
  "addPlaceholder": "Add something to do \u2014 Enter saves",
  "add": "Add",
  "dueLabel": "Due",
  "priorityLabel": "Priority",
  "prioHigh": "High",
  "prioNormal": "Normal",
  "prioLow": "Low",
  "groupOverdue": "Overdue",
  "groupToday": "Today",
  "groupWeek": "This week",
  "groupLater": "Later",
  "groupCompleted": "Completed",
  "viewDue": "By due",
  "viewProject": "By project",
  "noProject": "Uncategorized",
  "sortLabel": "Sort",
  "sortManual": "Manual",
  "sortPriority": "Priority",
  "sortCreated": "Created",
  "dragHint": "Drag to reorder (switches to manual sort)",
  "versionLabel": "Version",
  "versionHint": "Installed dsh-worktodo version",
  "updateAvailable": "Update available",
  "updateHint": 'Download the new version first, then click "Install and restart"',
  "updateNow": "Update now",
  "updateDownload": "Download",
  "updateDownloadHint": "Download the new version; the installed version is untouched",
  "updateChecking": "Checking for updates\u2026",
  // 温和态：不出现 raw error / “timeout” / “aborted”，也不说插件坏了。
  "updateCheckFailed": "Couldn't check for updates right now, will retry automatically",
  "updateCheckFailedHint": "The update service is temporarily unreachable. Your list is unaffected; it will retry automatically in the background.",
  "updateDownloading": "Downloading {percent}%",
  "updateDownloadingBytes": "Downloading \xB7 {bytes} received",
  "updateVerifying": "Verifying update files\u2026",
  "updateDownloadedState": "Downloaded {version}",
  "updateInstallRestart": "Install and restart",
  "updateInstallHint": "Apply the downloaded {version}, then request a DSH restart",
  "updateInstalling": "Installing in the background\u2026",
  "updateInstalledManual": "Installed {version} \u2014 restart DSH manually",
  "updateInstalledManualHint": "DSH exposes no restart entry point to plugins (restarting is owned by the Electron main process), so quit and reopen DSH to load the new version.",
  "updateRestarting": "Restarting\u2026",
  "updateRestart": "Restart DSH",
  "updateRestartHint2": "Restart DSH with the configured restart command",
  "updating": "Updating\u2026",
  "updatedRestart": "Updated to {version} \u2014 restart DSH to apply",
  "updateRestartHint": "Update finished \u2014 restart DSH to apply",
  "updateFailed": "Update failed",
  "updateDownloadFailed": "Download failed",
  "updateLinked": "This is a local link: install \u2014 update it with the git/pnpm workflow",
  // Expected non-applicability (not a failure): muted, no red, no "failed", no retry.
  "updateUnsupportedLink": "Local link install (dev mode) \u2014 panel self-update doesn't apply; update via your git/pnpm workflow",
  "updateUnsupportedProfile": "Couldn't determine the profile location; upgrade skipped for safety (no files changed)",
  "updateRetry": "Retry",
  "updateRetryHint": "Click to retry",
  "updateFailureDetail": "Details",
  "updateDetailStep": "step",
  "updateDetailCommand": "command",
  "updateDetailExit": "exit code",
  "updateDetailSpawn": "spawn error",
  "updateDetailVersion": "version",
  "updateDetailLog": "log tail",
  // Update mode (three options) + settings popover + restart banner
  "updateSettings": "Update settings",
  "updateSettingsTitle": "Update mode",
  "updateSettingsHint": "Choose how the plugin checks for and installs updates. This setting wins over plugin config.",
  "updateSettingsCurrentVersion": "Current version {version}",
  "updateModeOff": "Updates off",
  "updateModeOffHint": "No update checks and no network requests at all; the panel only shows the current version.",
  "updateModeManual": "Only notify me",
  "updateModeManualHint": "Checks in the background; when a new version exists, you decide whether to download and install it.",
  "updateModeAuto": "Auto-update",
  "updateModeAutoHint": "Downloads and installs automatically in the background; when done it asks you to restart DSH (it never restarts on its own).",
  "updateModeLabel": "Update mode",
  "updateCheckNow": "Check for updates",
  "updateCheckNowHint": "Run an update check in the background now",
  "updateCheckDisabledOff": "Updates are off, so nothing will be checked.",
  "updateSettingsSaving": "Saving\u2026",
  "updateSettingsFailed": "Couldn't save settings",
  "updateRestartBanner": "Updated to {version} \u2014 restart DSH to apply",
  "updateRestartBannerNoVersion": "Update installed \u2014 restart DSH to apply",
  "updateRestartBannerHint": "The new version is installed but not active yet. DSH exposes no restart entry point to plugins, so it will not restart automatically.",
  "addOpen": "New todo",
  "addCancel": "Cancel",
  "prioNone": "None",
  "dateUnset": "Date \xB7 unset",
  "timeUnset": "Time \xB7 unset",
  "todayWord": "Today",
  "fromParsed": "parsed",
  "dueTimeLabel": "Time",
  // Inline date editing: the date itself is a button (edit when set, add when unset)
  "editDate": "Edit date",
  "addDate": "\uFF0B Date",
  "addDateLabel": "Add date",
  "datePopover": "Edit due date",
  "clearDate": "Clear date",
  // Gentle failure copy: no raw exception/status code, no "read failed" wording
  "dateSaveFailed": "Couldn't save the date \u2014 reverted",
  "expand": "Expand",
  "collapse": "Collapse",
  "empty": "No to-dos yet",
  "emptyHint": "Add your first one in the box above",
  "overdueTag": "overdue",
  "sourceAgent": "AI",
  "sourceSession": "Session",
  "markDone": "Mark as done",
  "unmarkDone": "Mark as not done",
  "editHint": "Click the title to edit",
  "editTitle": "Edit title",
  "titleSaveFailed": "Couldn't save the title \u2014 reverted",
  "titleEmptyHint": "A title can't be empty \u2014 reverted",
  "deleteBtn": "Delete",
  "confirmDelete": "Delete?",
  "editDetails": "Edit details",
  "save": "Save",
  "cancel": "Cancel",
  "projectLabel": "Project",
  "editProject": "Edit project",
  "addProject": "\uFF0B Project",
  "addProjectLabel": "Add project",
  "projectSaveFailed": "Couldn't save the project \u2014 reverted",
  "projectPlaceholder": "project (optional)",
  "projectNew": "Create",
  "projectNewPlaceholder": "New project name",
  "projectListTruncated": "Many projects \u2014 showing the {count} most used",
  "titlePlaceholder": "To-do title",
  "notesLabel": "Notes",
  "notesPlaceholder": "Notes (optional)",
  "notesAdd": "Add notes",
  "notesHide": "Hide notes",
  "adoptPre": "Promote this session's ",
  "adoptPost": " to-dos into your work list",
  "adoptHint": "These are the to-dos the model listed in this session. Promoting makes them yours: they survive across sessions and take priorities and due dates.",
  "adoptPending": "open",
  "adoptDone": "Promoted",
  "adoptSkipped": "skipped",
  "titleEmpty": "Type something first",
  "untitled": "(untitled)"
};
function dayKey2(stamp) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
var DATE_POPOVER_HEIGHT_PX = 112;
function chooseDatePopoverPlacement(rect, viewportHeight, popHeight = DATE_POPOVER_HEIGHT_PX) {
  const bottom = Number(rect?.bottom);
  const height = Number(viewportHeight);
  const wanted = Number(popHeight);
  if (!Number.isFinite(bottom) || !Number.isFinite(height) || height <= 0) return "down";
  const pad = Number.isFinite(wanted) && wanted > 0 ? wanted : DATE_POPOVER_HEIGHT_PX;
  const spaceBelow = height - bottom;
  const spaceAbove = Number.isFinite(Number(rect?.top)) ? Number(rect.top) : 0;
  if (spaceBelow >= pad + 8) return "down";
  if (spaceAbove >= pad + 8) return "up";
  return spaceAbove > spaceBelow ? "up" : "down";
}
var C = {
  label: "var(--dsw-alias-label-primary)",
  label2: "var(--dsw-alias-label-secondary)",
  label3: "var(--dsw-alias-label-tertiary)",
  border: "var(--dsw-alias-border-l2)",
  border1: "var(--dsw-alias-border-l1)",
  layer1: "var(--dsw-alias-bg-layer-1)",
  hover: "var(--dsw-alias-interactive-bg-hover)",
  brand: "var(--dsw-alias-brand-primary)",
  warn: "var(--dsw-alias-state-warn-primary)",
  error: "var(--dsw-alias-state-error-primary)",
  ok: "var(--dsw-alias-state-success-primary)"
};
var tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
var UPDATE_TONE_STYLE = {
  ok: { color: C.ok, borderColor: tint(C.ok, 50), background: tint(C.ok, 12) },
  busy: { color: C.label2, borderColor: tint(C.label2, 40), background: tint(C.label2, 10) },
  warn: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) },
  // 检查更新失败专用：比 warn 更淡，明确「不是故障」，也不占用错误色。
  muted: { color: C.label3, borderColor: tint(C.label3, 35), background: tint(C.label3, 8) },
  error: { color: C.error, borderColor: tint(C.error, 50), background: tint(C.error, 12) }
};
var CHECK_SIZE_PX = 26;
var CHECK_HIT_PX = 40;
var CHECK_HIT_INSET_PX = (CHECK_HIT_PX - CHECK_SIZE_PX) / 2;
var ROW_MIN_HEIGHT_PX = 44;
var ROW_PADDING_Y_PX = 5;
var CHECK_MARGIN_TOP_PX = -3;
function checkHitGeometry() {
  const visualTop = ROW_PADDING_Y_PX + CHECK_MARGIN_TOP_PX;
  const visualBottom = visualTop + CHECK_SIZE_PX;
  const hitTop = visualTop - CHECK_HIT_INSET_PX;
  const hitBottom = visualBottom + CHECK_HIT_INSET_PX;
  const nextHitTop = ROW_MIN_HEIGHT_PX + hitTop;
  return {
    rowHeight: ROW_MIN_HEIGHT_PX,
    hitWidth: CHECK_SIZE_PX + 2 * CHECK_HIT_INSET_PX,
    hitHeight: CHECK_SIZE_PX + 2 * CHECK_HIT_INSET_PX,
    hitTop,
    hitBottom,
    nextHitTop,
    gap: nextHitTop - hitBottom,
    overlap: Math.max(0, hitBottom - nextHitTop)
  };
}
var CHECK_DASH = 14;
var CHECK_POP_MS = 620;
var MARK_DRAW_MS = 520;
var MARK_DRAW_DELAY_MS = 140;
var ROW_CELEBRATE_MS = 1150;
var ROW_CELEBRATE_DELAY_MS = 80;
var TITLE_SETTLE_MS = 560;
var CELEBRATE_MS = ROW_CELEBRATE_DELAY_MS + ROW_CELEBRATE_MS;
var CELEBRATE_REFRESH_MS = CELEBRATE_MS + 30;
var STYLE_TEXT = `
@keyframes wt-spin { to { transform: rotate(360deg); } }
/* \u52FE\u9009\u5B8C\u6210\u7684\u5E86\u795D\u52A8\u6548\uFF1A\u8F7B\u67D4\u547C\u5438 / \u63CF\u8FB9\u5199\u51FA / \u6574\u884C\u843D\u5B9A\u3002
   \u53EA\u52A8 transform / background / color / opacity\uFF0C\u7EDD\u4E0D\u6539\u5E03\u5C40\uFF08\u96F6\u5E03\u5C40\u8DF3\u52A8\uFF09\u3002 */
@keyframes wt-check-pop {
  0% { transform: scale(1); background: transparent; }
  40% { transform: scale(1.06); background: ${tint(C.ok, 10)}; }
  100% { transform: scale(1); background: ${tint(C.ok, 14)}; }
}
@keyframes wt-mark-draw { from { stroke-dashoffset: ${CHECK_DASH}; } to { stroke-dashoffset: 0; } }
@keyframes wt-row-celebrate {
  0% { background: ${tint(C.ok, 26)}; }
  40% { background: ${tint(C.ok, 16)}; }
  75% { background: ${tint(C.ok, 6)}; }
  100% { background: transparent; }
}
@keyframes wt-title-settle {
  from { color: ${C.label}; }
  to { color: ${C.label3}; }
}
.wt-root {
  height: 100%; overflow: auto; padding: 16px 18px 40px; box-sizing: border-box;
  color: ${C.label}; font-family: var(--dsw-font-family, system-ui, sans-serif); font-size: 13px;
}
.wt-input {
  min-width: 0; font-family: inherit; font-size: 12px; line-height: 1.5; padding: 4px 8px;
  border-radius: 8px; border: 1px solid ${C.border}; background: transparent; color: ${C.label};
  color-scheme: light dark;
}
.wt-input::placeholder { color: ${C.label3}; }
.wt-input:focus {
  outline: none; border-color: ${C.brand};
  box-shadow: 0 0 0 2px ${tint(C.brand, 22)};
}
.wt-btn {
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 12px;
  line-height: 1.6; padding: 3px 10px; border-radius: 8px; cursor: pointer; user-select: none;
  border: 1px solid ${C.border}; background: transparent; color: ${C.label2}; white-space: nowrap;
}
.wt-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-btn:disabled { opacity: .55; cursor: default; }
.wt-btn:disabled:hover { background: transparent; color: ${C.label2}; }
.wt-btn-primary {
  border-color: ${tint(C.brand, 50)}; color: ${C.brand}; background: ${tint(C.brand, 10)};
}
.wt-btn-primary:hover { background: ${tint(C.brand, 18)}; color: ${C.brand}; }
.wt-btn-primary:disabled:hover { background: ${tint(C.brand, 10)}; color: ${C.brand}; }
.wt-btn-danger { color: ${C.error}; border-color: ${tint(C.error, 45)}; }
.wt-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: ${C.label3}; cursor: pointer;
}
.wt-icon-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-icon-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-check {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: ${CHECK_SIZE_PX}px; height: ${CHECK_SIZE_PX}px; margin: ${CHECK_MARGIN_TOP_PX}px 0 0; padding: 0; border-radius: 8px;
  border: 1px solid ${C.border}; background: transparent; color: transparent; cursor: pointer;
}
/* \u53EF\u70B9\u533A\u57DF \u2265 ${CHECK_HIT_PX}\xD7${CHECK_HIT_PX}px\uFF1A\u4F2A\u5143\u7D20\u5411\u5916\u6269 ${CHECK_HIT_INSET_PX}px\uFF0C
   \u4E0D\u5360\u5E03\u5C40\u76D2\u3001\u4E0D\u4F1A\u63A8\u5F00\u65C1\u8FB9\u7684\u65D7\u5B50/\u6807\u9898 */
.wt-check::before { content: ''; position: absolute; inset: -${CHECK_HIT_INSET_PX}px; border-radius: 12px; }
.wt-check:hover { border-color: ${C.brand}; }
.wt-check:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
.wt-check-done {
  border-color: ${tint(C.ok, 55)}; background: ${tint(C.ok, 14)}; color: ${C.ok};
}
/* \u52FE\u9009\u5B8C\u6210\u7684\u52A8\u6548\uFF1A\u52FE\u9009\u6846\u8F7B\u547C\u5438 \u2192 \u5BF9\u52FE\u63CF\u8FB9\u5199\u51FA \u2192 \u6574\u884C\u67D4\u548C\u843D\u5B9A\uFF08\u89C1 wt-row-celebrate\uFF09\u3002
   \u4E09\u6BB5\u5404\u6709 delay\uFF0C\u5148\u540E\u5173\u7CFB\u662F\u523B\u610F\u7684\uFF1B\u7F13\u52A8\u4E00\u5F8B\u67D4\u548C ease-out\uFF0C\u4E0D\u5E26\u8FC7\u51B2\u56DE\u5F39\u3002 */
.wt-check-celebrate { animation: wt-check-pop ${CHECK_POP_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
.wt-check-celebrate .wt-check-mark path {
  stroke-dasharray: ${CHECK_DASH}; stroke-dashoffset: ${CHECK_DASH};
  animation: wt-mark-draw ${MARK_DRAW_MS}ms ease-out ${MARK_DRAW_DELAY_MS}ms both;
}
.wt-row.is-celebrating { animation: wt-row-celebrate ${ROW_CELEBRATE_MS}ms ease-out ${ROW_CELEBRATE_DELAY_MS}ms both; }
/* \u6807\u9898\u5728\u6574\u884C\u6DE1\u51FA\u7684\u524D\u534A\u6BB5\u6162\u6162\u53D8\u6210\u300C\u5DF2\u5B8C\u6210\u300D\u7684\u67D4\u548C\u7070\uFF08\u53EA\u52A8 color\uFF09 */
.wt-row.is-celebrating .wt-title {
  animation: wt-title-settle ${TITLE_SETTLE_MS}ms ease-out ${ROW_CELEBRATE_DELAY_MS}ms both;
}
/* B1\uFF1Amin-height \u5FC5\u987B \u2265 \u547D\u4E2D\u76D2\u9AD8\u5EA6\uFF08\u89C1 checkHitGeometry / ROW_MIN_HEIGHT_PX\uFF09 */
.wt-row { display: flex; align-items: flex-start; gap: 8px; padding: ${ROW_PADDING_Y_PX}px 8px; min-height: ${ROW_MIN_HEIGHT_PX}px; border-radius: 10px; }
.wt-row:hover { background: ${C.hover}; }
.wt-row-edit {
  flex-direction: column; align-items: stretch; gap: 6px;
  border: 1px solid ${C.border1}; background: ${C.layer1};
}
.wt-seg {
  display: inline-flex; align-items: center; border-radius: 8px; overflow: hidden;
  border: 1px solid ${C.border}; background: ${C.bg2};
}
.wt-seg-btn {
  appearance: none; border: 0; background: transparent; color: ${C.label2};
  font: inherit; font-size: 11.5px; line-height: 1; padding: 5px 9px; cursor: pointer;
}
.wt-seg-btn.is-on { background: ${C.hover}; color: ${C.label}; font-weight: 600; }
.wt-seg-btn:hover { color: ${C.label}; }
.wt-row[draggable="true"] { cursor: grab; }
.wt-row[draggable="true"]:active { cursor: grabbing; }
.wt-plus {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 12px 14px; margin-bottom: 10px; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 600;
  color: ${C.label2}; background: ${C.layer1};
  border: 1px dashed ${C.border}; border-radius: 12px;
}
.wt-plus:hover { color: ${C.label}; border-color: ${C.brand}; background: ${tint(C.brand, 8)}; }
.wt-plus-mark { font-size: 24px; line-height: 1; font-weight: 400; color: ${C.brand}; }
.wt-flag-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
  background: transparent; border: 1px solid transparent; color: ${C.label2};
  transition: opacity .12s ease, background .12s ease;
}
.wt-flag-btn:hover { background: ${C.hover}; }
.wt-flag-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* \u65E0\u4F18\u5148\u7EA7\u7684\u884C\uFF1A\u65D7\u5B50\u9ED8\u8BA4\u4E0D\u5360\u89C6\u7EBF\uFF08opacity:0\uFF09\uFF0C\u60AC\u505C/\u805A\u7126\u8BE5\u884C\u6216\u70B9\u5F00\u65F6\u624D\u6DE1\u51FA\u6765\u3002
   \u4ECD\u7136\u7559\u5728 DOM/\u5E03\u5C40\u91CC\uFF08\u5360\u4F4F\u90A3\u4E00\u5217\uFF0C\u5404\u884C\u5DE6\u4FA7\u5BF9\u9F50\u7A33\u5B9A\uFF09\uFF0C\u4E5F\u4FDD\u8BC1\u7EAF\u952E\u76D8 Tab \u80FD\u5230\u8FBE\u3002 */
.wt-flag-btn.is-ghost { pointer-events: none; }
.wt-group-head {
  display: flex; align-items: center; gap: 7px; padding: 3px 8px; border-radius: 8px;
  cursor: pointer; user-select: none; color: ${C.label2};
}
.wt-group-head:hover { background: ${C.hover}; }
.wt-chip {
  display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; line-height: 1.7;
  padding: 0 8px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
/* \u884C\u5185\u65E5\u671F\uFF1A\u5916\u89C2\u4ECD\u662F\u90A3\u884C\u5C0F\u5B57\uFF0C\u4F46\u5B83\u662F\u771F\u6309\u94AE\uFF08hover \u6709\u5E95\u8272+\u4E0B\u5212\u7EBF\uFF0C\u952E\u76D8\u6709 focus ring\uFF09 */
.wt-date-btn {
  appearance: none; display: inline-flex; align-items: baseline; gap: 4px;
  font: inherit; font-size: 11px; line-height: 1.7; padding: 0 4px; margin: 0;
  color: inherit; background: transparent; border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; white-space: nowrap; text-align: left;
}
.wt-date-btn:hover { background: ${tint(C.brand, 10)}; text-decoration: underline; text-underline-offset: 2px; }
.wt-date-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* \u65E0\u65E5\u671F\u7684\u884C\uFF1A\u60AC\u505C/\u805A\u7126\u65F6\u624D\u51FA\u73B0\u7684\u6DE1\u8272\u300C\uFF0B \u65E5\u671F\u300D\u5165\u53E3\uFF08\u4E0E\u884C\u9996 ghost \u65D7\u5B50\u540C\u4E00\u79CD\u505A\u6CD5\uFF09 */
.wt-date-btn.is-add { opacity: .7; border-style: dashed; border-color: ${C.border1}; }
.wt-date-btn.is-add:hover { opacity: 1; color: ${C.label2}; }
/* \u6D6E\u5C42\uFF1A\u6302\u8F7D\u65F6\u624D\u5B58\u5728\uFF1B\u9ED8\u8BA4\u5411\u4E0B\uFF0C\u7A7A\u95F4\u4E0D\u591F\u65F6\u7531 is-up \u6539\u5411\u4E0A\uFF08\u89C1 chooseDatePopoverPlacement\uFF09 */
.wt-date-pop {
  position: absolute; left: 0; z-index: 6; min-width: 188px; padding: 8px;
  display: flex; flex-direction: column; gap: 6px; text-align: left;
  background: ${C.layer1}; border: 1px solid ${C.border}; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
}
.wt-date-pop.is-down { top: calc(100% + 4px); }
.wt-date-pop.is-up { bottom: calc(100% + 4px); }
.wt-date-field { display: flex; align-items: center; gap: 6px; font-size: 11px; color: ${C.label3}; }
.wt-date-field .wt-input { flex: 1 1 auto; min-width: 0; }
.wt-date-pop-foot { display: flex; align-items: center; gap: 6px; }
.wt-date-error { font-size: 10.5px; color: ${C.warn}; }
/* \u884C\u5185\u9879\u76EE\u9009\u62E9\u6D6E\u5C42\uFF1AQuickAdd \u4E0E\u884C\u5185\u9879\u76EE\u6807\u7B7E\u5171\u7528\u540C\u4E00\u4EFD\u7EC4\u4EF6\u4E0E\u6837\u5F0F\u3002
   \u6302\u8F7D\u65F6\u624D\u5B58\u5728\uFF1B\u5B9A\u4F4D\u57FA\u51C6\u662F\u6301\u6709\u5B83\u7684\u90A3\u4E2A position:relative \u7684\u5C0F\u76D2\u5B50\u3002 */
.wt-project-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 6; padding: 6px;
  display: flex; flex-direction: column; gap: 4px; min-width: 176px; max-width: 260px;
  text-align: left; background: ${C.layer1}; border: 1px solid ${C.border};
  border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
}
/* \u884C\u5185\u9879\u76EE\u6807\u7B7E\uFF1A\u5916\u89C2\u4ECD\u662F\u90A3\u9897 #\u9879\u76EE \u5C0F\u80F6\u56CA\uFF0C\u4F46\u5B83\u662F\u771F\u6309\u94AE\u3002 */
.wt-project-btn {
  appearance: none; font-family: inherit; cursor: pointer; color: inherit;
  background: transparent;
}
.wt-project-btn:hover { background: ${tint(C.brand, 10)}; color: ${C.label}; }
.wt-project-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
/* \u6CA1\u6709\u9879\u76EE\u7684\u884C\uFF1Ahover / \u952E\u76D8\u805A\u7126\u65F6\u624D\u51FA\u73B0\u7684\u6DE1\u8272\u300C\uFF0B \u9879\u76EE\u300D\uFF08\u4E0E\uFF0B\u65E5\u671F\u540C\u4E00\u79CD\u505A\u6CD5\uFF09\u3002 */
.wt-project-btn.is-add { opacity: .7; border-style: dashed; }
.wt-project-btn.is-add:hover { opacity: 1; color: ${C.label2}; }
.wt-project-error, .wt-title-error { font-size: 10.5px; color: ${C.warn}; }
.wt-tag {
  display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; line-height: 1.6;
  padding: 0 6px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
.wt-link { cursor: pointer; user-select: none; color: var(--dsw-alias-link); font-size: 11px; }
.wt-link:hover { text-decoration: underline; }
/* \u81EA\u5347\u7EA7\u90A3\u4E00\u683C\uFF1A\u53EF\u70B9\u65F6\u662F <button>\uFF0C\u5916\u89C2\u5FC5\u987B\u4E0E\u65C1\u8FB9\u7684 chip \u4E00\u81F4 */
.wt-update { font: inherit; cursor: pointer; background: transparent; appearance: none; }
.wt-update:hover { text-decoration: underline; }
.wt-update:disabled { cursor: default; opacity: .7; }
.wt-update:disabled:hover { text-decoration: none; }
/* \u7EAF\u72B6\u6001\uFF08\u6B63\u5728\u66F4\u65B0 / \u5DF2\u88C5\u597D\u5F85\u91CD\u542F / linked\uFF09\uFF1A\u4E0D\u662F\u6309\u94AE\uFF0C\u522B\u7ED9\u53EF\u70B9\u7684\u6697\u793A */
.wt-update.is-state { cursor: default; }
.wt-update.is-state:hover { text-decoration: none; }
/* \u66F4\u65B0\u8BBE\u7F6E\u5165\u53E3 + \u5C0F\u6D6E\u5C42\uFF1A\u53EA\u7528\u4E3B\u9898\u53D8\u91CF\uFF0C\u4E0D\u5199\u989C\u8272\u5B57\u9762\u91CF\u3002
   \u5165\u53E3\u5728\u9875\u811A\u7248\u672C\u53F7\u65C1\u8FB9\uFF0C\u6240\u4EE5\u6D6E\u5C42**\u5411\u4E0A**\u5F39\uFF08bottom \u8D34\u5165\u53E3\u4E0A\u6CBF\u3001left \u5BF9\u9F50\u9875\u811A\u884C\uFF09\uFF0C
   \u8D34\u5E95\u65F6\u4E0D\u4F1A\u8D8A\u51FA\u9762\u677F\uFF1B\u523B\u610F\u4E0D\u7528 top\uFF0C\u6D6E\u5C42\u6C38\u8FDC\u671D\u9762\u677F\u5185\u90E8\u5C55\u5F00\u3002 */
.wt-settings-wrap { display: inline-flex; align-items: center; }
.wt-settings-btn { width: 20px; height: 20px; padding: 0; }
/* \u9875\u811A\u300C\u7248\u672C\u53F7 + \u9F7F\u8F6E\u300D\u8FD9\u4E00\u884C\u662F\u6D6E\u5C42\u7684\u5B9A\u4F4D\u57FA\u51C6\uFF08\u89C1 .wt-settings-pop \u7684 left/bottom\uFF09 */
.wt-ver-row { position: relative; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
.wt-settings-pop {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: auto; z-index: 20;
  width: 268px; max-width: 100%;
  padding: 10px 11px; border-radius: 10px; text-align: left;
  border: 1px solid ${C.border}; background: ${C.layer1}; color: ${C.label};
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  font-size: 11.5px; line-height: 1.55;
}
.wt-settings-pop-title { font-weight: 650; font-size: 12px; margin-bottom: 2px; }
.wt-settings-pop-hint { color: ${C.label3}; margin-bottom: 8px; }
.wt-settings-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.wt-settings-option {
  appearance: none; text-align: left; font: inherit; cursor: pointer;
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  padding: 6px 8px; border-radius: 8px; color: ${C.label2};
  border: 1px solid ${C.border1}; background: transparent;
}
.wt-settings-option:hover { background: ${C.hover}; color: ${C.label}; }
.wt-settings-option:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 1px; }
.wt-settings-option.is-on { border-color: ${tint(C.brand, 55)}; background: ${tint(C.brand, 10)}; color: ${C.label}; }
.wt-settings-option-label { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.wt-settings-radio {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  border: 1px solid ${C.border}; background: transparent;
}
.wt-settings-option.is-on .wt-settings-radio { border-color: ${C.brand}; background: ${C.brand}; }
.wt-settings-option-hint { color: ${C.label3}; font-size: 10.5px; }
.wt-settings-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border-top: 1px solid ${C.border1}; padding-top: 8px; color: ${C.label3};
}
.wt-settings-error { color: ${C.error}; margin-top: 6px; }
/* \u91CD\u542F\u63D0\u9192\u6761\uFF1A\u9192\u76EE\u4F46\u4E0D\u6253\u6270\uFF08\u4E0D\u662F\u9519\u8BEF\u7EA2\uFF09\uFF0C\u6CA1\u6709\u5047\u91CD\u542F\u6309\u94AE */
.wt-restart-banner {
  display: flex; align-items: flex-start; gap: 7px; margin-bottom: 10px;
  padding: 7px 10px; border-radius: 9px; font-size: 12px; line-height: 1.55;
  color: ${C.label}; border: 1px solid ${tint(C.ok, 45)}; background: ${tint(C.ok, 10)};
}
.wt-restart-banner-mark { flex: none; color: ${C.ok}; font-weight: 700; }
.wt-restart-banner-text { flex: 1; min-width: 0; word-break: break-word; }
/* \u884C\u5185\u6807\u9898\uFF1A\u89C6\u89C9\u4E0A\u5C31\u662F\u539F\u6765\u90A3\u884C\u5B57\uFF08\u540C\u5B57\u53F7/\u884C\u9AD8/\u989C\u8272\uFF09\uFF0C\u4F46\u5B83\u662F\u771F\u6309\u94AE\u3002
   cursor:text \u662F\u300C\u70B9\u8FDB\u53BB\u6539\u6587\u5B57\u300D\u7684\u6697\u793A\uFF1Bhover \u53EA\u52A0\u4E00\u6761\u865A\u7EBF\u4E0B\u5212\u7EBF\uFF0C\u4E0D\u6539\u4EFB\u4F55\u5E03\u5C40\u3002 */
.wt-title { word-break: break-word; }
.wt-title-btn {
  appearance: none; display: block; width: 100%; margin: 0; padding: 0;
  border: 0; background: transparent; font: inherit; line-height: inherit;
  text-align: left; cursor: text;
}
.wt-title-btn:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.wt-title-btn:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; border-radius: 4px; }
/* \u539F\u5730\u7F16\u8F91\u7528\u7684\u8F93\u5165\uFF1A\u4E0E\u6807\u9898\u540C\u4E00\u5957\u5B57\u4F53/\u884C\u9AD8\uFF0C0 \u8FB9\u6846 0 \u5185\u8FB9\u8DDD \u2192 \u884C\u9AD8\u4E0D\u8DF3\u3002 */
.wt-title-input {
  display: block; width: 100%; min-width: 0; box-sizing: border-box;
  margin: 0; padding: 0; border: 0; background: transparent;
  font: inherit; line-height: inherit; color: inherit;
}
.wt-title-input:focus { outline: 2px solid ${C.brand}; outline-offset: 2px; border-radius: 4px; }
.wt-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.brand}; animation: wt-spin .8s linear infinite;
}
/*
 * \u964D\u7EA7\uFF1A\u7CFB\u7EDF\u8981\u6C42\u300C\u51CF\u5C11\u52A8\u6001\u6548\u679C\u300D\u65F6\u5168\u90E8\u8DF3\u8FC7\u52A8\u753B\uFF0C\u53EA\u505A\u72B6\u6001\u5207\u6362\uFF08\u52FE\u4E0A/\u53D6\u6D88\u4ECD\u7136\u662F\u5373\u65F6\u7684\uFF09\u3002
 * \u8FD9\u662F\u7EAF CSS \u7684\u7B2C\u4E8C\u9053\u4FDD\u9669\u2014\u2014JS \u4FA7 prefersReducedMotion() \u5DF2\u7ECF\u4F1A\u76F4\u63A5\u4E0D\u6302 .is-celebrating\u3002
 */
@media (prefers-reduced-motion: reduce) {
  .wt-check-celebrate,
  .wt-row.is-celebrating,
  .wt-row.is-celebrating .wt-title,
  .wt-check-celebrate .wt-check-mark path { animation: none !important; }
  .wt-check-celebrate .wt-check-mark path { stroke-dasharray: none; stroke-dashoffset: 0; }
  .wt-check, .wt-flag-btn { transition: none !important; }
}
`;
var WorkTodoErrorBoundary = class extends import_react.default.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
    this.handleRetry = this.handleRetry.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`[${SHORT_NAME}] \u9762\u677F\u6E32\u67D3\u51FA\u9519\uFF08\u5DF2\u515C\u5E95\uFF0C\u672A\u767D\u5C4F\uFF09\uFF1A`, error, info?.componentStack ?? "");
  }
  /** 清掉错误状态 + 换 key：把子树整个重新挂载一次。 */
  handleRetry() {
    this.setState((prev) => ({ error: null, attempt: (prev?.attempt ?? 0) + 1 }));
  }
  render() {
    const state = this.state ?? {};
    if (!state.error) {
      return import_react.default.createElement(
        import_react.default.Fragment,
        { key: `wt-eb-${state.attempt ?? 0}` },
        this.props?.children ?? null
      );
    }
    const injected = typeof this.props?.t === "function" ? this.props.t : null;
    const t = injected ?? ((key) => zh[key] ?? key);
    const detail = state.error?.message ? String(state.error.message) : typeof state.error === "string" ? state.error : "";
    return import_react.default.createElement("div", {
      className: "wt-root wt-crash",
      role: "alert",
      style: {
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
        padding: "18px 18px 32px",
        color: C.label,
        fontSize: 13,
        lineHeight: 1.7,
        fontFamily: "var(--dsw-font-family, system-ui, sans-serif)"
      }
    }, [
      import_react.default.createElement("div", {
        key: "title",
        style: { fontWeight: 650, fontSize: 14, color: C.error, wordBreak: "break-word" }
      }, t("panelCrashTitle")),
      detail ? import_react.default.createElement("div", {
        key: "detail",
        style: {
          marginTop: 8,
          padding: "6px 9px",
          borderRadius: 8,
          fontSize: 12,
          color: C.label2,
          wordBreak: "break-word",
          border: `1px solid ${tint(C.error, 45)}`,
          background: tint(C.error, 12)
        }
      }, detail) : null,
      import_react.default.createElement("div", {
        key: "hint",
        style: { marginTop: 8, fontSize: 11.5, color: C.label3 }
      }, t("panelCrashHint")),
      injected ? null : import_react.default.createElement("div", {
        key: "en",
        style: { marginTop: 4, fontSize: 11, color: C.label3 }
      }, "Work to-dos panel crashed \u2014 click Retry to remount it."),
      import_react.default.createElement("button", {
        key: "retry",
        type: "button",
        className: "wt-btn wt-btn-primary",
        style: {
          marginTop: 12,
          font: "inherit",
          fontSize: 12,
          lineHeight: 1.6,
          padding: "4px 12px",
          borderRadius: 8,
          cursor: "pointer",
          border: `1px solid ${tint(C.brand, 50)}`,
          color: C.brand,
          background: tint(C.brand, 10)
        },
        onClick: this.handleRetry
      }, t("retry"))
    ]);
  }
};
function withErrorBoundary(Component) {
  return function WorkTodoEntry(props) {
    return import_react.default.createElement(WorkTodoErrorBoundary, { t: props?.t }, import_react.default.createElement(Component, props));
  };
}
function WorkTodoIcon({ size = 16, active }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: { opacity: active ? 1 : 0.82 }
  }, [
    import_react.default.createElement("rect", { key: "a", x: "2.7", y: "3.1", width: "10.6", height: "10.4", rx: "2" }),
    import_react.default.createElement("path", { key: "b", d: "M5.6 1.7h4.8v2.7H5.6z" }),
    import_react.default.createElement("path", { key: "c", d: "M5.7 9.3l1.7 1.7 3.1-3.5" })
  ]);
}
function IconCheck({ size = 11, className }) {
  return import_react.default.createElement("svg", {
    className,
    width: size,
    height: size,
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, import_react.default.createElement("path", { d: "M2 6.3 4.6 8.9 10 3.1" }));
}
function IconChevron({ open, size = 10 }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    // 收起时把「向下」的箭头转成「向右」：比画两个图标便宜，也不会因为尺寸不同而跳一下
    style: { flex: "none", transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s ease" }
  }, import_react.default.createElement("path", { d: "m3.4 5.2 3.6 3.6 3.6-3.6" }));
}
function IconTrash({ size = 13 }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, [
    import_react.default.createElement("path", { key: "a", d: "M2.8 4.4h10.4" }),
    import_react.default.createElement("path", { key: "b", d: "M6.4 4.4V2.9h3.2v1.5" }),
    import_react.default.createElement("path", { key: "c", d: "M4.5 4.4l.7 8.4h5.6l.7-8.4" }),
    import_react.default.createElement("path", { key: "d", d: "M6.9 6.8v3.9M9.1 6.8v3.9" })
  ]);
}
function IconClose({ size = 11 }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round"
  }, [
    import_react.default.createElement("path", { key: "a", d: "M3 3l6 6" }),
    import_react.default.createElement("path", { key: "b", d: "M9 3l-6 6" })
  ]);
}
function IconRefresh({ size = 12 }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, [
    import_react.default.createElement("path", { key: "a", d: "M2.6 8a5.4 5.4 0 0 1 9.1-3.9" }),
    import_react.default.createElement("path", { key: "b", d: "M13.4 8a5.4 5.4 0 0 1-9.1 3.9" }),
    import_react.default.createElement("path", { key: "c", d: "M12.3 1.9v2.6H9.7" }),
    import_react.default.createElement("path", { key: "d", d: "M3.7 14.1v-2.6h2.6" })
  ]);
}
var GEAR_PATH = [
  "M6.1 2.44 L6.1 1.02 A6.05 6.05 0 0 1 7.9 1.02 L7.9 2.44 A4.65 4.65 0 0 1 9.59 3.14",
  "L10.59 2.13 A6.05 6.05 0 0 1 11.87 3.41 L10.86 4.41 A4.65 4.65 0 0 1 11.56 6.1",
  "L12.98 6.1 A6.05 6.05 0 0 1 12.98 7.9 L11.56 7.9 A4.65 4.65 0 0 1 10.86 9.59",
  "L11.87 10.59 A6.05 6.05 0 0 1 10.59 11.87 L9.59 10.86 A4.65 4.65 0 0 1 7.9 11.56",
  "L7.9 12.98 A6.05 6.05 0 0 1 6.1 12.98 L6.1 11.56 A4.65 4.65 0 0 1 4.41 10.86",
  "L3.41 11.87 A6.05 6.05 0 0 1 2.13 10.59 L3.14 9.59 A4.65 4.65 0 0 1 2.44 7.9",
  "L1.02 7.9 A6.05 6.05 0 0 1 1.02 6.1 L2.44 6.1 A4.65 4.65 0 0 1 3.14 4.41",
  "L2.13 3.41 A6.05 6.05 0 0 1 3.41 2.13 L4.41 3.14 A4.65 4.65 0 0 1 6.1 2.44 Z"
].join(" ");
function IconSettings({ size = 14 }) {
  return import_react.default.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  }, [
    import_react.default.createElement("path", { key: "gear", d: GEAR_PATH }),
    import_react.default.createElement("circle", { key: "hole", cx: 7, cy: 7, r: 1.7 })
  ]);
}
function localToday() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
var asArray = (value) => Array.isArray(value) ? value : [];
async function postJson(path, body) {
  const response = await fetch(`${ROUTE_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    body: JSON.stringify(body ?? {})
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.error ?? detail?.reason ?? `HTTP ${response.status}`);
    if (detail?.reason) error.reason = detail.reason;
    throw error;
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON");
  if (!parsed.ok) {
    const error = new Error(parsed.error ?? parsed.reason ?? "\u672A\u77E5\u9519\u8BEF");
    if (parsed.reason) error.reason = parsed.reason;
    throw error;
  }
  return parsed.data ?? {};
}
async function fetchUpdateRun() {
  const response = await fetch(`${ROUTE_BASE}/update`, { cache: "no-store", credentials: "same-origin" });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok) {
    throw new Error(parsed?.error ?? parsed?.reason ?? `HTTP ${response.status}`);
  }
  return parsed.data ?? null;
}
var lastListByShapes = /* @__PURE__ */ new Map();
var lastSort = "manual";
function useList(sort, shapes) {
  const [state, setState] = import_react.default.useState(() => {
    const cached = lastListByShapes.get(shapes);
    return cached ? { status: "ready", data: cached, error: null } : { status: "loading", data: null, error: null };
  });
  const [tick, setTick] = import_react.default.useState(0);
  import_react.default.useEffect(() => {
    let alive = true;
    fetch(`${ROUTE_LIST}?filter=all&sort=${encodeURIComponent(sort || "manual")}&shapes=${encodeURIComponent(shapes)}`, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.error ?? body?.reason ?? "\u672A\u77E5\u9519\u8BEF");
      lastListByShapes.set(shapes, body.data);
      if (alive) setState({ status: "ready", data: body.data, error: null });
    }).catch((error) => {
      if (alive) {
        setState((prev) => ({
          ...prev,
          status: prev.data ? "ready" : "failed",
          error: String(error?.message ?? error)
        }));
      }
    });
    return () => {
      alive = false;
    };
  }, [tick, sort, shapes]);
  const refresh = import_react.default.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}
function createCelebrationRefresh(refresh, timers = {}) {
  const setTimer = typeof timers.setTimeout === "function" ? timers.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof timers.clearTimeout === "function" ? timers.clearTimeout : (handle) => clearTimeout(handle);
  let timer = null;
  const cancel = () => {
    if (timer === null) return false;
    try {
      clearTimer(timer);
    } catch {
    }
    timer = null;
    return true;
  };
  const schedule = (ms = CELEBRATE_REFRESH_MS) => {
    cancel();
    const delay = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : CELEBRATE_REFRESH_MS;
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delay);
    timer?.unref?.();
    return timer;
  };
  return { schedule, cancel, isPending: () => timer !== null };
}
function IconFlag({ filled, dashed }) {
  return import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", "aria-hidden": "true" }, [
    import_react.default.createElement("path", {
      key: "pole",
      d: "M3.6 1.6v13",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      fill: "none",
      strokeDasharray: dashed ? "1.5 1.5" : void 0
    }),
    import_react.default.createElement("path", {
      key: "cloth",
      d: "M5.2 2.4h7.4L11 5.2l1.6 2.8H5.2z",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinejoin: "round",
      strokeDasharray: dashed ? "1.5 1.5" : void 0
    })
  ]);
}
function priorityFlagOptions(t) {
  return [
    { value: "none", label: t("prioNone"), color: C.label3, dashed: true },
    { value: "high", label: t("prioHigh"), color: C.error },
    { value: "normal", label: t("prioNormal"), color: C.warn },
    { value: "low", label: t("prioLow"), color: C.label3 }
  ];
}
function priorityColor(value) {
  if (value === "high") return C.error;
  if (value === "normal") return C.warn;
  return C.label3;
}
function PriorityFlagsPopover({ t, value, onPick, onClose }) {
  return import_react.default.createElement("div", {
    role: "group",
    "aria-label": t("priorityLabel"),
    "data-wt-priority-pop": "true",
    // Esc 关闭：挂在弹层上，焦点在任意一个旗子按钮上按 Esc 都能关
    onKeyDown: (event) => {
      if (event?.key === "Escape") onClose?.();
    },
    style: {
      position: "absolute",
      top: "100%",
      left: 0,
      zIndex: 5,
      marginTop: 4,
      padding: 6,
      display: "flex",
      gap: 4,
      background: C.layer1,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      boxShadow: "0 8px 24px rgba(0,0,0,.12)"
    }
  }, priorityFlagOptions(t).map((flag) => import_react.default.createElement("button", {
    key: flag.value,
    type: "button",
    className: "wt-chip",
    "data-wt-priority": flag.value,
    "aria-pressed": value === flag.value,
    style: {
      color: flag.color,
      font: "inherit",
      fontSize: 11.5,
      cursor: "pointer",
      borderColor: value === flag.value ? flag.color : void 0
    },
    title: flag.label,
    onClick: () => onPick?.(flag.value)
  }, [
    import_react.default.createElement(IconFlag, { key: "f", filled: value === flag.value, dashed: flag.value === "none" }),
    import_react.default.createElement("span", { key: "v" }, flag.label)
  ])));
}
function prefersReducedMotion(win = typeof window !== "undefined" ? window : void 0) {
  try {
    return Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}
var IconCal = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("rect", { key: "r", x: 2.2, y: 3.4, width: 11.6, height: 10.4, rx: 2 }),
  import_react.default.createElement("path", { key: "p", d: "M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4" })
]);
var IconClock = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("circle", { key: "c", cx: 8, cy: 8, r: 5.8 }),
  import_react.default.createElement("path", { key: "p", d: "M8 4.9V8l2.2 1.4" })
]);
var IconFolder = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("path", { key: "f", d: "M1.8 4.4a1.4 1.4 0 0 1 1.4-1.4h2.6l1.4 1.7h5a1.4 1.4 0 0 1 1.4 1.4v5.5a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z" })
]);
var IconPencil = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("path", { key: "p", d: "M10.4 2.8 13.2 5.6 5.8 13H3v-2.8z" }),
  import_react.default.createElement("path", { key: "l", d: "M8.9 4.3 11.7 7.1" })
]);
function matchExistingProject(options, input) {
  const name = String(input ?? "").trim();
  if (!name) return null;
  const key = name.toLowerCase();
  const found = asArray(options).find((option) => typeof option === "string" && option.trim().toLowerCase() === key);
  return found ? found.trim() : null;
}
function ProjectPopover({ t, value, options, truncated, onPick, onClose }) {
  const [draft, setDraft] = import_react.default.useState("");
  const names = asArray(options).map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean);
  const create = () => {
    const name = String(draft ?? "").trim();
    if (!name) return;
    onPick?.(matchExistingProject(names, name) ?? name);
  };
  const closeOnEscape = (event) => {
    if (event?.key === "Escape") {
      event.preventDefault?.();
      onClose?.();
    }
  };
  return import_react.default.createElement("div", {
    role: "group",
    className: "wt-project-pop",
    "aria-label": t("projectLabel"),
    "data-wt-project-pop": "true",
    onKeyDown: closeOnEscape
  }, [
    ...names.map((name) => import_react.default.createElement("button", {
      key: `p:${name}`,
      type: "button",
      className: "wt-chip",
      "data-wt-project": name,
      title: name,
      "aria-pressed": value === name,
      style: {
        color: value === name ? C.label : C.label2,
        font: "inherit",
        fontSize: 11.5,
        cursor: "pointer",
        justifyContent: "flex-start",
        borderColor: value === name ? C.brand : void 0
      },
      onClick: () => onPick?.(name)
    }, import_react.default.createElement("span", { key: "v" }, name))),
    // 未归类：一键清除（等价 project = null）
    import_react.default.createElement("button", {
      key: "none",
      type: "button",
      className: "wt-chip",
      "data-wt-project-clear": "true",
      title: t("noProject"),
      "aria-pressed": value === null,
      style: {
        color: value === null ? C.label : C.label3,
        font: "inherit",
        fontSize: 11.5,
        cursor: "pointer",
        justifyContent: "flex-start",
        borderColor: value === null ? C.brand : void 0
      },
      onClick: () => onPick?.(null)
    }, import_react.default.createElement("span", { key: "v" }, t("noProject"))),
    // 新建：文本输入 + 「新建」（回车即新建）
    import_react.default.createElement("div", {
      key: "new",
      style: { display: "flex", alignItems: "center", gap: 4, marginTop: 2 }
    }, [
      import_react.default.createElement("input", {
        key: "in",
        className: "wt-input",
        value: draft,
        placeholder: t("projectNewPlaceholder"),
        "aria-label": t("projectNewPlaceholder"),
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") create();
          else if (event.key === "Escape") closeOnEscape(event);
        },
        style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5 }
      }),
      import_react.default.createElement("button", {
        key: "go",
        type: "button",
        className: "wt-btn",
        "data-wt-project-create": "true",
        title: t("projectNew"),
        onClick: create
      }, t("projectNew"))
    ]),
    truncated ? import_react.default.createElement("div", {
      key: "more",
      style: { fontSize: 10.5, color: C.label3 }
    }, fillTemplate(t("projectListTruncated"), { count: names.length })) : null
  ]);
}
function QuickAdd({ t, onAdd, busy, projects, projectsTruncated }) {
  const [title, setTitle] = import_react.default.useState("");
  const [due, setDue] = import_react.default.useState("");
  const [dueTime, setDueTime] = import_react.default.useState("");
  const [priority, setPriority] = import_react.default.useState("none");
  const [project, setProject] = import_react.default.useState(null);
  const [parsed, setParsed] = import_react.default.useState(null);
  const [manual, setManual] = import_react.default.useState(false);
  const [flagOpen, setFlagOpen] = import_react.default.useState(false);
  const [projectOpen, setProjectOpen] = import_react.default.useState(false);
  const dateRef = import_react.default.useRef(null);
  const timeRef = import_react.default.useRef(null);
  const openPicker = (ref) => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
      }
    }
    el.focus();
    try {
      el.click();
    } catch {
    }
  };
  import_react.default.useEffect(() => {
    if (manual) return void 0;
    const text = title;
    if (!text || !text.trim()) {
      setParsed(null);
      return void 0;
    }
    const timer = setTimeout(() => {
      const result = parseNaturalDue(text, Date.now());
      if (result.matched.length) {
        setParsed(result);
        setDue(result.due ?? "");
        setDueTime(result.dueTime ?? "");
      } else {
        setParsed(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [title, manual]);
  const submit = () => {
    if (busy) return;
    let payloadTitle = title;
    if (!manual) {
      const result = parseNaturalDue(title, Date.now());
      if (result.matched.length) payloadTitle = result.title;
    }
    Promise.resolve(onAdd({
      title: payloadTitle,
      due: due || null,
      dueTime: dueTime || null,
      priority,
      // 空值显式给 null（不是 undefined）：宿主对请求体做「无损 JSON」校验，
      // undefined 会被当成缺键，甚至让整次调用被拒（与 due/dueTime 同一条约定）。
      project: project ?? null
    })).then((ok) => {
      if (ok !== false) {
        setTitle("");
        setParsed(null);
        setManual(false);
        setFlagOpen(false);
        setProjectOpen(false);
      }
    }).catch(() => {
    });
  };
  const today = dayKey2(Date.now());
  const dateLabel = due ? due === today ? t("todayWord") : `${due.slice(5).replace("-", "-")}` : t("dateUnset");
  const timeLabel = dueTime || t("timeUnset");
  const prioLabel = priority === "high" ? t("prioHigh") : priority === "normal" ? t("prioNormal") : priority === "low" ? t("prioLow") : t("prioNone");
  const prioColor = priorityColor(priority);
  const setDate = (value) => {
    setManual(true);
    setDue(value);
    if (!value) setDueTime("");
    setFlagOpen(false);
  };
  const setTime = (value) => {
    setManual(true);
    if (value && !due) setDue(dayKey2(Date.now()));
    setDueTime(value);
  };
  const projectOptions = asArray(projects).map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean);
  const closeProjectOnEscape = (event) => {
    if (event?.key === "Escape") setProjectOpen(false);
  };
  return import_react.default.createElement("div", { key: "qa", style: { marginBottom: 12 } }, [
    // ---- 第一行：内容 + 添加 ----
    import_react.default.createElement("div", { key: "l1", style: { display: "flex", alignItems: "center", gap: 8 } }, [
      import_react.default.createElement("input", {
        key: "ti",
        className: "wt-input",
        style: { flex: "1 1 auto", fontSize: 13, padding: "7px 10px" },
        value: title,
        placeholder: t("addPlaceholder"),
        "aria-label": t("addPlaceholder"),
        onChange: (event) => {
          const next = event.target.value;
          setTitle(next);
          if (!next.trim()) {
            setManual(false);
            setParsed(null);
          }
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") submit();
        }
      }),
      import_react.default.createElement("button", {
        key: "add",
        type: "button",
        className: "wt-btn wt-btn-primary",
        disabled: Boolean(busy),
        onClick: submit
      }, t("add"))
    ]),
    // ---- 第二行（更小）：日期 / 时间 / 优先级 / 项目 ----
    import_react.default.createElement("div", { key: "l2", style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8, fontSize: 11.5, flexWrap: "wrap" } }, [
      // 日期：label 里套一个透明的原生 date 输入，点它即弹系统日历
      import_react.default.createElement("label", {
        key: "due",
        className: `wt-chip${parsed && parsed.due ? " is-parsed" : ""}`,
        "data-wt-field": "due",
        title: t("dueLabel"),
        onClick: (event) => {
          event.preventDefault();
          openPicker(dateRef);
        },
        style: { position: "relative", cursor: "pointer", color: due ? C.label : C.label3, borderColor: parsed && parsed.due ? C.brand : void 0 }
      }, [
        import_react.default.createElement(IconCal, { key: "i" }),
        import_react.default.createElement("span", { key: "v" }, due ? `${today === due ? t("todayWord") : due}${parsed && parsed.due ? ` \xB7 ${t("fromParsed")}` : ""}` : t("dateUnset")),
        import_react.default.createElement("input", {
          key: "in",
          ref: dateRef,
          type: "date",
          value: due,
          "aria-label": t("dueLabel"),
          style: { position: "absolute", inset: 0, opacity: 0, border: 0, padding: 0, width: "100%", height: "100%", cursor: "pointer" },
          onChange: (event) => setDate(event.target.value)
        })
      ]),
      // 时间：同样用原生 time 输入；只选时间时自动补今天
      import_react.default.createElement("label", {
        key: "time",
        className: `wt-chip${parsed && parsed.dueTime ? " is-parsed" : ""}`,
        "data-wt-field": "time",
        title: t("dueTimeLabel"),
        onClick: (event) => {
          event.preventDefault();
          openPicker(timeRef);
        },
        style: { position: "relative", cursor: "pointer", color: dueTime ? C.label : C.label3, borderColor: parsed && parsed.dueTime ? C.brand : void 0 }
      }, [
        import_react.default.createElement(IconClock, { key: "i" }),
        import_react.default.createElement("span", { key: "v" }, `${timeLabel}${parsed && parsed.dueTime ? ` \xB7 ${t("fromParsed")}` : ""}`),
        import_react.default.createElement("input", {
          key: "in",
          ref: timeRef,
          type: "time",
          value: dueTime,
          lang: "zh-CN",
          "aria-label": t("dueTimeLabel"),
          style: { position: "absolute", inset: 0, opacity: 0, border: 0, padding: 0, width: "100%", height: "100%", cursor: "pointer" },
          onChange: (event) => setTime(event.target.value)
        })
      ]),
      // 优先级：点开四个小旗（弹层与行内旗子按钮共用 PriorityFlagsPopover，见上）
      import_react.default.createElement("span", { key: "prio", style: { position: "relative" } }, [
        import_react.default.createElement("button", {
          key: "btn",
          type: "button",
          className: "wt-chip",
          "data-wt-field": "priority",
          style: { color: prioColor, cursor: "pointer", font: "inherit", fontSize: 11.5 },
          title: t("priorityLabel"),
          "aria-label": t("priorityLabel"),
          "aria-expanded": flagOpen,
          onClick: () => setFlagOpen((open) => !open),
          onKeyDown: (event) => {
            if (event?.key === "Escape") setFlagOpen(false);
          }
        }, [
          import_react.default.createElement(IconFlag, { key: "f", dashed: priority === "none", filled: priority !== "none" }),
          import_react.default.createElement("span", { key: "v" }, `${t("priorityLabel")} \xB7 ${prioLabel}`)
        ]),
        flagOpen ? import_react.default.createElement(PriorityFlagsPopover, {
          key: "pop",
          t,
          value: priority,
          onPick: (value) => {
            setPriority(value);
            setFlagOpen(false);
          },
          onClose: () => setFlagOpen(false)
        }) : null
      ]),
      // 项目：**排在优先级之后**（顺序：日期 → 时间 → 优先级 → 项目）。
      // 点开一个与优先级同风格的小弹层：已有项目（点选）→ 新建（输入 + 新建）→ 未归类（清除）。
      import_react.default.createElement("span", { key: "project", style: { position: "relative" } }, [
        import_react.default.createElement("button", {
          key: "btn",
          type: "button",
          className: "wt-chip",
          "data-wt-field": "project",
          style: { color: project ? C.label : C.label3, cursor: "pointer", font: "inherit", fontSize: 11.5 },
          title: t("projectLabel"),
          "aria-label": t("projectLabel"),
          "aria-expanded": projectOpen,
          "aria-haspopup": "true",
          onClick: () => setProjectOpen((open) => !open),
          onKeyDown: closeProjectOnEscape
        }, [
          import_react.default.createElement(IconFolder, { key: "i" }),
          import_react.default.createElement("span", { key: "v" }, project ? project : `${t("projectLabel")} \xB7 ${t("noProject")}`)
        ]),
        projectOpen ? import_react.default.createElement(ProjectPopover, {
          key: "pop",
          t,
          value: project,
          options: projectOptions,
          truncated: projectsTruncated,
          onPick: (name) => {
            setProject(name);
            setProjectOpen(false);
          },
          onClose: () => setProjectOpen(false)
        }) : null
      ])
    ])
  ]);
}
var TodoRow = import_react.default.memo(function TodoRow2({ todo, today, t, onToggle, onRemove, onSave, onPriority, onDue, onTitle, onProject, projects, projectsTruncated, celebrate, drag, dragging }) {
  const [editing, setEditing] = import_react.default.useState(false);
  const [draft, setDraft] = import_react.default.useState(null);
  const [notesOpen, setNotesOpen] = import_react.default.useState(false);
  const [confirming, setConfirming] = import_react.default.useState(false);
  const [flagOpen, setFlagOpen] = import_react.default.useState(false);
  const [flagPeek, setFlagPeek] = import_react.default.useState(false);
  const [dateOpen, setDateOpen] = import_react.default.useState(false);
  const [datePeek, setDatePeek] = import_react.default.useState(false);
  const [datePlacement, setDatePlacement] = import_react.default.useState("down");
  const [dateOverride, setDateOverride] = import_react.default.useState(null);
  const [dateOverrideFor, setDateOverrideFor] = import_react.default.useState(null);
  const [dateError, setDateError] = import_react.default.useState(null);
  const dateWrapRef = import_react.default.useRef(null);
  const [celebrating, setCelebrating] = import_react.default.useState(false);
  const [optimisticDone, setOptimisticDone] = import_react.default.useState(null);
  const [optimisticFor, setOptimisticFor] = import_react.default.useState(null);
  const [titleEditing, setTitleEditing] = import_react.default.useState(false);
  const [titleDraft, setTitleDraft] = import_react.default.useState("");
  const [titleOverride, setTitleOverride] = import_react.default.useState(null);
  const [titleOverrideFor, setTitleOverrideFor] = import_react.default.useState(null);
  const [titleError, setTitleError] = import_react.default.useState(null);
  const titleCommittedRef = import_react.default.useRef(false);
  const [projectOpen, setProjectOpen] = import_react.default.useState(false);
  const [projectPeek, setProjectPeek] = import_react.default.useState(false);
  const [projectOverride, setProjectOverride] = import_react.default.useState(void 0);
  const [projectOverrideFor, setProjectOverrideFor] = import_react.default.useState(null);
  const [projectError, setProjectError] = import_react.default.useState(null);
  const projectWrapRef = import_react.default.useRef(null);
  import_react.default.useEffect(() => {
    if (!confirming) return void 0;
    const id = setTimeout(() => setConfirming(false), 5e3);
    return () => clearTimeout(id);
  }, [confirming]);
  const row = todo ?? {};
  const optimisticActive = optimisticDone !== null && optimisticFor === todo;
  const done = (optimisticActive ? optimisticDone : null) ?? row.status === "completed";
  const due = typeof row.due === "string" ? row.due : "";
  const dueTime = typeof row.dueTime === "string" ? row.dueTime : "";
  const dateOverrideActive = dateOverride !== null && dateOverrideFor === todo;
  const shownDue = dateOverrideActive ? dateOverride.due ?? "" : due;
  const shownDueTime = dateOverrideActive ? dateOverride.dueTime ?? "" : dueTime;
  const overdue = !done && Boolean(shownDue) && Boolean(today) && shownDue < today;
  const baseTitle = typeof row.title === "string" ? row.title : "";
  const titleOverrideActive = titleOverride !== null && titleOverrideFor === todo;
  const shownTitle = titleOverrideActive ? titleOverride : baseTitle;
  const baseProject = typeof row.project === "string" && row.project ? row.project : null;
  const projectOverrideActive = projectOverride !== void 0 && projectOverrideFor === todo;
  const shownProject = projectOverrideActive ? projectOverride : baseProject;
  const openDate = () => {
    const el = dateWrapRef.current;
    let rect = null;
    try {
      rect = el?.getBoundingClientRect?.() ?? null;
    } catch {
      rect = null;
    }
    const viewportHeight = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
    setDatePlacement(chooseDatePopoverPlacement(rect, viewportHeight));
    setDateError(null);
    setDateOpen(true);
  };
  const closeDate = () => setDateOpen(false);
  const commitDate = (patch, local) => {
    setDateOverride(local);
    setDateOverrideFor(todo);
    setDateError(null);
    const fail = () => {
      setDateOverride(null);
      setDateOverrideFor(null);
      setDateError(t("dateSaveFailed"));
    };
    Promise.resolve(onDue?.(row.id, patch)).then(
      (result) => {
        if (result && result.ok === false) fail();
      },
      fail
    );
  };
  const changeDate = (value) => {
    if (!value) {
      commitDate({ due: null }, { due: "", dueTime: "" });
      return;
    }
    commitDate({ due: value }, { due: value, dueTime: shownDueTime });
  };
  const changeTime = (value) => {
    const nextTime = value || "";
    commitDate({ due: shownDue, dueTime: nextTime || null }, { due: shownDue, dueTime: nextTime });
  };
  const startTitleEdit = () => {
    titleCommittedRef.current = false;
    setTitleDraft(shownTitle);
    setTitleError(null);
    setTitleEditing(true);
  };
  const commitTitle = () => {
    if (titleCommittedRef.current) return;
    titleCommittedRef.current = true;
    const next = String(titleDraft ?? "").trim();
    setTitleEditing(false);
    setTitleDraft("");
    if (!next) {
      setTitleError(t("titleEmptyHint"));
      return;
    }
    if (next === baseTitle) {
      setTitleError(null);
      return;
    }
    setTitleOverride(next);
    setTitleOverrideFor(todo);
    setTitleError(null);
    const fail = () => {
      setTitleOverride(null);
      setTitleOverrideFor(null);
      setTitleError(t("titleSaveFailed"));
    };
    Promise.resolve(onTitle?.(row.id, next)).then(
      (result) => {
        if (result && result.ok === false) fail();
      },
      fail
    );
  };
  const cancelTitle = () => {
    titleCommittedRef.current = true;
    setTitleEditing(false);
    setTitleDraft("");
  };
  const projectOptions = asArray(projects).map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean);
  const openProject = () => {
    setProjectError(null);
    setProjectOpen(true);
  };
  const commitProject = (next) => {
    setProjectOpen(false);
    const value = next === null || next === void 0 ? null : String(next).trim() || null;
    if (value === baseProject) return;
    setProjectOverride(value);
    setProjectOverrideFor(todo);
    setProjectError(null);
    const fail = () => {
      setProjectOverride(void 0);
      setProjectOverrideFor(null);
      setProjectError(t("projectSaveFailed"));
    };
    Promise.resolve(onProject?.(row.id, value)).then(
      (result) => {
        if (result && result.ok === false) fail();
      },
      fail
    );
  };
  import_react.default.useEffect(() => {
    if (!projectOpen) return void 0;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
    const onPointerDown = (event) => {
      const wrap = projectWrapRef.current;
      if (wrap && typeof wrap.contains === "function" && event?.target && wrap.contains(event.target)) return;
      setProjectOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [projectOpen]);
  import_react.default.useEffect(() => {
    if (!dateOpen) return void 0;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return void 0;
    const onPointerDown = (event) => {
      const wrap = dateWrapRef.current;
      if (wrap && typeof wrap.contains === "function" && event?.target && wrap.contains(event.target)) return;
      setDateOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [dateOpen]);
  const flagValue = EDIT_PRIORITY_OPTIONS.includes(row.priority) ? row.priority : "none";
  const flagLabel = t(PRIORITY_LABEL_KEYS[flagValue]);
  const flagVisible = flagValue !== "none" || flagPeek || flagOpen;
  const flagOpacity = !flagVisible ? 0 : flagValue === "none" && !flagOpen ? 0.55 : 1;
  const beginEdit = () => {
    setDraft(buildEditDraft(row));
    setNotesOpen(Boolean(row.notes));
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setDraft(null);
  };
  const handleCheck = () => {
    const willComplete = !done;
    const canCelebrate = willComplete && celebrate !== false && !prefersReducedMotion();
    if (canCelebrate) {
      setOptimisticDone(true);
      setOptimisticFor(todo);
      setCelebrating(true);
    } else if (done) {
      setOptimisticDone(null);
      setOptimisticFor(null);
      setCelebrating(false);
    }
    const job = Promise.resolve(onToggle(row.id, { celebrate: canCelebrate }));
    job.then(
      (result) => {
        if (result && result.ok === false) {
          setOptimisticDone(null);
          setOptimisticFor(null);
          setCelebrating(false);
        }
      },
      () => {
        setOptimisticDone(null);
        setOptimisticFor(null);
        setCelebrating(false);
      }
    );
  };
  const submit = () => {
    if (!draft) return;
    const patch = {};
    const title = String(draft.title ?? "").trim();
    if (title !== (row.title ?? "")) patch.title = title;
    const nextDue = draft.due || "";
    if (nextDue !== due) {
      patch.due = nextDue;
      if (!nextDue) patch.dueTime = "none";
    }
    const nextDueTime = String(draft.dueTime ?? "").trim();
    if (nextDue && nextDueTime !== (row.dueTime ?? "")) patch.dueTime = nextDueTime === "" ? "none" : nextDueTime;
    const priority = draft.priority || row.priority || "none";
    if (priority !== (row.priority ?? "none")) patch.priority = priority;
    const project = String(draft.project ?? "").trim();
    if (project !== (row.project ?? "")) patch.project = project;
    const notes = String(draft.notes ?? "").trim();
    if (notes !== (row.notes ?? "")) patch.notes = notes;
    stopEdit();
    if (!Object.keys(patch).length) return;
    Promise.resolve(onSave(row.id, patch)).catch(() => {
    });
  };
  const inputStyle = { fontSize: 12, padding: "3px 7px" };
  if (editing && draft) {
    const field = (key, label, control) => import_react.default.createElement("label", {
      key,
      style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: C.label3 }
    }, [label, control]);
    return import_react.default.createElement("div", { className: "wt-row wt-row-edit" }, [
      import_react.default.createElement("div", { key: "top", style: { display: "flex", gap: 6, alignItems: "center" } }, [
        import_react.default.createElement("input", {
          key: "ti",
          className: "wt-input",
          style: { ...inputStyle, flex: 1, minWidth: 0 },
          value: draft.title,
          autoFocus: true,
          placeholder: t("titlePlaceholder"),
          "aria-label": t("titlePlaceholder"),
          onChange: (event) => setDraft((prev) => ({ ...prev, title: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") stopEdit();
          }
        }),
        import_react.default.createElement("button", {
          key: "save",
          type: "button",
          className: "wt-btn wt-btn-primary",
          onClick: submit
        }, t("save")),
        import_react.default.createElement("button", {
          key: "cancel",
          type: "button",
          className: "wt-btn",
          onClick: stopEdit
        }, t("cancel"))
      ]),
      import_react.default.createElement("div", {
        key: "fields",
        style: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }
      }, [
        field("due", t("dueLabel"), import_react.default.createElement("input", {
          className: "wt-input",
          style: inputStyle,
          type: "date",
          value: draft.due,
          "aria-label": t("dueLabel"),
          onChange: (event) => setDraft((prev) => ({ ...prev, due: event.target.value }))
        })),
        field("tm", t("dueTimeLabel"), import_react.default.createElement("input", {
          className: "wt-input",
          style: inputStyle,
          type: "time",
          value: draft.dueTime,
          disabled: !draft.due,
          "aria-label": t("dueTimeLabel"),
          onChange: (event) => setDraft((prev) => ({ ...prev, dueTime: event.target.value }))
        })),
        field("prio", t("priorityLabel"), import_react.default.createElement("select", {
          className: "wt-input",
          style: inputStyle,
          value: draft.priority,
          "aria-label": t("priorityLabel"),
          onChange: (event) => setDraft((prev) => ({ ...prev, priority: event.target.value }))
        }, EDIT_PRIORITY_OPTIONS.map((value) => import_react.default.createElement(
          "option",
          { key: value, value },
          t(PRIORITY_LABEL_KEYS[value])
        )))),
        field("project", t("projectLabel"), import_react.default.createElement("input", {
          className: "wt-input",
          style: { ...inputStyle, width: 130 },
          value: draft.project,
          placeholder: t("projectPlaceholder"),
          "aria-label": t("projectPlaceholder"),
          onChange: (event) => setDraft((prev) => ({ ...prev, project: event.target.value }))
        }))
      ]),
      import_react.default.createElement("div", { key: "notes" }, [
        notesOpen ? import_react.default.createElement("div", { key: "box", style: { display: "flex", flexDirection: "column", gap: 4 } }, [
          import_react.default.createElement("textarea", {
            key: "ta",
            className: "wt-input",
            style: { width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 54 },
            rows: 3,
            value: draft.notes,
            placeholder: t("notesPlaceholder"),
            "aria-label": t("notesLabel"),
            onChange: (event) => setDraft((prev) => ({ ...prev, notes: event.target.value })),
            // textarea 里回车要换行，所以保存用 Ctrl/Cmd+Enter
            onKeyDown: (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
              if (event.key === "Escape") stopEdit();
            }
          }),
          import_react.default.createElement("span", {
            key: "hide",
            className: "wt-link",
            onClick: () => setNotesOpen(false)
          }, t("notesHide"))
        ]) : import_react.default.createElement("span", {
          key: "add",
          className: "wt-link",
          onClick: () => setNotesOpen(true)
        }, t("notesAdd"))
      ])
    ]);
  }
  const meta = [];
  if (row.priority === "high") {
    meta.push(import_react.default.createElement("span", {
      key: "p",
      className: "wt-tag",
      style: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12), fontWeight: 600 }
    }, t("prioHigh")));
  } else if (row.priority === "low") {
    meta.push(import_react.default.createElement("span", { key: "p", className: "wt-tag" }, t("prioLow")));
  }
  const dateText = shownDue ? `${overdue ? `${t("overdueTag")} ` : ""}${shownDue}${shownDueTime ? ` ${shownDueTime}` : ""}` : "";
  const hasTimeField = Boolean(dueTime || shownDueTime);
  const dateNode = import_react.default.createElement("span", {
    key: "d",
    ref: dateWrapRef,
    style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }
  }, [
    import_react.default.createElement("button", {
      key: "btn",
      type: "button",
      className: `wt-date-btn${shownDue ? "" : " is-add"}`,
      ...shownDue ? { "data-wt-date-btn": "true" } : { "data-wt-date-add": "true" },
      "aria-label": shownDue ? t("editDate") : t("addDateLabel"),
      "aria-haspopup": "dialog",
      "aria-expanded": dateOpen,
      title: shownDue ? t("editDate") : t("addDateLabel"),
      // 视觉与旧文案一致（11px 小字）；逾期仍用 warn 色
      style: { color: overdue ? C.warn : C.label3 },
      onClick: openDate,
      onKeyDown: (event) => {
        if (event?.key === "Escape") closeDate();
      }
    }, shownDue ? dateText : t("addDate")),
    dateOpen ? import_react.default.createElement("div", {
      key: "pop",
      className: `wt-date-pop is-${datePlacement}`,
      role: "dialog",
      "aria-label": t("datePopover"),
      "data-wt-date-pop": "true",
      onKeyDown: (event) => {
        if (event?.key === "Escape") {
          event.preventDefault?.();
          closeDate();
        }
      }
    }, [
      import_react.default.createElement("label", { key: "d", className: "wt-date-field" }, [
        import_react.default.createElement("span", { key: "l" }, t("dueLabel")),
        import_react.default.createElement("input", {
          key: "in",
          className: "wt-input",
          type: "date",
          value: shownDue,
          autoFocus: true,
          "aria-label": t("dueLabel"),
          onChange: (event) => changeDate(String(event?.target?.value ?? ""))
        })
      ]),
      hasTimeField ? import_react.default.createElement("label", { key: "t", className: "wt-date-field" }, [
        import_react.default.createElement("span", { key: "l" }, t("dueTimeLabel")),
        import_react.default.createElement("input", {
          key: "in",
          className: "wt-input",
          type: "time",
          value: shownDueTime,
          "aria-label": t("dueTimeLabel"),
          onChange: (event) => changeTime(String(event?.target?.value ?? ""))
        })
      ]) : null,
      import_react.default.createElement("div", { key: "f", className: "wt-date-pop-foot" }, [
        shownDue ? import_react.default.createElement("button", {
          key: "clear",
          type: "button",
          className: "wt-btn",
          "data-wt-date-clear": "true",
          onClick: () => changeDate("")
        }, t("clearDate")) : null,
        import_react.default.createElement("span", { key: "sp", style: { flex: 1 } }),
        import_react.default.createElement("button", {
          key: "done",
          type: "button",
          className: "wt-btn",
          "data-wt-date-done": "true",
          onClick: closeDate
        }, t("dismiss"))
      ])
    ]) : null
  ]);
  if (shownDue || datePeek || dateOpen || dateError) meta.push(dateNode);
  if (dateError) {
    meta.push(import_react.default.createElement("span", {
      key: "de",
      className: "wt-date-error",
      role: "status"
    }, dateError));
  }
  const projectNode = import_react.default.createElement("span", {
    key: "j",
    ref: projectWrapRef,
    style: { position: "relative", display: "inline-flex", alignItems: "center" }
  }, [
    import_react.default.createElement("button", {
      key: "btn",
      type: "button",
      className: `wt-tag wt-project-btn${shownProject ? "" : " is-add"}`,
      ...shownProject ? { "data-wt-project-btn": "true" } : { "data-wt-project-add": "true" },
      "aria-label": shownProject ? t("editProject") : t("addProjectLabel"),
      "aria-haspopup": "true",
      "aria-expanded": projectOpen,
      title: shownProject ? t("editProject") : t("addProjectLabel"),
      onClick: openProject,
      onKeyDown: (event) => {
        if (event?.key === "Escape") setProjectOpen(false);
      }
    }, shownProject ? `#${shownProject}` : t("addProject")),
    projectOpen ? import_react.default.createElement(ProjectPopover, {
      key: "pop",
      t,
      value: shownProject,
      options: projectOptions,
      truncated: projectsTruncated,
      onPick: commitProject,
      onClose: () => setProjectOpen(false)
    }) : null
  ]);
  if (shownProject || projectPeek || projectOpen || projectError) meta.push(projectNode);
  if (projectError) {
    meta.push(import_react.default.createElement("span", {
      key: "je",
      className: "wt-project-error",
      role: "status"
    }, projectError));
  }
  if (row.source === "agent" || row.source === "session") {
    meta.push(import_react.default.createElement("span", {
      key: "s",
      className: "wt-tag",
      title: row.source === "agent" ? t("sourceAgent") : t("sourceSession")
    }, row.source === "agent" ? t("sourceAgent") : t("sourceSession")));
  }
  const dragAttrs = drag ? {
    draggable: true,
    onDragStart: (event) => {
      try {
        event.dataTransfer?.setData("text/plain", row.id ?? "");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      } catch {
      }
      drag.onStart?.(row.id);
    },
    onDragOver: (event) => {
      event.preventDefault();
      drag.onOver?.(row.id);
    },
    onDrop: (event) => {
      event.preventDefault();
      drag.onDrop?.(row.id);
    },
    onDragEnd: () => drag.onEnd?.(),
    title: drag.hint,
    style: dragging ? { opacity: 0.45 } : void 0
  } : {};
  const rowStyle = {
    ...dragging ? { opacity: 0.45 } : {},
    ...flagValue === "high" ? { borderLeft: `2px solid ${C.error}`, paddingLeft: 8 } : {}
  };
  return import_react.default.createElement("div", {
    className: `wt-row${celebrating ? " is-celebrating" : ""}`,
    // 状态可见性给测试与读屏：动效开着时 data-wt-celebrating="true"
    "data-wt-celebrating": celebrating ? "true" : void 0,
    "data-wt-row": row.id ?? "",
    "data-wt-row-priority": flagValue,
    // hover / focus 都让「无优先级」行的旗子、「无日期」行的＋日期、「无项目」行的＋项目淡出来。
    // focus 冒泡自子元素，纯键盘同样到达；日期/项目入口在「焦点仍在本行内」时不收起，
    // 否则刚从勾选框 Tab 到入口按钮，它会在被聚焦的瞬间消失。旗子保持原来的行为。
    onMouseEnter: () => {
      setFlagPeek(true);
      setDatePeek(true);
      setProjectPeek(true);
    },
    onMouseLeave: () => {
      setFlagPeek(false);
      setDatePeek(false);
      setProjectPeek(false);
    },
    onFocus: () => {
      setFlagPeek(true);
      setDatePeek(true);
      setProjectPeek(true);
    },
    onBlur: (event) => {
      setFlagPeek(false);
      const rowEl = event?.currentTarget;
      if (rowEl && event?.relatedTarget && typeof rowEl.contains === "function" && rowEl.contains(event.relatedTarget)) return;
      setDatePeek(false);
      setProjectPeek(false);
    },
    // 动效是纯 CSS 的：动画跑完自己摘掉类，不需要逐帧 setState；列表刷新的延后由面板负责。
    // B3：`animationend` 会**冒泡** —— 勾选框的呼吸（620ms）与对勾描边（140→660ms）结束也会冒到行上，
    // 旧写法在 320ms 就把 is-celebrating 摘掉，整行高亮被截断（视觉跳变）。
    // 只处理「事件源就是这一行自己」的那一次（并顺手校验 animationName，防止未来加新动画时误摘）。
    onAnimationEnd: (event) => {
      if (!event || !event.currentTarget || event.target !== event.currentTarget) return;
      if (typeof event.animationName === "string" && event.animationName && event.animationName !== "wt-row-celebrate") return;
      if (celebrating) setCelebrating(false);
    },
    ...dragAttrs,
    style: rowStyle
  }, [
    /* 优先级呈现（设计稿 v5）：高＝红色左缘 + 实心红旗；中＝琥珀；低＝灰；
       无＝默认不显（悬停/聚焦该行时淡出一个空心旗，可点）。旗子是按钮：点开四旗选择器。
       即「无」优先级的行也**始终渲染**这个按钮（占住那一列，各行左侧对齐稳定），
       只是 opacity:0 —— 因此 Tab 键依然能聚焦到它。 */
    import_react.default.createElement("span", {
      key: "prio-flag",
      style: { position: "relative", display: "inline-flex", flex: "0 0 auto" }
    }, [
      import_react.default.createElement("button", {
        key: "btn",
        type: "button",
        className: `wt-flag-btn${flagVisible ? "" : " is-ghost"}`,
        "data-wt-priority-btn": "true",
        "data-wt-ghost": flagVisible ? void 0 : "true",
        "aria-label": `${t("priorityLabel")}\uFF1A${flagLabel}`,
        "aria-expanded": flagOpen,
        "aria-haspopup": "true",
        title: `${t("priorityLabel")}\uFF1A${flagLabel}`,
        style: { color: priorityColor(flagValue), opacity: flagOpacity },
        onClick: () => setFlagOpen((open) => !open),
        onKeyDown: (event) => {
          if (event?.key === "Escape") setFlagOpen(false);
        }
      }, import_react.default.createElement(IconFlag, { filled: flagValue === "high", dashed: flagValue === "none" })),
      flagOpen ? import_react.default.createElement(PriorityFlagsPopover, {
        key: "pop",
        t,
        value: flagValue,
        // 选中即收弹层 + 走面板统一的写路径（POST /worktodo/update {ref, priority}）。
        // 失败由面板顶部的错误条原样显示；成功后按现有 refresh() 机制重取列表，不整页刷新。
        onPick: (value) => {
          setFlagOpen(false);
          Promise.resolve(onPriority?.(row.id, value)).catch(() => {
          });
        },
        onClose: () => setFlagOpen(false)
      }) : null
    ]),
    import_react.default.createElement("button", {
      key: "check",
      type: "button",
      className: `wt-check${done ? " wt-check-done" : ""}${celebrating ? " wt-check-celebrate" : ""}`,
      // 尺寸与可点区域：渲染出来的值与样式表取同一组常量（CHECK_SIZE_PX / CHECK_HIT_PX）
      "data-wt-check-size": CHECK_SIZE_PX,
      "data-wt-check-hit": CHECK_HIT_PX,
      "aria-label": done ? t("unmarkDone") : t("markDone"),
      title: done ? t("unmarkDone") : t("markDone"),
      onClick: handleCheck
    }, done ? import_react.default.createElement(IconCheck, { key: "i", className: "wt-check-mark" }) : null),
    import_react.default.createElement("div", { key: "main", style: { flex: 1, minWidth: 0 } }, [
      titleEditing ? import_react.default.createElement("input", {
        key: "title",
        className: "wt-title wt-title-input",
        "data-wt-title-input": "true",
        value: titleDraft,
        autoFocus: true,
        "aria-label": t("editTitle"),
        title: t("editTitle"),
        // 自动聚焦后全选：点一下就能直接重写；键盘 Tab 进来同样成立
        onFocus: (event) => {
          try {
            event?.target?.select?.();
          } catch {
          }
        },
        onChange: (event) => setTitleDraft(String(event?.target?.value ?? "")),
        onKeyDown: (event) => {
          if (event?.key === "Enter") {
            event.preventDefault?.();
            commitTitle();
          } else if (event?.key === "Escape") {
            event.preventDefault?.();
            cancelTitle();
          }
        },
        // 失焦 = 保存（用 ref 去重：Enter 已提交过就不会再发一次）
        onBlur: commitTitle,
        style: {
          color: done ? C.label3 : C.label,
          textDecoration: done ? "line-through" : "none",
          fontWeight: row.priority === "high" && !done ? 650 : 400
        }
      }) : import_react.default.createElement("button", {
        key: "title",
        type: "button",
        className: "wt-title wt-title-btn",
        "data-wt-title-btn": "true",
        "aria-label": t("editTitle"),
        title: t("editHint"),
        onClick: startTitleEdit,
        style: {
          color: done ? C.label3 : C.label,
          textDecoration: done ? "line-through" : "none",
          fontWeight: row.priority === "high" && !done ? 650 : 400
        }
      }, shownTitle || t("untitled")),
      titleError ? import_react.default.createElement("span", {
        key: "title-error",
        className: "wt-title-error",
        role: "status"
      }, titleError) : null,
      meta.length ? import_react.default.createElement("div", {
        key: "meta",
        style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }
      }, meta) : null
    ]),
    // 标题单击改成行内编辑之后，完整表单（备注 / 日期 / 优先级 / 项目）从这里进
    import_react.default.createElement("button", {
      key: "details",
      type: "button",
      className: "wt-icon-btn",
      "data-wt-edit-details": "true",
      title: t("editDetails"),
      "aria-label": t("editDetails"),
      onClick: beginEdit
    }, import_react.default.createElement(IconPencil, { key: "i" })),
    import_react.default.createElement("button", {
      key: "del",
      type: "button",
      className: confirming ? "wt-btn wt-btn-danger" : "wt-icon-btn wt-icon-btn-danger",
      title: confirming ? t("confirmDelete") : t("deleteBtn"),
      "aria-label": t("deleteBtn"),
      onClick: () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        Promise.resolve(onRemove(row.id)).catch(() => {
        });
      }
    }, confirming ? t("confirmDelete") : import_react.default.createElement(IconTrash, { key: "i" }))
  ]);
});
function Group({ label, items, meta, closed, t, today, onToggleOpen, onToggleTodo, onRemove, onSave, onPriority, onDue, onTitle, onProject, projects, projectsTruncated, celebrate, drag }) {
  const list = asArray(items);
  if (!list.length) return null;
  return import_react.default.createElement("div", { style: { marginTop: 6 } }, [
    import_react.default.createElement("div", {
      key: "head",
      className: "wt-group-head",
      onClick: onToggleOpen,
      title: closed ? t("expand") : t("collapse"),
      role: "button",
      "aria-expanded": !closed
    }, [
      import_react.default.createElement(IconChevron, { key: "c", open: !closed }),
      import_react.default.createElement("span", { key: "l", style: { fontWeight: 600, fontSize: 12 } }, label),
      import_react.default.createElement("span", { key: "n", style: { fontSize: 11, color: C.label3 } }, meta || String(list.length)),
      import_react.default.createElement("span", { key: "sp", style: { flex: 1 } }),
      import_react.default.createElement("span", { key: "h", style: { fontSize: 11, color: C.label3 } }, closed ? t("expand") : t("collapse"))
    ]),
    closed ? null : import_react.default.createElement("div", { key: "body" }, list.map((todo, index) => import_react.default.createElement(TodoRow, {
      key: todo && todo.id || `row-${index}`,
      todo,
      today,
      t,
      onToggle: onToggleTodo,
      onRemove,
      onSave,
      onPriority,
      onDue,
      onTitle,
      onProject,
      projects,
      projectsTruncated,
      celebrate,
      // S3-3：共享同一个 drag 对象（引用稳定），每行只有布尔 dragging 不同 ——
      // 否则每一行每次父级重渲染都会收到一个新的 drag 对象，memo 的浅比较必然失效
      drag,
      dragging: Boolean(drag) && drag.dragId === todo?.id
    })))
  ]);
}
function SessionAdopt({ useProjection, t, onAdopt, busy }) {
  let projected;
  try {
    projected = useProjection("todos");
  } catch {
    projected = null;
  }
  const raw = Array.isArray(projected) ? projected : asArray(projected?.todos);
  const items = raw.map((item) => ({
    content: typeof item?.content === "string" ? item.content : typeof item?.title === "string" ? item.title : "",
    status: typeof item?.status === "string" ? item.status : "pending"
  })).filter((item) => item.content.trim());
  if (!items.length) return null;
  const openCount = items.filter((item) => item.status !== "completed").length;
  return import_react.default.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }
  }, [
    import_react.default.createElement("button", {
      key: "b",
      type: "button",
      className: "wt-btn wt-btn-primary",
      disabled: Boolean(busy),
      title: t("adoptHint"),
      onClick: () => {
        Promise.resolve(onAdopt(items)).catch(() => {
        });
      }
    }, `${t("adoptPre")}${items.length}${t("adoptPost")}`),
    import_react.default.createElement("span", {
      key: "h",
      title: t("adoptHint"),
      style: { fontSize: 11, color: C.label3 }
    }, `${t("adoptPending")} ${openCount}`)
  ]);
}
var GROUPS = [
  { key: "overdue", label: "groupOverdue" },
  { key: "today", label: "groupToday" },
  { key: "week", label: "groupWeek" },
  { key: "later", label: "groupLater" },
  { key: "completed", label: "groupCompleted" }
];
var VIEW_SHAPES = { due: "groups", project: "projectGroups" };
function shapesForView(view) {
  return VIEW_SHAPES[view] ?? VIEW_SHAPES.due;
}
function hasViewShape(data, view) {
  if (!data) return false;
  return shapesForView(view) === "projectGroups" ? Array.isArray(data.projectGroups) : Boolean(data.groups && typeof data.groups === "object");
}
function payloadRecordIds(data) {
  const flat = asArray(data?.todos).map((todo) => todo?.id).filter(Boolean);
  if (flat.length) return flat;
  const merged = [];
  const groups = data?.groups;
  if (groups && typeof groups === "object") {
    for (const group of GROUPS) merged.push(...asArray(groups[group.key]));
  }
  for (const bucket of asArray(data?.projectGroups)) merged.push(...asArray(bucket?.todos));
  return merged.map((todo) => todo?.id).filter(Boolean);
}
function fillTemplate(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => key in vars ? String(vars[key]) : match);
}
function storeAlerts(store, t) {
  if (!store || typeof store !== "object") return [];
  const alerts = [];
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (store.mismatch) alerts.push({ key: "mismatch", tone: "warn", text: `${t("storeMismatch")}\uFF1A${store.mismatch}` });
  if (store.split) alerts.push({ key: "split", tone: "warn", text: `${t("storeSplit")}\uFF1A${store.split}` });
  if (store.backendError) alerts.push({ key: "backendError", tone: "warn", text: `${t("storeError")}\uFF1A${store.backendError}` });
  if (retired?.error) {
    alerts.push({
      key: "retiredFailed",
      tone: "warn",
      text: `${t("storeRetiredFailed")}\uFF1A${retired.error}\u3002` + fillTemplate(t("storeRetiredFailedHint"), { path: retired.path ?? "" })
    });
  } else if (retired?.movedTo) {
    alerts.push({ key: "retired", tone: "info", text: `${t("storeRetired")}\uFF1A${retired.movedTo}` });
  }
  const domainUnavailable = Boolean(retiredKnown && (typeof store.domainUnavailable === "boolean" ? store.domainUnavailable : store.kind !== "domain"));
  if (domainUnavailable) {
    const when = Number.isFinite(retired?.at) ? new Date(retired.at).toLocaleString() : "\u6B64\u524D";
    const archive = retired.movedTo ?? retired.marker ?? retired.path ?? "";
    alerts.push({
      key: "retiredUnavailable",
      tone: "warn",
      text: `${t("storeRetiredUnavailable")}\uFF1A${fillTemplate(t("storeRetiredUnavailableHint"), { when, archive })}`
    });
  }
  const merge = store.merge;
  if (merge && Number.isFinite(merge.merged)) {
    if (merge.aborted) {
      alerts.push({ key: "mergeAborted", tone: "warn", text: `${t("storeMergeAborted")}\uFF1A${merge.writeError ?? ""}` });
    } else {
      alerts.push({
        key: "merge",
        tone: "info",
        text: fillTemplate(t("storeMergeNote"), {
          merged: merge.merged,
          conflicts: merge.conflicts ?? 0,
          added: merge.added ?? 0
        })
      });
    }
  }
  return alerts;
}
function storeLocationLabel(store, t) {
  if (!store || typeof store !== "object") return null;
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (retiredKnown) {
    const domainReady = typeof store.domainUnavailable === "boolean" ? !store.domainUnavailable : store.kind === "domain";
    const confirmed = retired.movedTo ?? retired.marker;
    const archive = confirmed ? ` \xB7 ${t("storeRetiredArchive")} ${confirmed}` : "";
    const state = domainReady ? t("storeDomain") : `${t("storeDomain")} \xB7 ${t("storeUnavailable")}`;
    return `${t("storeAt")} \xB7 ${state} \xB7 ${t("storeRetired")}${archive}`;
  }
  if (!store.location) return null;
  const kind = store.kind === "domain" ? t("storeDomain") : t("storeFile");
  return `${t("storeAt")} \xB7 ${kind} \xB7 ${store.location}`;
}
var UPDATE_MODE_OPTIONS = Object.freeze([
  { value: "off", labelKey: "updateModeOff", hintKey: "updateModeOffHint" },
  { value: "manual", labelKey: "updateModeManual", hintKey: "updateModeManualHint" },
  { value: "auto", labelKey: "updateModeAuto", hintKey: "updateModeAutoHint" }
]);
function restartNotice(update, t) {
  if (!update?.restartRequired) return null;
  if (update?.updateMode === "off") return null;
  const raw = update?.installedVersion ?? update?.installed ?? null;
  const version = raw ? String(raw) : null;
  const text = version ? t("updateRestartBanner").replace("{version}", `v${version}`) : t("updateRestartBannerNoVersion");
  return { text, title: t("updateRestartBannerHint"), version };
}
function updateBadgeState(run, update, t) {
  const state = run?.state ?? "idle";
  const phase = typeof run?.phase === "string" ? run.phase : null;
  const percent = Number.isFinite(run?.percent) ? Math.max(0, Math.min(100, Math.floor(run.percent))) : null;
  const version = run?.version ?? run?.download?.version ?? update?.latest ?? null;
  const tag = version ? ` v${version}` : "";
  const restartSupported = update?.restartSupported === true || run?.restartSupported === true || run?.restart?.supported === true;
  const view = (text, title, tone, action, disabled, at) => ({ text, title, tone, action, disabled, phase: at ?? phase });
  if ((update?.updateMode ?? run?.updateMode) === "off" && !isUpdateBusy(run)) return null;
  if (phase === "checking") {
    return view(t("updateChecking"), t("updateChecking"), "busy", null, true);
  }
  if (phase === "check-failed") {
    return view(t("updateCheckFailed"), t("updateCheckFailedHint"), "muted", null, true);
  }
  if (phase === "unsupported") {
    const unsupportedKind = run?.updateUnsupported ?? run?.reason ?? null;
    const key = unsupportedKind === "link-install" ? "updateUnsupportedLink" : "updateUnsupportedProfile";
    return view(t(key), t(key), "muted", null, true);
  }
  if (phase === "downloading") {
    const text = percent === null ? t("updateDownloadingBytes").replace("{bytes}", formatBytes(run?.download?.bytes ?? 0)) : t("updateDownloading").replace("{percent}", String(percent));
    return view(text, run?.download?.url ? String(run.download.url) : t("updateDownloading"), "busy", null, true);
  }
  if (phase === "verifying") {
    return view(t("updateVerifying"), t("updateVerifying"), "busy", null, true);
  }
  if (phase === "downloaded") {
    return view(
      `${t("updateDownloadedState").replace("{version}", version ? `v${version}` : "")} \xB7 ${t("updateInstallRestart")}`,
      t("updateInstallHint").replace("{version}", version ? `v${version}` : ""),
      "ok",
      "install",
      false
    );
  }
  if (phase === "installing") {
    return view(t("updateInstalling"), run?.command ? String(run.command) : t("updateInstalling"), "busy", null, true);
  }
  if (phase === "restarting") {
    return view(t("updateRestarting"), t("updateRestarting"), "busy", null, true);
  }
  if (phase === "installed") {
    const restarted = run?.restart?.ok === true;
    if (restartSupported && !restarted) {
      return view(`${t("updateRestart")}${tag}`, t("updateRestartHint2"), "ok", "restart", false);
    }
    const reason = typeof run?.restart?.error === "string" && run.restart.error ? run.restart.error : t("updateInstalledManualHint");
    return view(
      t("updateInstalledManual").replace("{version}", version ? `v${version}` : ""),
      reason,
      "ok",
      null,
      true
    );
  }
  if (phase === "failed") {
    return failureBadge(run, t, view);
  }
  if (state === "running") {
    const to = run?.to ? ` v${run.to}` : "";
    return view(`${t("updating")}${to}`, run?.command ? String(run.command) : t("updating"), "busy", null, true);
  }
  if (update?.restartRequired) {
    const installed = update?.installedVersion ?? update?.installed;
    const versionText = installed ? `v${installed}` : "";
    const manual = update?.restartSupported === false;
    return view(
      manual ? t("updateInstalledManual").replace("{version}", versionText) : installed ? t("updatedRestart").replace("{version}", versionText) : t("updateRestartHint"),
      manual ? t("updateInstalledManualHint") : versionText || t("updateRestartHint"),
      "ok",
      null,
      true,
      null
    );
  }
  if (state === "done") {
    const to = run?.to ?? update?.installedVersion ?? update?.installed ?? update?.latest;
    if (to) {
      return view(
        t("updateInstalledManual").replace("{version}", `v${to}`),
        t("updateInstalledManualHint"),
        "ok",
        null,
        true,
        null
      );
    }
    return view(t("updateRestartHint"), t("updateRestartHint"), "ok", null, true, null);
  }
  if (state === "failed") {
    return failureBadge(run, t, view, null);
  }
  if (update?.hasUpdate) {
    return view(
      `${t("updateAvailable")} v${update.latest} \xB7 ${t("updateDownload")}`,
      t("updateHint"),
      "ok",
      "download",
      false,
      null
    );
  }
  return null;
}
function updateFailureDetail(run, t) {
  const diagnostics = run?.diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") {
    const current = run?.from ? String(run.from) : null;
    const target = run?.to ?? run?.version ?? null;
    return current || target ? `${t("updateDetailVersion")}=${current ?? "?"}\u2192${target ?? "?"}` : "";
  }
  const parts = [];
  if (diagnostics.step) parts.push(`${t("updateDetailStep")}=${diagnostics.step}`);
  if (diagnostics.command) parts.push(`${t("updateDetailCommand")}=${diagnostics.command}`);
  if (diagnostics.exitCode !== null && diagnostics.exitCode !== void 0) {
    parts.push(`${t("updateDetailExit")}=${diagnostics.exitCode}`);
  }
  if (diagnostics.spawnError) parts.push(`${t("updateDetailSpawn")}=${diagnostics.spawnError}`);
  if (diagnostics.currentVersion || diagnostics.target) {
    parts.push(`${t("updateDetailVersion")}=${diagnostics.currentVersion ?? "?"}\u2192${diagnostics.target ?? "?"}`);
  }
  if (Array.isArray(diagnostics.logTail) && diagnostics.logTail.length) {
    parts.push(`${t("updateDetailLog")}=${diagnostics.logTail.slice(-3).join(" / ")}`);
  }
  return parts.join(" \xB7 ");
}
function failureBadge(run, t, view, forcedPhase = void 0) {
  const reason = run?.reason;
  if (reason === "linked" || run?.failure === "linked") {
    return view(t("updateLinked"), t("updateLinked"), "warn", null, true, forcedPhase);
  }
  const reasonText = String(run?.error ?? reason ?? "");
  const detail = updateFailureDetail(run, t);
  const downloadFailed = run?.failedOperation === "download" || run?.failure === "download" || run?.failure === "download-network" || run?.failure === "download-corrupt";
  const action = downloadFailed || !run?.download ? "download" : "retry";
  const title = [t("updateRetryHint"), reasonText, detail].filter(Boolean).join(" \u2014 ");
  const badge = view(
    `${downloadFailed ? t("updateDownloadFailed") : t("updateFailed")}\uFF1A${reasonText}`,
    title,
    "error",
    action,
    false,
    forcedPhase
  );
  badge.detail = detail;
  return badge;
}
function isUpdateBusy(run) {
  const phase = run?.phase;
  if (typeof phase === "string") {
    return phase === "checking" || phase === "downloading" || phase === "verifying" || phase === "installing" || phase === "restarting";
  }
  return run?.state === "running";
}
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function WorkTodoPanel(props) {
  const t = typeof props?.t === "function" ? props.t : FALLBACK_T;
  const [sort, setSortState] = import_react.default.useState(lastSort);
  const setSort = import_react.default.useCallback((next) => {
    lastSort = next;
    setSortState(next);
  }, []);
  const [dragId, setDragId] = import_react.default.useState(null);
  const [view, setView] = import_react.default.useState("due");
  const shapes = shapesForView(view);
  const { status, data, error, refresh } = useList(sort, shapes);
  const version = typeof data?.version === "string" ? data.version : "";
  const update = data?.update ?? null;
  const celebrate = shouldCelebrate(data?.panel);
  const celebrationRefresh = import_react.default.useMemo(() => createCelebrationRefresh(refresh), [refresh]);
  import_react.default.useEffect(() => () => celebrationRefresh.cancel(), [celebrationRefresh]);
  import_react.default.useEffect(() => {
    const timer = setInterval(() => {
      if (isWindowHidden()) return;
      refresh();
    }, CHANGE_POLL_MS);
    timer?.unref?.();
    const onActive = () => refresh();
    const onVisible = () => {
      if (!isWindowHidden()) refresh();
    };
    window?.addEventListener?.("focus", onActive);
    if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window?.removeEventListener?.("focus", onActive);
      if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [refresh]);
  const [updateRun, setUpdateRun] = import_react.default.useState(null);
  const run = updateRun ?? update?.run ?? null;
  const runState = run?.state ?? "idle";
  const updateBadge = updateBadgeState(run, update, t);
  const restart = restartNotice(update, t);
  const [settingsOpen, setSettingsOpen] = import_react.default.useState(false);
  const [modeOverride, setModeOverride] = import_react.default.useState(null);
  const [settingsPending, setSettingsPending] = import_react.default.useState(false);
  const [settingsError, setSettingsError] = import_react.default.useState(null);
  const settingsWrapRef = import_react.default.useRef(null);
  const updateMode = modeOverride ?? update?.updateMode ?? "manual";
  const openSettings = import_react.default.useCallback(() => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    setSettingsError(null);
    if (!next) return;
    fetch(`${ROUTE_BASE}/settings`, { cache: "no-store", credentials: "same-origin" }).then((response) => response.json()).then((parsed) => {
      const mode = parsed?.ok ? parsed?.data?.updateMode : null;
      if (mode) setModeOverride(mode);
    }).catch(() => {
    });
  }, [settingsOpen]);
  const chooseMode = import_react.default.useCallback((next) => {
    if (next === updateMode || settingsPending) return Promise.resolve(false);
    setSettingsPending(true);
    setSettingsError(null);
    return postJson("/settings", { updateMode: next }).then((data2) => {
      setModeOverride(data2?.updateMode ?? next);
      refresh();
      return true;
    }).catch((error2) => {
      setSettingsError(String(error2?.message ?? error2));
      return false;
    }).finally(() => setSettingsPending(false));
  }, [updateMode, settingsPending, refresh]);
  import_react.default.useEffect(() => {
    if (!settingsOpen) return void 0;
    const onPointerDown = (event) => {
      const wrap = settingsWrapRef.current;
      if (wrap && typeof wrap.contains === "function" && event?.target && wrap.contains(event.target)) return;
      setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [settingsOpen]);
  const busy = isUpdateBusy(run);
  import_react.default.useEffect(() => {
    if (!busy) return void 0;
    let alive = true;
    const timer = setInterval(() => {
      if (isWindowHidden()) return;
      fetchUpdateRun().then((next) => {
        if (!alive || !next) return;
        if (!isUpdateBusy(next)) {
          setUpdateRun(next);
          refresh();
        }
      }).catch(() => {
      });
    }, UPDATE_POLL_MS);
    timer?.unref?.();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [busy, refresh]);
  const [barError, setBarError] = import_react.default.useState(null);
  const [dismissedReadError, setDismissedReadError] = import_react.default.useState(null);
  const readError = error && error !== dismissedReadError ? error : null;
  const shownError = barError ?? readError;
  const [notice, setNotice] = import_react.default.useState(null);
  const [pending, setPending] = import_react.default.useState(0);
  const [closed, setClosed] = import_react.default.useState({ completed: true });
  const projectOptions = import_react.default.useMemo(
    () => asArray(data?.projects).map((name) => typeof name === "string" ? name.trim() : "").filter(Boolean),
    [data]
  );
  const runWrite = import_react.default.useCallback(async (job, options = {}) => {
    const deferMs = Number(options?.deferRefreshMs);
    const wantsDeferredRefresh = Number.isFinite(deferMs) && deferMs > 0;
    celebrationRefresh.cancel();
    setPending((n) => n + 1);
    let writeFailed = false;
    try {
      const data2 = await job();
      setBarError(null);
      return { ok: true, data: data2 ?? {} };
    } catch (writeError) {
      writeFailed = true;
      if (options?.quietError !== true) setBarError(String(writeError?.message ?? writeError));
      celebrationRefresh.cancel();
      return { ok: false, data: {} };
    } finally {
      setPending((n) => Math.max(0, n - 1));
      if (wantsDeferredRefresh && !writeFailed) {
        celebrationRefresh.schedule(deferMs);
      } else {
        celebrationRefresh.cancel();
        refresh();
      }
    }
  }, [refresh, celebrationRefresh]);
  const [updatePending, setUpdatePending] = import_react.default.useState(false);
  const postUpdateAction = import_react.default.useCallback((action) => {
    setUpdatePending(true);
    return postJson("/update", { action }).then((next) => {
      if (next && typeof next === "object" && (next.phase || next.state)) setUpdateRun(next);
      refresh();
      return true;
    }).catch((updateError) => {
      setUpdateRun((previous) => ({
        ...previous ?? {},
        state: "failed",
        phase: "failed",
        failure: null,
        failedOperation: previous?.failedOperation ?? null,
        error: String(updateError?.message ?? updateError)
      }));
      return false;
    }).finally(() => setUpdatePending(false));
  }, [refresh]);
  const handleUpdate = import_react.default.useCallback(() => {
    if (busy || updatePending) return Promise.resolve(false);
    const action = updateBadge?.action ?? null;
    if (action === "download") return postUpdateAction("plugin-update-download");
    if (action === "install") return postUpdateAction("plugin-update-install");
    if (action === "restart") return postUpdateAction("plugin-update-restart");
    if (action === "retry") {
      const needsDownload = !run?.download || run?.failedOperation === "download" || run?.failure === "download-corrupt";
      return postUpdateAction(needsDownload ? "plugin-update-download" : "plugin-update-install");
    }
    return postUpdateAction("plugin-update");
  }, [busy, updatePending, updateBadge?.action, run?.download, run?.failedOperation, run?.failure, postUpdateAction]);
  const handleAdd = import_react.default.useCallback((input) => {
    const title = String(input?.title ?? "").trim();
    if (!title) {
      setBarError(t("titleEmpty"));
      return Promise.resolve(false);
    }
    return runWrite(() => postJson("/create", {
      title,
      due: input?.due ? String(input.due) : null,
      // 必须一起发：QuickAdd 已经把「下午3点」这类时间词从标题里摘掉了，
      // 这里漏掉就等于用户输入的时间被永久丢弃（审计 F5）。空值统一给 null，别给 undefined。
      dueTime: input?.dueTime ? String(input.dueTime) : null,
      priority: input?.priority ?? "normal",
      // 项目：来自 QuickAdd 的项目选择器。空值同样必须显式 null——
      // 宿主对请求体做无损 JSON 校验，undefined 会变成「没有这个键」甚至整次调用被拒。
      project: input?.project ? String(input.project).trim() : null
    })).then((result) => result.ok);
  }, [runWrite, t]);
  const handleToggle = import_react.default.useCallback((ref, options = {}) => runWrite(
    () => postJson("/status", { ref, toggle: true }),
    options?.celebrate ? { deferRefreshMs: CELEBRATE_REFRESH_MS } : void 0
  ), [runWrite]);
  const handleRemove = import_react.default.useCallback((ref) => runWrite(() => postJson("/remove", { ref })), [runWrite]);
  const handleSave = import_react.default.useCallback((ref, patch) => runWrite(() => postJson("/update", { ref, ...patch })), [runWrite]);
  const handlePriority = import_react.default.useCallback((ref, priority) => runWrite(() => postJson("/update", { ref, priority })), [runWrite]);
  const handleDue = import_react.default.useCallback((ref, patch) => runWrite(
    () => postJson("/update", { ref, ...patch }),
    { quietError: true }
  ), [runWrite]);
  const handleTitle = import_react.default.useCallback((ref, title) => runWrite(
    () => postJson("/update", { ref, title }),
    { quietError: true }
  ), [runWrite]);
  const handleProject = import_react.default.useCallback((ref, project) => runWrite(
    () => postJson("/update", { ref, project: project ?? null }),
    { quietError: true }
  ), [runWrite]);
  const handleDropOn = import_react.default.useCallback((targetId) => {
    const dragging = dragId;
    setDragId(null);
    if (!dragging || !targetId || dragging === targetId) return Promise.resolve(false);
    const ids = payloadRecordIds(data);
    const from = ids.indexOf(dragging);
    if (from === -1) return Promise.resolve(false);
    ids.splice(from, 1);
    const to = ids.indexOf(targetId);
    ids.splice(to === -1 ? ids.length : to, 0, dragging);
    return runWrite(() => postJson("/reorder", { ids })).then((result) => result.ok);
  }, [dragId, data, runWrite]);
  const dragHandlers = import_react.default.useMemo(() => ({
    dragId,
    hint: t("dragHint"),
    onStart: (id) => {
      setDragId(id);
      if (sort !== "manual") setSort("manual");
    },
    onOver: () => {
    },
    onDrop: (id) => handleDropOn(id),
    onEnd: () => setDragId(null)
  }), [dragId, sort, t, setSort, handleDropOn]);
  const handleAdopt = import_react.default.useCallback((sessionTodos) => runWrite(() => postJson("/adopt", { todos: sessionTodos })).then((result) => {
    if (result.ok) {
      const created = Array.isArray(result.data?.created) ? result.data.created.length : 0;
      const skipped = Number.isFinite(Number(result.data?.skipped)) ? Number(result.data.skipped) : 0;
      setNotice(`${t("adoptDone")} ${created} \xB7 ${t("adoptSkipped")} ${skipped}`);
    }
    return result.ok;
  }), [runWrite, t]);
  const useProjection = typeof props?.useProjection === "function" ? props.useProjection : void 0;
  const rootStyle = {
    height: "100%",
    overflow: "auto",
    padding: "16px 18px 40px",
    boxSizing: "border-box",
    color: C.label,
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    fontSize: 13
  };
  if (status === "loading" && !data) {
    return import_react.default.createElement("div", {
      className: "wt-root",
      style: { ...rootStyle, display: "flex", alignItems: "center", gap: 8, color: C.label3, padding: 28 }
    }, [
      import_react.default.createElement("style", { key: "css" }, STYLE_TEXT),
      import_react.default.createElement("span", { key: "sp", className: "wt-spin" }),
      import_react.default.createElement("span", { key: "t" }, t("loading"))
    ]);
  }
  if (status === "failed" && !data) {
    return import_react.default.createElement("div", {
      className: "wt-root",
      style: { ...rootStyle, padding: 28, color: C.error }
    }, [
      import_react.default.createElement("style", { key: "css" }, STYLE_TEXT),
      import_react.default.createElement("div", { key: "m" }, `${t("failed")}\uFF1A${error ?? ""}`),
      import_react.default.createElement("button", {
        key: "r",
        type: "button",
        className: "wt-btn",
        style: { marginTop: 10 },
        onClick: refresh
      }, t("retry"))
    ]);
  }
  if (data && !hasViewShape(data, view)) {
    return import_react.default.createElement("div", {
      className: "wt-root",
      style: { ...rootStyle, display: "flex", alignItems: "center", gap: 8, color: C.label3, padding: 28 }
    }, [
      import_react.default.createElement("style", { key: "css" }, STYLE_TEXT),
      import_react.default.createElement("span", { key: "sp", className: "wt-spin" }),
      import_react.default.createElement("span", { key: "t" }, t("loading"))
    ]);
  }
  const groups = data?.groups ?? {};
  const stats = data?.stats ?? {};
  const today = typeof data?.today === "string" && data.today ? data.today : localToday();
  const store = data?.store ?? null;
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const overdueCount = num(stats.overdue);
  const projectGroups = asArray(data?.projectGroups);
  const viewGroups = view === "project" ? projectGroups.map((bucket) => ({
    key: `p:${bucket?.key ?? ""}`,
    label: bucket?.project ? String(bucket.project) : t("noProject"),
    meta: `${num(bucket?.open)}/${num(bucket?.total)}${num(bucket?.overdue) ? ` \xB7 ${t("statOverdue")} ${num(bucket.overdue)}` : ""}`,
    items: bucket?.todos
  })) : GROUPS.map((group) => ({ key: group.key, label: t(group.label), items: groups[group.key] }));
  const totalVisible = viewGroups.reduce((sum, group) => sum + asArray(group.items).length, 0);
  const chips = [
    { key: "open", label: t("statOpen"), value: num(stats.open) },
    { key: "overdue", label: t("statOverdue"), value: overdueCount, alert: overdueCount > 0 },
    { key: "today", label: t("statToday"), value: num(stats.today) },
    { key: "doing", label: t("statDoing"), value: num(stats.doing) },
    { key: "done", label: t("statDoneToday"), value: num(stats.completedToday) }
  ];
  const settingsNode = import_react.default.createElement("span", {
    key: "settings",
    className: "wt-settings-wrap",
    ref: settingsWrapRef,
    onKeyDown: (event) => {
      if (event?.key === "Escape" && settingsOpen) {
        event.preventDefault?.();
        setSettingsOpen(false);
      }
    }
  }, [
    import_react.default.createElement("button", {
      key: "gear",
      type: "button",
      className: "wt-icon-btn wt-settings-btn",
      title: t("updateSettings"),
      "aria-label": t("updateSettings"),
      "aria-haspopup": "dialog",
      "aria-expanded": settingsOpen,
      disabled: settingsPending,
      onClick: openSettings
    }, import_react.default.createElement(IconSettings, { key: "i" })),
    settingsOpen ? import_react.default.createElement("div", {
      key: "pop",
      className: "wt-settings-pop",
      role: "dialog",
      "aria-label": t("updateSettingsTitle")
    }, [
      import_react.default.createElement("div", { key: "t", className: "wt-settings-pop-title" }, t("updateSettingsTitle")),
      import_react.default.createElement("div", { key: "h", className: "wt-settings-pop-hint" }, t("updateSettingsHint")),
      import_react.default.createElement("div", {
        key: "g",
        className: "wt-settings-group",
        role: "radiogroup",
        "aria-label": t("updateModeLabel")
      }, UPDATE_MODE_OPTIONS.map((option) => import_react.default.createElement("button", {
        key: option.value,
        type: "button",
        role: "radio",
        "aria-checked": updateMode === option.value,
        className: `wt-settings-option${updateMode === option.value ? " is-on" : ""}`,
        title: t(option.hintKey),
        disabled: settingsPending,
        onClick: () => chooseMode(option.value)
      }, [
        import_react.default.createElement("span", { key: "l", className: "wt-settings-option-label" }, [
          import_react.default.createElement("span", { key: "r", className: "wt-settings-radio", "aria-hidden": "true" }),
          t(option.labelKey)
        ]),
        import_react.default.createElement("span", { key: "h", className: "wt-settings-option-hint" }, t(option.hintKey))
      ]))),
      import_react.default.createElement("div", { key: "f", className: "wt-settings-foot" }, [
        import_react.default.createElement("span", { key: "v", title: t("versionHint") }, t("updateSettingsCurrentVersion").replace("{version}", version ? `v${version}` : "\u2014")),
        import_react.default.createElement("span", { key: "sp", style: { flex: 1 } }),
        import_react.default.createElement("button", {
          key: "check",
          type: "button",
          className: "wt-btn",
          disabled: updateMode === "off" || busy || updatePending || settingsPending,
          title: updateMode === "off" ? t("updateCheckDisabledOff") : t("updateCheckNowHint"),
          onClick: () => postUpdateAction("plugin-update-check")
        }, settingsPending ? t("updateSettingsSaving") : t("updateCheckNow"))
      ]),
      updateMode === "off" ? import_react.default.createElement("div", { key: "off", className: "wt-settings-pop-hint" }, t("updateCheckDisabledOff")) : null,
      settingsError ? import_react.default.createElement(
        "div",
        { key: "err", className: "wt-settings-error", role: "alert" },
        `${t("updateSettingsFailed")}\uFF1A${settingsError}`
      ) : null
    ]) : null
  ]);
  return import_react.default.createElement("div", { className: "wt-root", style: rootStyle }, [
    import_react.default.createElement("style", { key: "css" }, STYLE_TEXT),
    /* 顶部重启提醒：装好待重启时醒目但不打扰；没有假重启按钮 */
    restart ? import_react.default.createElement("div", {
      key: "restart",
      className: "wt-restart-banner",
      role: "status",
      "aria-live": "polite",
      title: restart.title
    }, [
      import_react.default.createElement("span", { key: "m", className: "wt-restart-banner-mark", "aria-hidden": "true" }, "\u2191"),
      import_react.default.createElement("span", { key: "t", className: "wt-restart-banner-text" }, restart.text)
    ]) : null,
    /* 顶部：标题 + 统计 + 刷新（更新设置入口已移到页脚版本号旁边） */
    import_react.default.createElement("div", {
      key: "head",
      className: "wt-head",
      style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }
    }, [
      import_react.default.createElement("div", { key: "ti", style: { fontWeight: 700, fontSize: 15 } }, t("title")),
      ...chips.map((chip) => import_react.default.createElement("span", {
        key: chip.key,
        className: "wt-chip",
        style: chip.alert ? { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) } : void 0
      }, [
        import_react.default.createElement("span", { key: "l", style: { color: C.label3 } }, chip.label),
        import_react.default.createElement("b", { key: "v", style: { fontWeight: 650 } }, String(chip.value))
      ])),
      import_react.default.createElement("span", { key: "sort", className: "wt-seg", title: t("sortLabel") }, [
        ...["manual", "priority", "created"].map((mode) => import_react.default.createElement("button", {
          key: mode,
          type: "button",
          className: `wt-seg-btn${sort === mode ? " is-on" : ""}`,
          title: mode === "manual" ? t("dragHint") : `${t("sortLabel")}\uFF1A${t(`sort${mode === "manual" ? "Manual" : mode === "priority" ? "Priority" : "Created"}`)}`,
          onClick: () => setSort(mode)
        }, t(`sort${mode === "manual" ? "Manual" : mode === "priority" ? "Priority" : "Created"}`)))
      ]),
      import_react.default.createElement("span", { key: "view", className: "wt-seg" }, [
        import_react.default.createElement("button", {
          key: "due",
          type: "button",
          className: `wt-seg-btn${view === "due" ? " is-on" : ""}`,
          title: t("viewDue"),
          onClick: () => setView("due")
        }, t("viewDue")),
        import_react.default.createElement("button", {
          key: "proj",
          type: "button",
          className: `wt-seg-btn${view === "project" ? " is-on" : ""}`,
          title: t("viewProject"),
          onClick: () => setView("project")
        }, t("viewProject"))
      ]),
      import_react.default.createElement("span", { key: "sp", style: { flex: 1 } }),
      import_react.default.createElement("button", {
        key: "rf",
        type: "button",
        className: "wt-btn",
        disabled: status === "loading" || pending > 0,
        title: t("refresh"),
        onClick: refresh
      }, [
        import_react.default.createElement(IconRefresh, { key: "i" }),
        t("refresh")
      ])
    ]),
    /* 错误条：宿主的 error 原文照贴，绝不吞掉 */
    shownError ? import_react.default.createElement("div", {
      key: "err",
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        marginBottom: 10,
        padding: "6px 9px",
        borderRadius: 8,
        border: `1px solid ${tint(C.error, 45)}`,
        background: tint(C.error, 12),
        color: C.error,
        fontSize: 12,
        lineHeight: 1.6
      }
    }, [
      import_react.default.createElement("span", {
        key: "m",
        style: { flex: 1, minWidth: 0, wordBreak: "break-word" }
      }, `${t("failed")}\uFF1A${shownError}`),
      import_react.default.createElement("button", {
        key: "x",
        type: "button",
        className: "wt-icon-btn",
        style: { width: 18, height: 18, color: C.error },
        title: t("dismiss"),
        "aria-label": t("dismiss"),
        onClick: () => {
          setBarError(null);
          setDismissedReadError(error ?? null);
        }
      }, import_react.default.createElement(IconClose, { key: "i" }))
    ]) : null,
    /* 提升结果提示：点完按钮要有个回执 */
    notice ? import_react.default.createElement("div", {
      key: "notice",
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 10,
        padding: "5px 9px",
        borderRadius: 8,
        border: `1px solid ${tint(C.ok, 40)}`,
        background: tint(C.ok, 10),
        color: C.label2,
        fontSize: 11.5
      }
    }, [
      import_react.default.createElement("span", { key: "m", style: { flex: 1 } }, notice),
      import_react.default.createElement("span", {
        key: "x",
        className: "wt-link",
        onClick: () => setNotice(null)
      }, t("dismiss"))
    ]) : null,
    /* 会话待办：只在拿得到 useProjection 时挂载（见 SessionAdopt 的说明） */
    useProjection ? import_react.default.createElement(SessionAdopt, {
      key: "adopt",
      useProjection,
      t,
      busy: pending > 0,
      onAdopt: handleAdopt
    }) : null,
    import_react.default.createElement(QuickAdd, {
      key: "quick",
      t,
      busy: pending > 0,
      onAdd: handleAdd,
      // 已知项目：宿主 /list 的 projects 在**任何 shapes 下都有**（见 service.list），
      // 所以面板无论停在「按截止」还是「按项目」，选择器都能列出已有项目。
      projects: projectOptions,
      projectsTruncated: Boolean(data?.projectsTruncated)
    }),
    /* 分组列表 */
    totalVisible ? import_react.default.createElement("div", { key: "groups" }, viewGroups.map((group) => import_react.default.createElement(Group, {
      key: group.key,
      label: group.label,
      meta: group.meta,
      items: group.items,
      closed: Boolean(closed[group.key]),
      t,
      today,
      onToggleOpen: () => setClosed((prev) => ({ ...prev, [group.key]: !prev[group.key] })),
      onToggleTodo: handleToggle,
      onRemove: handleRemove,
      onSave: handleSave,
      onPriority: handlePriority,
      onDue: handleDue,
      onTitle: handleTitle,
      onProject: handleProject,
      projects: projectOptions,
      projectsTruncated: Boolean(data?.projectsTruncated),
      celebrate,
      drag: dragHandlers
    }))) : import_react.default.createElement("div", {
      key: "empty",
      style: { padding: "22px 12px", textAlign: "center", color: C.label3 }
    }, [
      import_react.default.createElement("div", { key: "a", style: { fontSize: 13, color: C.label2 } }, t("empty")),
      import_react.default.createElement("div", { key: "b", style: { fontSize: 11.5, marginTop: 4 } }, t("emptyHint"))
    ]),
    /* 底部：数据到底存在哪（排查「我的待办不见了」时第一眼要看的东西） */
    import_react.default.createElement("div", {
      key: "foot",
      className: "wt-foot",
      style: { marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border1}`, fontSize: 10.5, color: C.label3, lineHeight: 1.7 }
    }, [
      /* 角落信息：装了哪一版 + 更新设置齿轮 + 有没有新版（一眼可见，不占主区）。
         齿轮紧挨版本号右侧（同一行、gap 6px、垂直居中）：设置是「这一版怎么更新」的一部分。 */
      import_react.default.createElement("div", {
        key: "ver",
        className: "wt-ver-row"
      }, [
        import_react.default.createElement("span", {
          key: "v",
          title: t("versionHint"),
          style: { color: C.label3 }
        }, `${t("versionLabel")} ${version ? `v${version}` : "\u2014"}`),
        settingsNode,
        updateBadge ? updateBadge.action ? import_react.default.createElement("button", {
          key: "u",
          type: "button",
          className: "wt-chip wt-update",
          // 无障碍：按钮的可读名就是当前那一格在说什么（下载/安装并重启/重启/重试）
          "aria-label": updateBadge.text,
          // 下载/安装进行中、或面板还有写操作在飞时不可点，避免连点出第二次下载/第二个子进程
          disabled: updateBadge.disabled || updatePending || busy || pending > 0,
          onClick: handleUpdate,
          title: updateBadge.title,
          style: { fontSize: 10, ...UPDATE_TONE_STYLE[updateBadge.tone] }
        }, updateBadge.text) : import_react.default.createElement("span", {
          key: "u",
          className: "wt-chip wt-update is-state",
          // 下载中报成 progressbar（读屏能听到 42%），其余进行中/终态是普通 status
          ...updateBadge.phase === "downloading" && Number.isFinite(run?.percent) ? { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.floor(run.percent) } : { role: "status" },
          "aria-label": updateBadge.text,
          "aria-live": "polite",
          title: updateBadge.title,
          style: { fontSize: 10, ...UPDATE_TONE_STYLE[updateBadge.tone] }
        }, updateBadge.text) : null
      ]),
      /* 失败详情：一行小字（完整内容在 title 里，可 hover 查看；只用文本节点，绝不拼 HTML）。
         内容全部来自宿主 diagnostics：步骤 / 命令 / 退出码 / 目标与当前版本 / 日志尾部。 */
      updateBadge?.detail ? import_react.default.createElement("div", {
        key: "udetail",
        className: "wt-update-detail",
        title: updateBadge.detail,
        style: { color: C.label3, wordBreak: "break-word", marginBottom: 2 }
      }, `${t("updateFailureDetail")} \xB7 ${String(updateBadge.detail).length > 240 ? `${String(updateBadge.detail).slice(0, 240)}\u2026` : updateBadge.detail}`) : null,
      storeLocationLabel(store, t) ? import_react.default.createElement("div", {
        key: "store",
        title: storeLocationLabel(store, t),
        style: { wordBreak: "break-all" }
      }, storeLocationLabel(store, t)) : null,
      /* 复审 R4/R5：describe() 里的告警必须在面板上**看得见**，不能只躺在 /health 的 JSON 里 */
      ...storeAlerts(store, t).map((alert) => import_react.default.createElement("div", {
        key: `alert-${alert.key}`,
        className: `wt-store-alert wt-store-alert-${alert.tone}`,
        title: alert.text,
        style: alert.tone === "warn" ? { color: C.warn, wordBreak: "break-word" } : { color: C.label3, wordBreak: "break-word" }
      }, alert.text))
    ])
  ]);
}
var inject = ["slots", "locale"];
function safeRegister(label, run) {
  try {
    return run();
  } catch (error) {
    console.warn(`[${SHORT_NAME}] ${label}\u5931\u8D25\uFF08\u8DF3\u8FC7\u8FD9\u4E00\u6761\uFF0C\u5176\u4F59\u7167\u5E38\uFF09\uFF1A${error?.message ?? error}`);
    return () => {
    };
  }
}
function apply(ctx) {
  ctx.effect(
    () => safeRegister("locale \u5B57\u5178\u6CE8\u518C", () => ctx.locale.register(LOCALE_NS, { zh, en })),
    `${LOCALE_NS}: dictionaries`
  );
  ctx.slots.inject("sidebar.panellist", () => safeRegister("sidebar.panellist \u6CE8\u518C", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: SLOT_ID,
    order: 88,
    label: () => "\u5F85\u529E",
    locale: LOCALE_NS
  }, withErrorBoundary((props) => import_react.default.createElement(WorkTodoIcon, { size: props?.size ?? 16, active: props?.active })))));
  ctx.slots.inject("main", () => safeRegister("main \u9762\u677F\u6CE8\u518C", () => ctx.slots.register({
    name: "main",
    key: SLOT_ID,
    locale: LOCALE_NS
  }, withErrorBoundary(WorkTodoPanel))));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
