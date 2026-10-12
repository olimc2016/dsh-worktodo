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
  apply: () => apply,
  inject: () => inject
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
var zh = {
  "nav": "\u5F85\u529E",
  "title": "\u5DE5\u4F5C\u5F85\u529E",
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
  "updateHint": "\u66F4\u65B0\u547D\u4EE4\uFF08\u91CD\u542F DSH \u751F\u6548\uFF09",
  "addOpen": "\u65B0\u589E\u5F85\u529E",
  "addCancel": "\u53D6\u6D88",
  "prioNone": "\u65E0",
  "dateUnset": "\u65E5\u671F \xB7 \u672A\u8BBE",
  "timeUnset": "\u65F6\u95F4 \xB7 \u672A\u8BBE",
  "todayWord": "\u4ECA\u5929",
  "fromParsed": "\u8BC6\u522B",
  "dueTimeLabel": "\u65F6\u95F4",
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
  "deleteBtn": "\u5220\u9664",
  "confirmDelete": "\u786E\u8BA4\u5220\u9664\uFF1F",
  "save": "\u4FDD\u5B58",
  "cancel": "\u53D6\u6D88",
  "projectLabel": "\u9879\u76EE",
  "projectPlaceholder": "\u9879\u76EE\u540D\uFF08\u53EF\u9009\uFF09",
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
  "updateHint": "Update command (restart DSH to apply)",
  "addOpen": "New todo",
  "addCancel": "Cancel",
  "prioNone": "None",
  "dateUnset": "Date \xB7 unset",
  "timeUnset": "Time \xB7 unset",
  "todayWord": "Today",
  "fromParsed": "parsed",
  "dueTimeLabel": "Time",
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
  "deleteBtn": "Delete",
  "confirmDelete": "Delete?",
  "save": "Save",
  "cancel": "Cancel",
  "projectLabel": "Project",
  "projectPlaceholder": "project (optional)",
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
var STYLE_TEXT = `
@keyframes wt-spin { to { transform: rotate(360deg); } }
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
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 17px; height: 17px; margin-top: 1px; padding: 0; border-radius: 5px;
  border: 1px solid ${C.border}; background: transparent; color: transparent; cursor: pointer;
}
.wt-check:hover { border-color: ${C.brand}; }
.wt-check-done {
  border-color: ${tint(C.ok, 55)}; background: ${tint(C.ok, 14)}; color: ${C.ok};
}
.wt-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; border-radius: 10px; }
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
  appearance: none; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  font: inherit; font-size: 11.5px; padding: 5px 9px; border-radius: 9px;
  background: transparent; border: 1px solid ${C.border}; color: ${C.label2};
}
.wt-flag-btn.is-on { border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); color: inherit; }
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
.wt-tag {
  display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; line-height: 1.6;
  padding: 0 6px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
.wt-link { cursor: pointer; user-select: none; color: var(--dsw-alias-link); font-size: 11px; }
.wt-link:hover { text-decoration: underline; }
.wt-title { cursor: pointer; word-break: break-word; }
.wt-title:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.wt-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.brand}; animation: wt-spin .8s linear infinite;
}
`;
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
function IconCheck({ size = 11 }) {
  return import_react.default.createElement("svg", {
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = await response.json().catch(() => null);
  if (!parsed) throw new Error("\u54CD\u5E94\u4E0D\u662F JSON");
  if (!parsed.ok) throw new Error(parsed.error ?? parsed.reason ?? "\u672A\u77E5\u9519\u8BEF");
  return parsed.data ?? {};
}
var lastList = null;
var lastSort = "manual";
function useList(sort) {
  const [state, setState] = import_react.default.useState(() => lastList ? { status: "ready", data: lastList, error: null } : { status: "loading", data: null, error: null });
  const [tick, setTick] = import_react.default.useState(0);
  import_react.default.useEffect(() => {
    let alive = true;
    fetch(`${ROUTE_LIST}?filter=all&sort=${encodeURIComponent(sort || "manual")}`, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.error ?? body?.reason ?? "\u672A\u77E5\u9519\u8BEF");
      lastList = body.data;
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
  }, [tick, sort]);
  const refresh = import_react.default.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
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
var IconCal = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("rect", { key: "r", x: 2.2, y: 3.4, width: 11.6, height: 10.4, rx: 2 }),
  import_react.default.createElement("path", { key: "p", d: "M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4" })
]);
var IconClock = () => import_react.default.createElement("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" }, [
  import_react.default.createElement("circle", { key: "c", cx: 8, cy: 8, r: 5.8 }),
  import_react.default.createElement("path", { key: "p", d: "M8 4.9V8l2.2 1.4" })
]);
function QuickAdd({ t, onAdd, busy }) {
  const [title, setTitle] = import_react.default.useState("");
  const [due, setDue] = import_react.default.useState("");
  const [dueTime, setDueTime] = import_react.default.useState("");
  const [priority, setPriority] = import_react.default.useState("none");
  const [parsed, setParsed] = import_react.default.useState(null);
  const [manual, setManual] = import_react.default.useState(false);
  const [flagOpen, setFlagOpen] = import_react.default.useState(false);
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
      priority
    })).then((ok) => {
      if (ok !== false) {
        setTitle("");
        setParsed(null);
        setManual(false);
        setFlagOpen(false);
      }
    }).catch(() => {
    });
  };
  const today = dayKey2(Date.now());
  const dateLabel = due ? due === today ? t("todayWord") : `${due.slice(5).replace("-", "-")}` : t("dateUnset");
  const timeLabel = dueTime || t("timeUnset");
  const prioLabel = priority === "high" ? t("prioHigh") : priority === "normal" ? t("prioNormal") : priority === "low" ? t("prioLow") : t("prioNone");
  const prioColor = priority === "high" ? C.error : priority === "normal" ? C.warn : C.label3;
  const flags = [
    { value: "none", label: t("prioNone"), color: C.label3, dashed: true },
    { value: "high", label: t("prioHigh"), color: C.error },
    { value: "normal", label: t("prioNormal"), color: C.warn },
    { value: "low", label: t("prioLow"), color: C.label3 }
  ];
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
    // ---- 第二行（更小）：日期 / 时间 / 优先级 ----
    import_react.default.createElement("div", { key: "l2", style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8, fontSize: 11.5, flexWrap: "wrap" } }, [
      // 日期：label 里套一个透明的原生 date 输入，点它即弹系统日历
      import_react.default.createElement("label", {
        key: "due",
        className: `wt-chip${parsed && parsed.due ? " is-parsed" : ""}`,
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
      // 优先级：点开四个小旗
      import_react.default.createElement("span", { key: "prio", style: { position: "relative" } }, [
        import_react.default.createElement("button", {
          key: "btn",
          type: "button",
          className: "wt-chip",
          style: { color: prioColor, cursor: "pointer", font: "inherit", fontSize: 11.5 },
          title: t("priorityLabel"),
          "aria-expanded": flagOpen,
          onClick: () => setFlagOpen((open) => !open)
        }, [
          import_react.default.createElement(IconFlag, { key: "f", dashed: priority === "none", filled: priority !== "none" }),
          import_react.default.createElement("span", { key: "v" }, `${t("priorityLabel")} \xB7 ${prioLabel}`)
        ]),
        flagOpen ? import_react.default.createElement("div", {
          key: "pop",
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
        }, flags.map((flag) => import_react.default.createElement("button", {
          key: flag.value,
          type: "button",
          className: "wt-chip",
          style: { color: flag.color, font: "inherit", fontSize: 11.5, cursor: "pointer", borderColor: priority === flag.value ? flag.color : void 0 },
          title: flag.label,
          onClick: () => {
            setPriority(flag.value);
            setFlagOpen(false);
          }
        }, [
          import_react.default.createElement(IconFlag, { key: "f", filled: priority === flag.value, dashed: flag.value === "none" }),
          import_react.default.createElement("span", { key: "v" }, flag.label)
        ]))) : null
      ])
    ])
  ]);
}
function TodoRow({ todo, today, t, onToggle, onRemove, onSave, drag }) {
  const [editing, setEditing] = import_react.default.useState(false);
  const [draft, setDraft] = import_react.default.useState(null);
  const [notesOpen, setNotesOpen] = import_react.default.useState(false);
  const [confirming, setConfirming] = import_react.default.useState(false);
  import_react.default.useEffect(() => {
    if (!confirming) return void 0;
    const id = setTimeout(() => setConfirming(false), 5e3);
    return () => clearTimeout(id);
  }, [confirming]);
  const row = todo ?? {};
  const done = row.status === "completed";
  const due = typeof row.due === "string" ? row.due : "";
  const overdue = !done && Boolean(due) && Boolean(today) && due < today;
  const beginEdit = () => {
    setDraft({
      title: typeof row.title === "string" ? row.title : "",
      due,
      priority: row.priority === "high" || row.priority === "low" ? row.priority : "normal",
      project: typeof row.project === "string" ? row.project : "",
      dueTime: typeof row.dueTime === "string" ? row.dueTime : "",
      notes: typeof row.notes === "string" ? row.notes : ""
    });
    setNotesOpen(Boolean(row.notes));
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setDraft(null);
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
    const priority = draft.priority || "normal";
    if (priority !== (row.priority ?? "normal")) patch.priority = priority;
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
        }, [
          import_react.default.createElement("option", { key: "high", value: "high" }, t("prioHigh")),
          import_react.default.createElement("option", { key: "normal", value: "normal" }, t("prioNormal")),
          import_react.default.createElement("option", { key: "low", value: "low" }, t("prioLow"))
        ])),
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
  if (due) {
    meta.push(import_react.default.createElement("span", {
      key: "d",
      style: { color: overdue ? C.warn : C.label3, fontSize: 11 }
    }, overdue ? `${t("overdueTag")} ${due}` : due));
  }
  if (row.project) {
    meta.push(import_react.default.createElement("span", { key: "j", className: "wt-tag" }, `#${row.project}`));
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
    style: drag.dragging ? { opacity: 0.45 } : void 0
  } : {};
  return import_react.default.createElement("div", { className: "wt-row", ...dragAttrs, style: row.priority === "high" ? { borderLeft: `2px solid ${C.error}`, paddingLeft: 8 } : void 0 }, [
    /* 优先级呈现（设计稿 v5）：高＝红色左缘 + 实心红旗；中＝琥珀；低＝灰；无＝什么都不显示 */
    row.priority && row.priority !== "none" ? import_react.default.createElement("span", {
      key: "prio-flag",
      title: row.priority === "high" ? t("prioHigh") : row.priority === "normal" ? t("prioNormal") : t("prioLow"),
      style: {
        display: "inline-flex",
        flex: "0 0 auto",
        color: row.priority === "high" ? C.error : row.priority === "normal" ? C.warn : C.label3
      }
    }, import_react.default.createElement(IconFlag, { filled: row.priority === "high" })) : null,
    import_react.default.createElement("button", {
      key: "check",
      type: "button",
      className: `wt-check${done ? " wt-check-done" : ""}`,
      "aria-label": done ? t("unmarkDone") : t("markDone"),
      title: done ? t("unmarkDone") : t("markDone"),
      onClick: () => {
        Promise.resolve(onToggle(row.id)).catch(() => {
        });
      }
    }, done ? import_react.default.createElement(IconCheck, { key: "i" }) : null),
    import_react.default.createElement("div", { key: "main", style: { flex: 1, minWidth: 0 } }, [
      import_react.default.createElement("div", {
        key: "title",
        className: "wt-title",
        title: t("editHint"),
        onClick: beginEdit,
        style: {
          color: done ? C.label3 : C.label,
          textDecoration: done ? "line-through" : "none",
          fontWeight: row.priority === "high" && !done ? 650 : 400
        }
      }, typeof row.title === "string" && row.title ? row.title : t("untitled")),
      meta.length ? import_react.default.createElement("div", {
        key: "meta",
        style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }
      }, meta) : null
    ]),
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
}
function Group({ label, items, meta, closed, t, today, onToggleOpen, onToggleTodo, onRemove, onSave, drag }) {
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
      drag: drag ? {
        dragging: drag.dragId === todo?.id,
        hint: drag.hint,
        onStart: drag.onStart,
        onOver: drag.onOver,
        onDrop: drag.onDrop,
        onEnd: drag.onEnd
      } : void 0
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
function WorkTodoPanel(props) {
  const t = typeof props?.t === "function" ? props.t : (key) => zh[key] ?? key;
  const [sort, setSortState] = import_react.default.useState(lastSort);
  const setSort = import_react.default.useCallback((next) => {
    lastSort = next;
    setSortState(next);
  }, []);
  const [dragId, setDragId] = import_react.default.useState(null);
  const { status, data, error, refresh } = useList(sort);
  const [barError, setBarError] = import_react.default.useState(null);
  const [dismissedReadError, setDismissedReadError] = import_react.default.useState(null);
  const readError = error && error !== dismissedReadError ? error : null;
  const shownError = barError ?? readError;
  const [notice, setNotice] = import_react.default.useState(null);
  const [pending, setPending] = import_react.default.useState(0);
  const [closed, setClosed] = import_react.default.useState({ completed: true });
  const [view, setView] = import_react.default.useState("due");
  const runWrite = import_react.default.useCallback(async (job) => {
    setPending((n) => n + 1);
    try {
      const data2 = await job();
      setBarError(null);
      return { ok: true, data: data2 ?? {} };
    } catch (writeError) {
      setBarError(String(writeError?.message ?? writeError));
      return { ok: false, data: {} };
    } finally {
      setPending((n) => Math.max(0, n - 1));
      refresh();
    }
  }, [refresh]);
  const handleAdd = import_react.default.useCallback((input) => {
    const title = String(input?.title ?? "").trim();
    if (!title) {
      setBarError(t("titleEmpty"));
      return Promise.resolve(false);
    }
    return runWrite(() => postJson("/create", {
      title,
      due: input?.due ? String(input.due) : null,
      priority: input?.priority ?? "normal"
    })).then((result) => result.ok);
  }, [runWrite, t]);
  const handleToggle = import_react.default.useCallback((ref) => runWrite(() => postJson("/status", { ref, toggle: true })), [runWrite]);
  const handleRemove = import_react.default.useCallback((ref) => runWrite(() => postJson("/remove", { ref })), [runWrite]);
  const handleSave = import_react.default.useCallback((ref, patch) => runWrite(() => postJson("/update", { ref, ...patch })), [runWrite]);
  const handleDropOn = import_react.default.useCallback((targetId) => {
    const dragging = dragId;
    setDragId(null);
    if (!dragging || !targetId || dragging === targetId) return Promise.resolve(false);
    const ids = asArray(data?.todos).map((todo) => todo?.id).filter(Boolean);
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
  const groups = data?.groups ?? {};
  const stats = data?.stats ?? {};
  const today = typeof data?.today === "string" && data.today ? data.today : localToday();
  const store = data?.store ?? null;
  const version = typeof data?.version === "string" ? data.version : "";
  const update = data?.update ?? null;
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
  return import_react.default.createElement("div", { className: "wt-root", style: rootStyle }, [
    import_react.default.createElement("style", { key: "css" }, STYLE_TEXT),
    /* 顶部：标题 + 统计 + 刷新 */
    import_react.default.createElement("div", {
      key: "head",
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
    import_react.default.createElement(QuickAdd, { key: "quick", t, busy: pending > 0, onAdd: handleAdd }),
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
      style: { marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border1}`, fontSize: 10.5, color: C.label3, lineHeight: 1.7 }
    }, [
      /* 角落信息：装了哪一版 + 有没有新版（一眼可见，不占主区） */
      import_react.default.createElement("div", {
        key: "ver",
        style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }
      }, [
        import_react.default.createElement("span", {
          key: "v",
          title: t("versionHint"),
          style: { color: C.label3 }
        }, `${t("versionLabel")} ${version ? `v${version}` : "\u2014"}`),
        update?.hasUpdate ? import_react.default.createElement("span", {
          key: "u",
          className: "wt-chip",
          style: { fontSize: 10, color: C.ok, borderColor: tint(C.ok, 50), background: tint(C.ok, 12) },
          title: `${t("updateHint")}\uFF1Adsh plugin --profile desktop add dsh-worktodo@${update.latest}`
        }, `${t("updateAvailable")} v${update.latest}`) : null
      ]),
      store && store.location ? import_react.default.createElement("div", {
        key: "store",
        title: `${t("storeAt")}\uFF1A${store.location}`,
        style: { wordBreak: "break-all" }
      }, `${t("storeAt")} \xB7 ${store.kind === "domain" ? t("storeDomain") : t("storeFile")} \xB7 ${store.location}`) : null
    ])
  ]);
}
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), `${LOCALE_NS}: dictionaries`);
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: SLOT_ID,
    order: 88,
    label: () => "\u5F85\u529E",
    locale: LOCALE_NS
  }, (props) => import_react.default.createElement(WorkTodoIcon, { size: props?.size ?? 16, active: props?.active })));
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: SLOT_ID,
    locale: LOCALE_NS
  }, WorkTodoPanel));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
