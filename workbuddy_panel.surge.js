/**
 * WorkBuddy 签到信息面板 —— Surge Information Panel 数据源
 *
 * 作用：
 *   作为 Surge 首页信息面板（[Panel]）的脚本，在卡片上展示签到状态、
 *   连签天数、真实余额、Buddy 旅行状态等完整信息（对齐签到通知的播报内容）。
 *   点击卡片直接签到 + 领旅行奖励；点右上角刷新查看最新状态。
 *
 * 触发方式（通过 $trigger 区分）：
 *   - 首次加载 / 刷新：只读查询签到状态 + 旅行状态 + 真实余额，返回卡片
 *   - 点击卡片（button）：执行签到 + 领旅行奖励闭环，返回最新结果
 *
 * 依赖：
 *   长效令牌存于 Surge $persistentStore（key=workbuddy_checkin_rt），
 *   由「WorkBuddy 令牌捕获」模块写入，本脚本只读 + 轮换回写。
 */

const VERSION = "v1.1.0";

const PREF_KEY_RT = "workbuddy_checkin_rt";

// ============ 接口常量（与 workbuddy_checkin.surge.js 保持一致） ============
const REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
const CHECKIN_DOMAIN = "https://www.codebuddy.cn";
const STATUS_URL = CHECKIN_DOMAIN + "/v2/billing/meter/checkin-activity-status";
const CHECKIN_URL = CHECKIN_DOMAIN + "/v2/billing/meter/daily-checkin";
const BALANCE_URL = CHECKIN_DOMAIN + "/billing/meter/get-user-resource-summary";
const TRAVEL_DOMAIN = "https://www.workbuddy.cn";
const TRAVEL_STATUS_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/status";
const TRAVEL_CLAIM_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/claim";
const TRAVEL_DEPART_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/depart";

const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// ============ 工具：持久化存储 ============
function getRt() {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore && $persistentStore.read) {
      const v = $persistentStore.read(PREF_KEY_RT);
      if (v && v.length > 20) return v;
    }
  } catch (e) {}
  return "";
}

function saveRt(rt) {
  if (!rt || rt.length < 20) return;
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore && $persistentStore.write) {
      $persistentStore.write(rt, PREF_KEY_RT);
    }
  } catch (e) {}
}

// ============ 工具：HTTP 请求 ============
function httpRequest(url, method, headers, body) {
  return new Promise(function (resolve, reject) {
    const opts = { url: url, method: method, headers: headers, body: body };
    $httpClient[method.toLowerCase() === "post" ? "post" : "get"](opts, function (error, response, data) {
      if (error) { reject(new Error("HTTP 请求失败: " + error)); return; }
      resolve({ status: response.status, body: data });
    });
  });
}

function parseBody(resp) {
  let body = resp && resp.body;
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch (e) { return {}; }
}

