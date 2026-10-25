/**
 * WorkBuddy 令牌捕获脚本 —— Quantumult X 重写脚本（一次性使用）
 *
 * 作用：
 *   在手机上正常登录 / 使用 WorkBuddy App 或微信小程序时，自动拦截登录、
 *   令牌刷新请求，把长效令牌 refresh_token 抓取下来写入 QX 本地存储，
 *   供 workbuddy_checkin.js 每日签到使用。
 *
 * 通知策略：
 *   只在“首次捕获”或“令牌发生轮换更新”时弹一次通知；令牌没有变化时
 *   完全静默，不重复打扰。
 *
 * 用法建议：
 *   看到“捕获成功”通知后，即可在 QX 中停用或删除本重写，只保留每日定时
 *   任务（这是推荐用法）。如果忘记关闭也没关系：脚本只读取令牌、不发起
 *   任何请求，会在 App 令牌轮换时自动把最新令牌同步给签到脚本。
 *   将来令牌失效需要重新捕获时，重新启用本重写、登录一次即可，无需清理
 *   任何本地存储。
 *
 * 部署（[rewrite_local]，完整订阅见 workbuddy.qx.conf）：
 *   # 1) 刷新令牌接口：请求头里的 X-Refresh-Token（兜底）
 *   https:\/\/copilot\.tencent\.com\/v2\/plugin\/auth\/token\/refresh url script-request-header workbuddy_capture_token.js
 *   # 2) 令牌网关：响应体里登录/刷新返回的新 refreshToken（最准）
 *   ^https:\/\/copilot\.tencent\.com\/v2\/plugin\/auth\/ url script-response-body workbuddy_capture_token.js
 *   # 3) App / 小程序登录接口：Keycloak 风格登录响应里的 refresh_token
 *   ^https:\/\/[a-z.]*workbuddy\.(cn|com)\/auth\/ url script-response-body workbuddy_capture_token.js
 *   ^https:\/\/[a-z.]*codebuddy\.(cn|com)\/auth\/ url script-response-body workbuddy_capture_token.js
 *
 * [mitm]
 *   hostname = copilot.tencent.com, *.workbuddy.cn, *.workbuddy.com, *.codebuddy.cn, *.codebuddy.com
 *
 * 说明：受短信验证码 / 微信授权登录限制，任何脚本都无法代替你完成首次登录；
 *   只需手动登录这一次，之后签到脚本靠 refresh_token 自动滚动续期（约 60 天）。
 */

const VERSION = "v1.0.0";

// 与签到脚本共用同一把 key，抓到即可直接用
const PREF_KEY_RT = "workbuddy_checkin_rt";

// ============ 工具函数 ============
function isRefreshToken(v) {
  // refresh_token 是较长的 JWT（三段式，以 eyJ 开头），access_token 同样是 JWT
  // 但我们只按键名 refreshToken / refresh_token 提取，不会误存 access_token
  return typeof v === "string"
    && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)
    && v.length > 100;
}

// 在任意 JSON 对象中递归查找 refresh token
function findRefreshToken(obj, depth) {
  if (depth > 7 || obj === null || obj === undefined) return null;
  if (typeof obj === "string") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findRefreshToken(obj[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    // 先看本层有没有 refresh token 字段
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i].toLowerCase();
      const v = obj[keys[i]];
      if (typeof v === "string"
          && (k === "refreshtoken" || k === "refresh_token" || k === "refresh_token_str")) {
        if (isRefreshToken(v)) return v;
      }
    }
    // 再递归子层
    for (let i = 0; i < keys.length; i++) {
      const hit = findRefreshToken(obj[keys[i]], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// 大小写不敏感读取请求头
function getHeaderCI(headers, name) {
  if (!headers) return null;
  const target = String(name).toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === target) return headers[keys[i]];
  }
  return null;
}

function prefGet(key) {
  try {
    if (typeof $prefs !== "undefined" && $prefs && $prefs.valueForKey) {
      return $prefs.valueForKey(key);
    }
  } catch (e) {}
  return null;
}

function prefSet(key, value) {
  try {
    if (typeof $prefs !== "undefined" && $prefs && $prefs.setValueForKey) {
      $prefs.setValueForKey(value, key);
      return true;
    }
  } catch (e) {}
  return false;
}

function notify(title, subtitle, body) {
  try { if (typeof $notify === "function") $notify(title, subtitle, body); } catch (e) {}
}

function safeParse(body) {
  if (!body) return null;
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch (e) { return null; }
}

// ============ 核心：保存令牌 ============
// 令牌相同 → 静默；令牌更新（或首次捕获）→ 写入并通知一次
function saveToken(rt, source) {
  if (!isRefreshToken(rt)) return false;

  const old = prefGet(PREF_KEY_RT);
  if (old === rt) return true;   // 同一个令牌，不重复通知、不重复写入

  prefSet(PREF_KEY_RT, rt);
  console.log("[WorkBuddyCapture] refresh token saved from " + source);

  if (!old) {
    notify(
      "✅ WorkBuddy 令牌捕获成功",
      "签到脚本已就绪，建议关闭本重写",
      "长效令牌已自动保存（来源：" + source + "）。\n"
      + "现在可以回 QX「重写」停用或删除 WorkBuddy 捕获规则，只保留每日签到定时任务。\n"
      + "忘记关闭也没关系：脚本只读取令牌，App 轮换时会自动同步最新值；\n"
      + "将来令牌失效时，重新启用本重写、登录一次即可恢复。"
    );
  } else {
    notify(
      "🔄 WorkBuddy 令牌已自动更新",
      "检测到令牌轮换，已同步最新值",
      "来源：" + source + "。签到脚本将继续使用最新令牌。\n"
      + "如不想再收到此类通知，可停用本捕获重写。"
    );
  }
  return true;
}

// ============ 入口：同时兼容请求头 / 响应体两种绑定 ============
(function () {
  try {
    // —— 响应体阶段：登录响应 / 刷新响应里的新令牌（优先级最高）——
    if (typeof $response !== "undefined" && $response) {
      const json = safeParse($response.body);
      if (json) {
        const rt = findRefreshToken(json, 0);
        if (rt) { saveToken(rt, "登录/刷新响应"); $done({}); return; }
      }
      $done({});
      return;
    }

    // —— 请求头阶段：刷新接口 X-Refresh-Token（兜底）——
    if (typeof $request !== "undefined" && $request) {
      const rt = getHeaderCI($request.headers, "X-Refresh-Token");
      if (rt) { saveToken(rt, "刷新请求头"); $done({}); return; }
      $done({});
      return;
    }

    $done({});
  } catch (e) {
    console.log("[WorkBuddyCapture] error: " + (e && e.message ? e.message : e));
    $done({});
  }
})();
