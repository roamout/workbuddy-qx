/**
 * WorkBuddy 签到信息面板 —— Surge Information Panel 数据源
 *
 * 作用：
 *   作为 Surge 首页信息面板（[Panel]）的脚本，在卡片上展示签到状态，
 *   点击卡片即可直接签到（含领旅行奖励），无需进脚本列表。
 *
 * 触发方式（通过 $trigger / $input.purpose 区分）：
 *   - 首次加载 / 点击右上角刷新：只读查询签到状态 + 真实余额，返回卡片
 *   - 点击卡片（button）：执行签到 + 领旅行奖励闭环，返回最新结果
 *
 * 返回结构（Surge Information Panel 规范）：
 *   $done({ title, content, icon, icon-color })
 *
 * 依赖：
 *   长效令牌存于 Surge $persistentStore（key=workbuddy_checkin_rt），
 *   由「WorkBuddy 令牌捕获」模块写入，本脚本只读 + 轮换回写。
 */

const VERSION = "v1.0.0";

// 与签到/捕获脚本共用同一把 key
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

// ============ 步骤3：查询真实余额 ============
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

// ============ 步骤4：执行签到 ============
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

// ============ 步骤5：旅行闭环 ============
async function travelFlow(token) {
  let travel = "";
  try {
    const sResp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
    const sData = parseBody(sResp);
    if (sData.code !== 0 || !sData.data) return "";
    const st = sData.data;

    if (st.state === "arrived") {
      await httpRequest(TRAVEL_CLAIM_URL, "POST", headersWithToken(token), "{}");
      const s2Resp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
      const s2Data = parseBody(s2Resp);
      if (s2Data.code === 0 && s2Data.data) {
        if (s2Data.data.state === "idle" && s2Data.data.daily_limit_reached !== true) {
          await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
            JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
          travel = "旅行奖励已领，已再出发";
        } else {
          travel = "旅行奖励已领";
        }
      }
      return travel;
    }
    if (st.state === "idle" && st.daily_limit_reached !== true) {
      await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
        JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
      travel = "Buddy 已出发";
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

    // 点击卡片 → 执行签到；刷新 → 只读
    if (isButton && !st.checked) {
      const ck = await doCheckin(token);
      if (ck.action === "checked") {
        // 签到成功后再查一次状态和余额
        const st2 = await getStatus(token);
        const travel = await travelFlow(token);
        if (ck.credit != null) await sleep(800);
        const bal = await getBalance(token);
        const balText = fmtBalance(bal);
        title = "✅ 签到成功 +" + (ck.credit != null ? ck.credit : "");
        content = "💰 余额 " + balText + "\n"
          + (st2.streak != null ? "📅 连签 " + st2.streak + " 天\n" : "")
          + (travel ? "🐱 " + travel : "");
        icon = "checkmark.circle.fill";
        iconColor = "#34c759";
      } else if (ck.action === "already") {
        const bal = await getBalance(token);
        const balText = fmtBalance(bal);
        title = "今日已签到";
        content = "💰 余额 " + balText + "\n" + (st.streak != null ? "📅 连签 " + st.streak + " 天" : "");
        icon = "checkmark.seal.fill";
        iconColor = "#34c759";
      } else {
        throw new Error("签到失败: " + ck.msg);
      }
    } else {
      // 只读：查状态 + 余额
      const bal = await getBalance(token);
      const balText = fmtBalance(bal);
      if (st.checked) {
        title = "今日已签到";
        content = "💰 余额 " + balText + "\n" + (st.streak != null ? "📅 连签 " + st.streak + " 天" : "");
        icon = "checkmark.seal.fill";
        iconColor = "#34c759";
      } else {
        const creditText = st.dailyCredit != null ? st.dailyCredit : "";
        title = "未签到，点击签到";
        content = "可领 " + creditText + " 积分\n"
          + (balText ? "💰 余额 " + balText : "")
          + (st.streak != null ? "\n📅 连签 " + st.streak + " 天" : "");
        icon = "circle.dashed";
        iconColor = "#ff9500";
      }
    }

    $done({ title: title, content: content, icon: icon, "icon-color": iconColor });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    $done({
      title: "WorkBuddy 签到",
      content: "⚠️ " + msg,
      icon: "exclamationmark.triangle.fill",
      "icon-color": "#ff3b30"
    });
  }
}

// 判断是否为「点击卡片」触发：
// 点击卡片时 $trigger === "button"；刷新/首次加载时 $trigger 为 "auto-interval" 或 undefined
const isButton = (typeof $trigger !== "undefined" && $trigger === "button");
run(isButton);
