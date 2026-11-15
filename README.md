# WorkBuddy 每日自动签到（Quantumult X / Surge）

腾讯 WorkBuddy（CodeBuddy）「Buddy 加油站」自动签到脚本：打开 App / 小程序登录一次，重写脚本自动捕获长效令牌；之后每日由定时任务自动完成签到、领取 Buddy 旅行奖励、播报真实积分余额，长效令牌自动滚动续期，无需再管。

> 同时支持 **Quantumult X** 与 **Surge** 两套代理软件，脚本逻辑一致，仅底层 API 不同（QX 用 `$task.fetch`/`$prefs`，Surge 用 `$httpClient`/`$persistentStore`）。

## 功能

- **一键捕获令牌**：重写脚本自动抓取登录 / 刷新请求中的 `refresh_token`，无需手动翻文件
- **每日自动签到**：每日 +100 积分，第 7 天 +1000，重复运行幂等（已签到自动跳过）
- **Buddy 旅行闭环**：自动领取到达奖励、再次派出旅行
- **真实积分余额**：全部领取完成后再查账户资源汇总，通知里显示真实可用积分（不是赛季累计数字）
- **令牌自动续期**：每次运行自动把轮换出的新令牌回写本地，正常情况下长期有效
- **智能通知**：只在首次捕获或令牌轮换更新时通知，令牌相同完全静默，不重复打扰

## 工作原理

```
登录一次（手动）                 每日自动（无需干预）
┌─────────────────────┐      ┌──────────────────────────────┐
│ WorkBuddy App / 小程序 │      │ 定时任务 workbuddy_checkin.js │
│   登录 / 刷新令牌      │      │  1. refresh_token 换新令牌    │
│         ↓ QX 重写拦截  │      │  2. 查状态 → 未签则签到       │
│  workbuddy_capture    │ ───→ │  3. 领旅行奖励 / 派出 Buddy    │
│  令牌存入本地存储      │ 令牌  │  4. 查真实积分余额并通知       │
│  （随后可停用该重写）   │      │  5. 新令牌回写，滚动续期       │
└─────────────────────┘      └──────────────────────────────┘
```

> 受短信验证码、微信授权登录限制，任何脚本都无法代替你完成**首次登录**；只需登录这一次。`refresh_token` 有效期约 60 天，每次签到都会自动刷新轮换，只要不退出账号、不连续超过 60 天不运行，就无需重新捕获。

## 部署步骤

### 第一步：订阅令牌捕获重写

打开 Quantumult X → 底部「风车」→ 重写 → 右上角 `+` → 选择「类型」为 **重写订阅**，粘贴以下链接：

```
https://raw.githubusercontent.com/roamout/workbuddy-qx/main/workbuddy.qx.conf
```

**国内网络推荐用 jsDelivr CDN 版**（订阅和内部脚本都走 CDN，不依赖 raw.githubusercontent.com，能避免"规则显示了但脚本下载失败"的问题）：

```
https://cdn.jsdelivr.net/gh/roamout/workbuddy-qx@main/workbuddy.cdn.conf
```

> 两个 conf 区别：`workbuddy.qx.conf` 内的脚本走 GitHub raw；`workbuddy.cdn.conf` 内的脚本走 jsDelivr。已经添加过 raw 版的，先删掉旧订阅再添加 CDN 版，避免规则重复。

保存后确认：① 该订阅已启用，展开后能看到 4 条规则；② 设置 → MITM 已开启并已安装、信任证书（首次抓 HTTPS 必须）。订阅自带 `[mitm]` 主机名，会自动合并。

### 第二步：登录一次，自动捕获令牌

1. 打开 **WorkBuddy App**（或微信 WorkBuddy 小程序）
2. 退出账号后**重新登录一次**；本来就登录着的，杀掉 App 重进、或下拉刷新页面，等它自动刷新令牌
3. 稍等片刻，收到通知「✅ WorkBuddy 令牌捕获成功」即完成

### 第三步：停用捕获重写，添加每日签到任务

1. 收到成功通知后，**回到 QX 重写订阅里停用（或删除）WorkBuddy 捕获订阅**——它只需要运行一次。忘记停用也没关系：脚本只读取令牌、不发起任何请求，令牌相同会静默，App 轮换时会自动同步最新值，只是偶尔会弹更新通知
2. 风车 → 定时任务 → 右上角 `+`，添加一条任务（每天 09:03，避开整点）：

```
3 9 * * * https://raw.githubusercontent.com/roamout/workbuddy-qx/main/workbuddy_checkin.js, tag=WorkBuddy签到, enabled=true
```

jsDelivr 镜像版：

```
3 9 * * * https://cdn.jsdelivr.net/gh/roamout/workbuddy-qx@main/workbuddy_checkin.js, tag=WorkBuddy签到, enabled=true
```

3. 可以先点一下该任务手动运行一次，收到签到通知即部署成功

## 文件说明

| 文件 | 类型 | 作用 |
| --- | --- | --- |
| `workbuddy_capture_token.js` | QX 重写脚本（一次性） | 拦截登录/刷新请求，捕获 `refresh_token` 存入本地 |
| `workbuddy_checkin.js` | QX 定时任务（长期运行） | 签到、领旅行奖励、查余额、令牌滚动续期 |
| `workbuddy.qx.conf` | QX 重写订阅配置（raw 版） | 含重写规则与 MITM 主机名，脚本走 GitHub raw |
| `workbuddy.cdn.conf` | QX 重写订阅配置（CDN 版，国内推荐） | 同上，脚本走 jsDelivr |
| `workbuddy_capture_token.surge.js` | Surge 重写脚本（一次性） | 同 capture，适配 Surge `$persistentStore`/`$notification` |
| `workbuddy_checkin.surge.js` | Surge 签到脚本（长期运行） | 同 checkin，适配 Surge `$httpClient`/`$persistentStore`；可作手动脚本（长按执行）或定时任务 |
| `workbuddy.sgmodule` | Surge 捕获模块 | 只含令牌捕获重写 + MITM，捕获成功后即可停用 |
| `workbuddy.checkin.sgmodule` | Surge 签到模块 | 只含手动 + 定时签到，无捕获重写 |

