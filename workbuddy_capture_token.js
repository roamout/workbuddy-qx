/**
 * WorkBuddy 令牌捕获脚本 —— Quantumult X 重写脚本（一次性使用）
 *
 * 作用：
 *   在手机上正常登录 / 使用 WorkBuddy App 或微信小程序时，自动拦截登录、
 *   令牌刷新请求，把长效令牌 refresh_token 抓取下来写入 QX 本地存储，
 *   供 workbuddy_checkin.js 每日签到使用。
 *
 * 提取方式（双保险）：
 *   1. 精确提取：响应 JSON 里的 refreshToken / refresh_token 字段
 *   2. 特征扫描：在任意 JSON 中寻找 typ=Offline 的 JWT（长效令牌的强特征）
 *
 * 通知策略：
 *   只在“首次捕获”或“令牌发生轮换更新”时弹一次通知；令牌没有变化时
 *   完全静默，不重复打扰。
 *
 * 用法建议：
 *   看到“捕获成功”通知后，即可在 QX 中停用或删除本重写。忘记关闭也没关系：
 *   脚本只读取令牌、不发起任何请求，会在 App 令牌轮换时自动同步最新值。
 *
 * 抓不到时排查：
 *   打开 QX「风车 → 日志」，在 WorkBuddy 里重新登录，观察：
 *   - 有没有出现 copilot.tencent.com / workbuddy.cn / codebuddy.cn 的请求
 *   - 有没有 [WorkBuddyCapture] 开头的日志
 *   据此判断是重写没生效、证书没信任，还是域名不在规则内
 *
 * 部署（完整订阅见 workbuddy.qx.conf）
 */

const VERSION = "v1.2.0";

// 与签到脚本共用同一把 key
const PREF_KEY_RT = "workbuddy_checkin_rt";

// ============ 工具函数 ============
function isJwt(v) {
  return typeof v === "string"
    && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)
    && v.length > 100;
}

// 解 JWT payload（用于识别 Offline 长效令牌）
function decodeJwtPayload(token) {
  try {
    let p = token.split(".")[1];
    if (!p) return null;
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    while (p.length % 4) p += "=";
    const raw = (typeof atob === "function")
      ? atob(p)
      : (function () {
          // 无 atob 时的兜底解码
          const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          let out = "";
          for (let i = 0; i < p.length; i += 4) {
            const n = (chars.indexOf(p[i]) << 18) | (chars.indexOf(p[i + 1]) << 12)
              | ((p[i + 2] ? chars.indexOf(p[i + 2]) : 0) << 6)
              | (p[i + 3] ? chars.indexOf(p[i + 3]) : 0);
            out += String.fromCharCode((n >> 16) & 255, (n >> 8) & 255, n & 255);
          }
          return out;
        })();
    const json = decodeURIComponent(escape(raw));
    return JSON.parse(json);
  } catch (e) { return null; }
}

// 是否为长效（Offline / refresh）令牌
function isOfflineToken(token) {
  if (!isJwt(token)) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (payload.typ && /offline/i.test(String(payload.typ))) return true;
  if (payload.scope && /offline_access/.test(payload.scope)
      && !(payload.token_type && /bearer/i.test(String(payload.token_type)))) return true;
  return false;
}

function walkStrings(obj, depth, fn) {
  if (depth > 8 || obj === null || obj === undefined) return;
  if (typeof obj === "string") { fn(obj); return; }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkStrings(obj[i], depth + 1, fn);
    return;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) walkStrings(obj[keys[i]], depth + 1, fn);
  }
}

