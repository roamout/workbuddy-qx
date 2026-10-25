# WorkBuddy 每日自动签到（Quantumult X）

腾讯 WorkBuddy（CodeBuddy）「Buddy 加油站」自动签到脚本：打开 App / 小程序登录一次，重写脚本自动捕获长效令牌；之后每日由定时任务自动完成签到、领取 Buddy 旅行奖励、播报真实积分余额，长效令牌自动滚动续期，无需再管。

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

国内网络访问 GitHub raw 不畅时，用 jsDelivr 镜像：

```
https://cdn.jsdelivr.net/gh/roamout/workbuddy-qx@main/workbuddy.qx.conf
```

保存后确认：① 该订阅已启用；② 设置 → MITM 已开启并已安装、信任证书（首次抓 HTTPS 必须）。订阅自带 `[mitm]` 主机名，会自动合并。

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
| `workbuddy_capture_token.js` | 重写脚本（一次性） | 拦截登录/刷新请求，捕获 `refresh_token` 存入本地 |
| `workbuddy_checkin.js` | 定时任务（长期运行） | 签到、领旅行奖励、查余额、令牌滚动续期 |
| `workbuddy.qx.conf` | 重写订阅配置 | 含重写规则与 MITM 主机名 |

## 高级：手动填写令牌

不想用重写捕获，也可以手动获取令牌后填入 `workbuddy_checkin.js` 顶部的 `MANUAL_REFRESH_TOKEN`：

- 电脑登录 WorkBuddy 客户端后，打开登录态文件：
  - Windows：`%LOCALAPPDATA%\codebuddyextension\data\public\auth\workbuddy-desktop.info`
  - macOS：`~/Library/Application Support/codebuddyextension/data/public/auth/workbuddy-desktop.info`
- 提取其中 `auth.refreshToken` 字段（约 700 字符的 JWT）

注意：手动填入的令牌优先级**低于**捕获脚本写入的本地存储；如需使用手动令牌，请先清除 QX 本地存储里的 `workbuddy_checkin_rt`。

## 常见问题

**Q：收不到捕获成功通知？**
- 确认 MITM 证书已安装且在系统设置中「信任」
- 确认重写订阅已启用，QX 主界面连接状态正常
- 杀掉 App 彻底重进；小程序抓不到就换 App（部分版本小程序对证书有校验）
- 仍不行可在 QX 日志里查看 `WorkBuddyCapture` 输出

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
