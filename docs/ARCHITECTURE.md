# 架构与长期约束

Tab Auto Refresh 是一个公开的 Chrome Manifest V3 扩展。Project Orchestrator 只负责项目协作与持久状态，不应借迁移之名改变产品行为。

## 项目形态

- 插件源码：`tab-auto-refresh/`；
- 测试：`tests/tab-auto-refresh/`；
- 仓库校验：`scripts/validate.mjs` 与相关提取/门禁脚本；
- README 截图：`docs/tab-auto-refresh/`；
- 仓库工具配置：根 `package.json`，`type: module`，无运行依赖；
- CI：`.github/workflows/ci.yml`；
- Tag 驱动发布：`.github/workflows/release.yml`；
- 当前 manifest 版本：2.1.0；最低 Chrome 120。

技术约束：Manifest V3 + 原生 JavaScript，无构建步骤、无 npm 运行依赖。

## 主要运行链路

### 任务调度与恢复

任务以标签页为中心，依赖 alarms、storage、tabs。浏览器重启后恢复原任务；无法接回原标签页时按记录 URL 重开。涉及“先读后写 / 跨异步步骤”的状态流，顺序判断优先抽成纯函数，由执行器负责副作用。

### 后台保活与静默心跳

- `keepAlive` 默认开启，向任务页顶层注入 `content/keepalive.js`，模拟用户活动以延缓按交互计时的会话过期；
- 注入必须先于配置推送；整次注入被站点拒绝时静默降级，不能阻塞任务主流程；
- 静默心跳默认每 4 分钟发送带 cookie、`cache: no-store` 的请求；Range 必须保持 CORS safelist 兼容形状；
- 保活脚本只注顶层；关键词/验证墙扫描才会按需要遍历 frame，避免对子框架放大活动流量。

### 会话检测与 cookie 备份

掉线检测分状态通道和行为通道：cookie 票据消失、登录页/重定向/401/403 分开取证并做连续样本确认。好备份不能被疑似掉线时的空状态覆盖。备份和部分凭据存于浏览器本地/同步存储，README 中的安全说明属于产品契约。

### 关键词与验证墙

- 关键词检测在页面上下文提取原始命中事实，后台负责链路生命周期与通知；
- allFrames 调用失败时允许退回顶层，不因单个不可访问 frame 让整页路径失效；
- 验证墙只基于标题、挑战域名和足够大的挑战 frame，不扫正文，避免把普通“验证码”文本当成墙；
- 错误页与验证墙确认阈值刻意分离，因为自愈成本不同。

### 通知外发

`notifyOut` 是 webhook / 微信外发总入口。对外页面 URL 统一裁为 `origin + pathname`：query/hash 可能含一次性令牌、邮箱、手机号，不得在下游调用点重新绕过这一裁剪。Webhook URL 本身也可能是凭据，不应写入日志或 Issue。

### 角标与 UI

角标是多事实聚合结果，优先级和状态表受测试门禁约束。弹窗设置、id/class、显隐、回填与后台设置 schema 必须跨文件同步，不能只改 UI 一端。

## 跨文件不变量

这些“同一个名字写在多个地方”的账最容易静默漂移；改动前必须找到对应门禁：

| 账本 | 主要门禁 / 约束 |
|---|---|
| i18n 键与占位符 | `validate-refs`、`i18n-indirection`；中英文键、源码引用与参数位数齐平 |
| 微信文案预算与教程 | `wechat-budget`、`wechat-copy`；字段长度、模板口径受平台限制 |
| storage 分区与 cookie schema | `storage-map`、`cookie-schema`；采集、恢复、夹具、说明一起改 |
| settings | `settings-map`、`popup-settings-sync`；默认值、保存载荷、popup、真实读写点齐平 |
| message 三段名 | `message-ledger`、`message-gate`；类型、请求载荷、应答字段一起改 |
| permissions | `permission-map`；manifest、文档、桩件 chrome 表面齐平 |
| popup id/class | `popup-repopulate`、`class-ledger`；HTML/CSS/JS 同步 |
| 验证墙特征 | `wall-list`；每条特征必须有唯一命中夹具，判定链同步 |
| 会话态键族 | `rt-lifecycle`；删除/复位不能重新散落手写数组 |
| badge | `badge-state`、`badge-facts`；事实聚合出口与优先级一起改 |
| 命令/菜单入口 | `entry-names`；commands、快捷键、菜单前缀、README、popup 最小值一致 |
| CI/release 账本 | `pipeline-ledger`；测试 glob、Node/setup-node、版本算术、tag/包前缀、步骤顺序与权限齐平 |

## 改法纪律

1. 需要共享异步状态的流程优先做纯决策函数 + 薄副作用执行器；
2. 权限与功能成对记账：新增权限和需要权限的功能要同步 CHANGELOG/说明/门禁，删功能同时审权限；
3. 改默认开关、阈值、间隔前，逐条列出“新用户默认”与“已有用户显式配置”的影响；
4. 新接口先确认测试桩件是否真的记录调用；只有“没发生”的负向断言不能证明路径跑到过；
5. `node --test` 找不到测试时可能仍返回 0，因此必须保留 pipeline-ledger 对 glob 的发现性验证。

## 许可证边界

本仓库 MIT。对没有许可证的 tab-reloader / staying_alive，以及 GPL-3.0 的 Keep-Alive-Pro，只能借鉴思想，不能复制代码字面。借鉴 MIT 项目片段时保留来源 URL 与版权声明。

## i18n 与版本发布

- 默认中文，同时维护 `_locales/zh_CN` 与 `_locales/en`；
- 新文案必须在源码中真正被引用，不能只加语言包键；
- 版本号只在 `tab-auto-refresh/manifest.json` 维护；
- 发布顺序：manifest + CHANGELOG → main → tag `tab-auto-refresh/vX.Y.Z` → push main/tag → release workflow；
- 打 tag / 推 tag 是发布动作，需要明确授权，不能从“有待发版改动”自动推导。

## 历史来源

2026-09-29 前，以上架构、细节与审计经验主要写在根 `AGENTS.md`。迁移基线提交 `0a2b28873113451fe7f4d4b265049c89aa9aac8a` 保留完整历史正文；本文件只保留未来仍需维护的长期约束。
