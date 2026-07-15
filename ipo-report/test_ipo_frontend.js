// -*- coding: utf-8 -*-
// 前端 ipo.js 纯函数单元测试（无浏览器环境，用 vm 加载 + 桩函数）。
// 覆盖用户2026-07-15 改动：ipoFmt(nan守卫) / ipoShdRatioPct(股东配售率) /
//   ipoShdShares(配售10张股数) / ipoCurrentStage·ipoProgressDate·ipoAnnounced(方案进展/进展公告日)。
// 运行：node test_ipo_frontend.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const IPO_JS = path.join(__dirname, "..", "public", "js", "ipo.js");
const code = fs.readFileSync(IPO_JS, "utf8");

const noop = () => {};
const sandbox = {
  console,
  // 浏览器依赖桩（仅被函数体引用，加载不会触发）
  escapeHtml: (s) => String(s == null ? "" : s),
  api: () => "",
  showToast: noop,
  document: { getElementById: () => null, querySelectorAll: () => [] },
  window: {},
  fetch: () => Promise.resolve({ json: () => ({}) }),
  setTimeout,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log("  [PASS] " + name + (detail ? " " + detail : "")); }
  else { FAIL++; console.log("  [FAIL] " + name + (detail ? " " + detail : "")); }
}

console.log("== A. ipoFmt (NaN/空 守卫) ==");
check("null -> -", sandbox.ipoFmt(null) === "-");
check("undefined -> -", sandbox.ipoFmt(undefined) === "-");
check("空串 -> -", sandbox.ipoFmt("") === "-");
check("'nan' -> -", sandbox.ipoFmt("nan") === "-");
check("'NaN' -> -", sandbox.ipoFmt("NaN") === "-");
check("NaN(number) -> -", sandbox.ipoFmt(NaN) === "-");
check("正常数透传", sandbox.ipoFmt(500) === 500);
check("带单位", sandbox.ipoFmt(500, "亿") === "500亿");

console.log("== B. ipoShdRatioPct (股东配售率 = 总配售张数/(规模亿×1e6)×100%) ==");
// 浦发：shd_ration_size=263622080, issue_size=500 -> 52.72%
check("浦发 52.72%", sandbox.ipoShdRatioPct({ shd_ration_size: 263622080, issue_size: 500 }) === "52.72%",
      sandbox.ipoShdRatioPct({ shd_ration_size: 263622080, issue_size: 500 }));
check("缺 shd_ration_size -> -", sandbox.ipoShdRatioPct({ issue_size: 500 }) === "-");
check("issue_size=0 -> -", sandbox.ipoShdRatioPct({ shd_ration_size: 100, issue_size: 0 }) === "-");

console.log("== C. ipoShdShares (配售10张股数 = round(1000/每股配售)) ==");
check("浦发 587", sandbox.ipoShdShares({ shd_ration_ratio: 1.703 }) === "587",
      sandbox.ipoShdShares({ shd_ration_ratio: 1.703 }));
check("每股配售=0 -> -", sandbox.ipoShdShares({ shd_ration_ratio: 0 }) === "-");
check("缺失 -> -", sandbox.ipoShdShares({}) === "-");

console.log("== D. 方案进展 / 进展公告日（绝不用未来发行结果公告日） ==");
// 今日 2026-07-15
const today = "2026-07-15";
sandbox._ipoTodayStr = () => today;

// D1 已上市 -> 上市日
let it1 = { listing_date: "2026-07-10" };
check("已上市->上市日", sandbox.ipoCurrentStage(it1).indexOf("上市日") >= 0);
check("已上市->日期", sandbox.ipoProgressDate(it1) === "2026-07-10");

// D2 申购日=今天 -> 申购日
let it2 = { onl_date: "2026-07-15", ann_date: "2026-07-14" };
check("申购日=今天->申购日", sandbox.ipoCurrentStage(it2).indexOf("申购日") >= 0);

// D3 申购日未来 + 发行公告日存在 -> 发行公告日（非申购日、非结果公告日）
let it3 = { onl_date: "2026-07-17", ann_date: "2026-07-15" };
check("申购日未来->发行公告", sandbox.ipoCurrentStage(it3).indexOf("发行公告") >= 0);
check("进展公告日=发行公告日(非未来)", sandbox.ipoProgressDate(it3) === "2026-07-15");

// D4 关键回归：res_ann_date 是未来(7/21)但 onl_date=今天 -> 必须显示 申购日，不得显示发行结果公告日
let it4 = { onl_date: "2026-07-15", res_ann_date: "2026-07-21" };
check("res_ann_date未来不污染进展", sandbox.ipoCurrentStage(it4).indexOf("发行结果公告") === -1);
check("res_ann_date未来->申购日", sandbox.ipoCurrentStage(it4).indexOf("申购日") >= 0);

// D5 发行结果公告已出(<=今天) -> ipoAnnounced=true；未来 -> false
check("结果公告已出=true", sandbox.ipoAnnounced({ res_ann_date: "2026-07-15" }) === true);
check("结果公告未来=false", sandbox.ipoAnnounced({ res_ann_date: "2026-07-21" }) === false);
check("无结果公告=false", sandbox.ipoAnnounced({}) === false);

console.log("\n===== 前端结果汇总 =====");
console.log("PASS=%d  FAIL=%d", PASS, FAIL);
console.log(FAIL === 0 ? "OK" : "HAS_ISSUES");
process.exit(FAIL === 0 ? 0 : 1);