function headersWithToken(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Authorization": "Bearer " + token,
    "User-Agent": USER_AGENT
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ============ 步骤1：刷新令牌 ============
async function refreshToken() {
  const rt = getRt();
  if (!rt || rt.length < 20) {
    throw new Error("尚未获取令牌，请先装「令牌捕获」模块登录一次");
  }
  const resp = await httpRequest(REFRESH_URL, "POST", {
    "Content-Type": "application/json",
    "X-Refresh-Token": rt,
    "X-Auth-Refresh-Source": "plugin",
    "X-Domain": "copilot.tencent.com"
  }, "{}");
  const data = parseBody(resp);
  if (data.code !== 0 || !data.data || !data.data.accessToken) {
    throw new Error("令牌刷新失败，请重新捕获令牌");
  }
  if (data.data.refreshToken) saveRt(data.data.refreshToken);
  return data.data.accessToken;
}

// ============ 步骤2：查签到状态 ============
async function getStatus(token) {
  const resp = await httpRequest(STATUS_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0 && data.data) {
    const d = data.data;
    return {
      checked: d.today_checked_in === true,
      streak: d.streak_days != null ? d.streak_days : null,
      dailyCredit: d.daily_credit != null ? d.daily_credit : null
    };
  }
  if (String(data.code) === "10001") {
    return { checked: true, streak: null, dailyCredit: null };
  }
  return { checked: false, streak: null, dailyCredit: null };
}

// ============ 步骤3：查旅行状态（只读） ============
async function getTravel(token) {
  try {
    const resp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
    const data = parseBody(resp);
    if (data.code === 0 && data.data) {
      return data.data;  // state / daily_limit_reached / reward_credit / arrive_at / location 等
    }
  } catch (e) {}
  return null;
}

// ============ 步骤4：查询真实余额 ============
async function getBalance(token) {
  try {
    const resp = await httpRequest(BALANCE_URL, "POST", headersWithToken(token), "{}");
    const data = parseBody(resp);
    if (data && data.code === 0 && data.data) {
      const v = data.data.TotalCredits;
      if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
    }
  } catch (e) {}
  return null;
}

// ============ 步骤5：执行签到 ============
async function doCheckin(token) {
  const resp = await httpRequest(CHECKIN_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0) {
    const dd = data.data || {};
    return { action: "checked", credit: dd.credit != null ? dd.credit : null, streak: dd.streak_days != null ? dd.streak_days : null };
  }
  if (String(data.code) === "10001" || /已签到/.test(data.msg || data.message || "")) {
    return { action: "already", credit: null, streak: null };
  }
  return { action: "error", msg: data.msg || data.message || data.code };
}

// ============ 步骤6：旅行闭环（领取 + 派出） ============
async function travelFlow(token) {
  let travel = "";
  try {
    const st = await getTravel(token);
    if (!st) return "";

    if (st.state === "arrived") {
      await httpRequest(TRAVEL_CLAIM_URL, "POST", headersWithToken(token), "{}");
      const st2 = await getTravel(token);
      if (st2) {
        if (st2.state === "idle" && st2.daily_limit_reached !== true) {
          await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
            JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
          travel = "旅行奖励已领取，已再次出发";
        } else {
          travel = "旅行奖励已领取";
        }
      }
      return travel;
    }
    if (st.state === "idle" && st.daily_limit_reached !== true) {
      await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
        JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
      travel = "Buddy 已出发旅行";
      return travel;
    }
    if (st.state === "traveling") { travel = "旅行中"; return travel; }
    travel = "今日旅行次数已用完";
  } catch (e) {
    travel = "";
  }
  return travel;
}

// ============ 格式化 ============
function fmtBalance(v) {
  if (v == null || isNaN(v)) return "";
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// ============ 主流程 ============
async function run(isButton) {
  let title, content, icon, iconColor;

  try {
    const token = await refreshToken();
    const st = await getStatus(token);

    if (isButton && !st.checked) {
      // 点击卡片 → 执行签到
      const ck = await doCheckin(token);
      if (ck.action === "checked") {
        const st2 = await getStatus(token);
        const travel = await travelFlow(token);
        if (ck.credit != null) await sleep(800);
        const bal = await getBalance(token);
        const balText = fmtBalance(bal);

        const parts = [];
        parts.push("+ " + (ck.credit != null ? ck.credit : "") + " 积分");
        if (st2.streak != null) parts.push("连签 " + st2.streak + " 天");
        if (balText) parts.push("余额 " + balText);

        title = "WorkBuddy 签到成功";
        content = parts.join(" · ");
        icon = "sparkles";
        iconColor = "#0a6cff";
      } else if (ck.action === "already") {
        const bal = await getBalance(token);
        const balText = fmtBalance(bal);

        const parts = [];
        if (st.streak != null) parts.push("连签 " + st.streak + " 天");
        if (balText) parts.push("余额 " + balText);

        title = "WorkBuddy 已签到";
        content = parts.join(" · ") || "今日已签到";
        icon = "sparkles";
        iconColor = "#0a6cff";
      } else {
        throw new Error("签到失败: " + ck.msg);
      }
    } else {
      // 只读：查状态 + 余额（精简为一行）
      const bal = await getBalance(token);
      const balText = fmtBalance(bal);

      const parts = [];
      if (!st.checked && st.dailyCredit != null) parts.push("可领 " + st.dailyCredit);
      if (st.streak != null) parts.push("连签 " + st.streak + " 天");
      if (balText) parts.push("余额 " + balText);

      if (st.checked) {
        title = "WorkBuddy 已签到";
        content = parts.join(" · ") || "今日已签到";
        iconColor = "#0a6cff";
      } else {
        title = "WorkBuddy 未签到";
        content = parts.join(" · ") || "点击卡片签到";
        iconColor = "#ff9500";
      }
      icon = "sparkles";
    }

    $done({ title: title, content: content, icon: icon, "icon-color": iconColor });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    $done({
      title: "WorkBuddy 签到",
      content: "⚠️ " + msg,
      icon: "sparkles",
      "icon-color": "#ff3b30"
    });
  }
}

const isButton = (typeof $trigger !== "undefined" && $trigger === "button");
run(isButton);