## Surge 部署步骤

Surge 版把「令牌捕获」和「签到」拆成了**两个独立模块**，可分别安装、分别开关：

- **捕获模块**（`workbuddy.sgmodule`，一次性）：只在首次登录 / 令牌失效时临时开启；
- **签到模块**（`workbuddy.checkin.sgmodule`，长期）：日常只保留这个，含手动 + 定时签到。

### 第一步：安装捕获模块，登录捕获令牌

打开 Surge → 首页「模块」→ 「安装新模块」，粘贴捕获模块链接：

```
https://raw.githubusercontent.com/roamout/workbuddy-qx/main/workbuddy.sgmodule
```

1. 打开 **WorkBuddy App**（或微信 WorkBuddy 小程序），退出账号重新登录一次
2. 收到通知「✅ WorkBuddy 令牌捕获成功」即完成

### 第二步：停用捕获模块，安装签到模块

1. 捕获成功后，回到「模块」里**停用（或删除）捕获模块**——它只需要运行一次
2. 安装签到模块：

```
https://raw.githubusercontent.com/roamout/workbuddy-qx/main/workbuddy.checkin.sgmodule
```

3. **手动签到**：Surge iOS 首页「脚本」卡片里长按 **「WorkBuddy签到(手动)」**，即可立即执行一次签到
4. **定时签到**：每天 09:03 自动运行，收到签到通知即部署成功

> 令牌随签到自动滚动续期，日常无需再开捕获模块。只有「退出账号」或「连续 60 天未签到」导致令牌失效时，才需要重新装回捕获模块、登录一次。

## Quantumult X 部署步骤

## 常见问题

**Q：收不到捕获成功通知？（按顺序排查）**
1. 重写订阅已启用，展开能看到 **多条规则**（v1.2.0 起已覆盖微信登录的腾讯身份认证域名）；旧订阅请删掉再重新添加（建议直接用 CDN 版）
2. MITM 证书已安装且在系统设置「通用 → 关于本机 → 证书信任设置」中信任
3. 打开 **QX 风车 → 日志**，保持在日志页，再去 WorkBuddy 退出账号重新登录：
   - 日志里完全没有 `copilot.tencent.com` / `workbuddy` / `codebuddy` / `cloud.tencent.com` 相关请求 → 该 App 流量没走 QX（换 App 或小程序再试）
   - 有请求但没有任何 `[WorkBuddyCapture]` 日志 → 脚本没下载成功，删掉订阅改用 **CDN 版** 重新添加
   - 有 `[WorkBuddyCapture] probe ...` 日志但没成功 → 把该日志截图反馈，需要补充域名
4. 杀掉 App 彻底重进；小程序抓不到就换 App（个别版本对证书有校验）

**Q：为什么只有「手机号登录」能抓到令牌，微信扫码/公众号登录抓不到？**
- 因为不同登录方式的鉴权请求走**不同的域名**：手机号/邮箱/SSO 登录全程在 `workbuddy.cn` 自己域名内签发令牌，被规则命中；而微信扫码登录会跳转到**腾讯身份认证域名**（`*.cloud.tencent.com` / `*.myqcloud.com` / `open.weixin.qq.com`）回跳并签发令牌，旧版规则没覆盖这些域名。
- v1.2.0 起已把这些微信登录域名纳入 MITM 与重写规则，微信登录现在也能捕获。**请删除旧订阅、重新添加（CDN 版），并确保 MITM 主机名已更新。**

**Q：手动填写令牌怎么做？**
- 可把令牌填入 `workbuddy_checkin.js` 顶部 `MANUAL_REFRESH_TOKEN`（需用本地脚本而非远程任务）
- 新版桌面客户端登录态文件（`workbuddy-desktop.info`）已加密（`$wbEncrypted` 信封），无法直接提取明文，重写捕获是最省事的方式

**Q：什么时候需要重新捕获？**
- 在 WorkBuddy 客户端里**退出了账号**；或长时间（超过 60 天）没有成功运行过签到
- 重新启用捕获重写 → 登录一次即可（无需清理任何本地存储，新令牌会自动覆盖）→ 再停用

**Q：通知提示「刷新令牌失败」？**
- 令牌已失效（见上一条），重新捕获一次即可
- 捕获重写本身只**读取**经过的令牌、不发起任何请求，不会造成令牌竞争；竞争一般来自多个客户端同时在线刷新，保持本地为最新令牌即可恢复（重开捕获重写等它同步一次）

**Q：签到积分显示准确吗？**
- 本次到账积分只取自接口真实返回（`data.data.credit`），不写死数字
- 余额来自 `get-user-resource-summary` 的 `TotalCredits`，且在所有领取动作完成后再查

## 安全与隐私

- 长效令牌等同于账号钥匙：脚本只把它存在你本机的 QX 本地存储中，**不向任何第三方服务器上传**
- 本仓库所有代码开源、无混淆，可自行审计；请勿把令牌截图、粘贴到任何公开场合
- 本项目仅供学习交流，账号相关数据归腾讯所有，请遵守服务条款，风险自负