// 精确字段提取
function findByFieldName(obj, depth) {
  if (depth > 8 || obj === null || obj === undefined) return null;
  if (typeof obj === "string") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findByFieldName(obj[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i].toLowerCase();
      const v = obj[keys[i]];
      if (typeof v === "string"
          && (k === "refreshtoken" || k === "refresh_token" || k === "refresh_token_str")) {
        if (isJwt(v)) return v;
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const hit = findByFieldName(obj[keys[i]], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// 从任意字符串里提取「typ=Offline」的长效 JWT（微信 OAuth 登录时 token 字段名
// 可能是 access_token / id_token / credential 等，或藏在 redirect 的 fragment 里）
function extractOfflineJwtFromString(s) {
  if (typeof s !== "string") return null;
  // 匹配 JWT：eyJ 开头，两段点分隔，长度足够
  const re = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (isOfflineToken(t)) return t;
  }
  return null;
}

// 从响应头（Set-Cookie / Location 等）里找长效令牌
function extractFromHeaders(headers) {
  if (!headers) return null;
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    const v = headers[keys[i]];
    if (typeof v !== "string") continue;
    const hit = extractOfflineJwtFromString(v);
    if (hit) return hit;
    // 有些 Set-Cookie 值里直接是 token 片段，也扫一遍普通 JWT（放宽为任意 JWT，
    // 只要像 refresh token 形态就抓，交由签到脚本刷新接口校验有效性）
    if (/refresh|token|auth/i.test(keys[i])) {
      const re = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
      let m;
      while ((m = re.exec(v)) !== null) {
        if (isJwt(m[0])) return m[0];
      }
    }
  }
  return null;
}

// 特征扫描：找 typ=Offline 的 JWT
function findByOfflineFeature(obj) {
  let found = null;
  walkStrings(obj, 0, function (s) {
    if (found) return;
    if (isOfflineToken(s)) found = s;
  });
  return found;
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
  if (body.length > 2000000) return null;   // 超大响应（流式/文件）不处理
  try { return JSON.parse(body); } catch (e) { return null; }
}

// 诊断探针：响应含 refresh 字样但没提取到时，留一条日志便于排查
function logProbe(url, rawBody) {
  try {
    if (typeof rawBody !== "string" || rawBody.length === 0) return;
    if (/refresh/i.test(rawBody)) {
      const hasJwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(rawBody);
      console.log("[WorkBuddyCapture] probe " + url + " hasRefreshText jwt=" + hasJwt + " len=" + rawBody.length);
    }
  } catch (e) {}
}

// ============ 核心：保存令牌 ============
function saveToken(rt, source) {
  if (!isJwt(rt)) return false;

  const old = prefGet(PREF_KEY_RT);
  if (old === rt) return true;   // 同一个令牌，不重复通知

  prefSet(PREF_KEY_RT, rt);
  console.log("[WorkBuddyCapture] refresh token saved from " + source);

  if (!old) {
    notify(
      "✅ WorkBuddy 令牌捕获成功",
      "签到脚本已就绪，建议关闭本重写",
      "长效令牌已自动保存（来源：" + source + "）。\n"
      + "现在可以回 QX「重写」停用或删除 WorkBuddy 捕获规则，只保留每日签到定时任务。\n"
      + "忘记关闭也没关系：脚本只读取令牌，App 轮换时会自动同步最新值。"
    );
  } else {
    notify(
      "🔄 WorkBuddy 令牌已自动更新",
      "检测到令牌轮换，已同步最新值",
      "来源：" + source + "。签到脚本将继续使用最新令牌。"
    );
  }
  return true;
}

// ============ 入口：同时兼容请求头 / 响应体两种绑定 ============
(function () {
  try {
    const reqUrl = (typeof $request !== "undefined" && $request && $request.url) ? $request.url : "";

    // —— 响应体阶段 ——
    if (typeof $response !== "undefined" && $response) {
      const json = safeParse($response.body);
      if (json) {
        // 1) 精确字段 2) Offline 特征兜底（递归扫对象） 3) 原始字符串正则兜底
        let rt = findByFieldName(json, 0)
          || findByOfflineFeature(json)
          || extractOfflineJwtFromString(
              typeof $response.body === "string" ? $response.body : JSON.stringify($response.body));
        if (rt) { saveToken(rt, "响应体"); $done({}); return; }
      } else if (typeof $response.body === "string") {
        // 非 JSON 响应（如 OAuth 302 的 Location / 文本），直接从字符串扫
        const rt = extractOfflineJwtFromString($response.body);
        if (rt) { saveToken(rt, "响应文本"); $done({}); return; }
      }
      // 响应头里也可能带（Set-Cookie / Location）
      const rtHdr = extractFromHeaders($response.headers);
      if (rtHdr) { saveToken(rtHdr, "响应头"); $done({}); return; }

      logProbe(reqUrl, $response.body);
      $done({});
      return;
    }

    // —— 请求头阶段：刷新接口 X-Refresh-Token / Authorization ——
    if (typeof $request !== "undefined" && $request) {
      let rt = getHeaderCI($request.headers, "X-Refresh-Token");
      if (!rt) {
        const auth = getHeaderCI($request.headers, "Authorization");
        if (auth && /bearer\s+/i.test(auth)) {
          const candidate = auth.replace(/^bearer\s+/i, "").trim();
          // 只有像 JWT 才收；否则继续扫其它头
          if (isJwt(candidate)) rt = candidate;
        }
      }
      if (rt && isJwt(rt)) { saveToken(rt, "刷新请求头"); $done({}); return; }

      // 兜底：扫全部请求头里的 JWT
      const rtHdr = extractFromHeaders($request.headers);
      if (rtHdr) { saveToken(rtHdr, "请求头"); $done({}); return; }

      $done({});
      return;
    }

    $done({});
  } catch (e) {
    console.log("[WorkBuddyCapture] error: " + (e && e.message ? e.message : e));
    $done({});
  }
})();
