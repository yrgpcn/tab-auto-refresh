# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [tab-auto-refresh 1.4.3] - 2026-09-09

### Fixed
- 修复关闭浏览器后任务全部丢失：窗口整体关闭（含退出浏览器）不再触发自动重开与误清理，启动时把任务重新挂接到恢复的标签页，找不回则自动重新打开
- 弹窗打开提速：清理失效任务改为后台异步执行，不再等待后台冷启动，首屏即时渲染

## [tab-auto-refresh 1.4.2] - 2026-09-09

### Fixed
- Cookie 备份按站点独立存储，多个任务并发备份不再互相覆盖
- 备份覆盖父域 cookie（如 `.gov.cn` 级 SSO 登录票据），修复部分政务网站重启后无法恢复登录
- 恢复 cookie 后立即重载受监控的标签页，登录态即刻生效，不再等到下个刷新周期
- 自动重开使用的网址会在页面加载后更新，避免重新打开时停留在登录页

## [tab-auto-refresh 1.4.1] - 2026-09-09

### Fixed
- 修复弹窗任务列表重复渲染：开始任务后同一任务可能出现两行相同条目
- Cookie 备份时机修正：开启任务时立即备份一次，避免首次刷新前关闭浏览器导致无备份可恢复

## [tab-auto-refresh 1.4.0] - 2026-09-09

### Added
- 误关闭标签页自动重开：定时刷新中的标签页被关闭时，自动在后台重新打开并继续刷新
- Cookie 备份与恢复：每次刷新前备份域名 cookie，浏览器重启后自动恢复登录状态
- 新增 `cookies` 权限和 `<all_urls>` 主机权限，用于 cookie 备份恢复功能

### Fixed
- 修复关闭浏览器后残留幽灵任务的 bug：prune() 函数添加延迟等待标签页恢复

## [tab-auto-refresh 1.3.0] - 2026-09-07

### Added
- tab-auto-refresh 快捷键启动任务时使用最近一次成功设置的间隔（默认仍为 5 分钟）

### Changed
- Release zip 增加顶层 `tab-auto-refresh/` 目录，解压后可直接选择文件夹加载

### Fixed
- tab-auto-refresh 快捷键描述改为中英文语言包文案

## [tab-auto-refresh 1.2.0] - 2026-09-07

### Added
- 全局暂停 / 恢复：弹窗一键暂停全部任务，角标显示暂停状态；暂停期间不触发刷新，恢复后按原周期继续
- 页面右键菜单：在网页任意位置右键即可设置定时刷新（此前仅支持标签页右键）
- 键盘快捷键 `Alt+Shift+R`：开关当前标签页的定时刷新
- 「跳过已丢弃标签页」选项：开启后休眠标签页不会被自动刷新唤醒
- 英文界面（`_locales/en`），中英文完整支持
- 仓库级校验脚本与单元测试（`scripts/validate.mjs`、`tests/`），CI 质量门禁
- MIT LICENSE

### Changed
- 偏好设置（忽略缓存、跳过已丢弃）迁移到 `chrome.storage.sync` 多设备同步；旧本地设置自动迁移，任务等状态仍存 `chrome.storage.local`
- 手动开始新任务会自动解除全局暂停
- 提取纯逻辑到 `shared/logic.js`（间隔兜底、间隔与倒计时格式化），后台与弹窗共用

### Fixed
- 工具栏图标 `default_title` 改用国际化名称 `__MSG_extName__`

## [tab-auto-refresh 1.1.0] - 2026-09-07

### Added
- 任务写锁（`withTaskLock`），防止弹窗 / 右键菜单 / 定时器并发读写任务列表
- 弹窗每秒同步 alarm 列表，倒计时归零后继续滚动
- 任务失效时自动取消并通过 `chrome.notifications` 通知
- 自定义间隔小于 30 秒时给出明确提示
- favicon 为空时隐藏占位图标
- 国际化骨架（`chrome.i18n`，中文文案迁入 `_locales/zh_CN`）
- tag 驱动的自动发布工作流与项目记忆文档 `AGENTS.md`

### Changed
- `shared/config.js` 统一管理前缀与预设间隔，后台和弹窗共用
- service worker 改为 ES module
- `minimum_chrome_version` 设为 120

## [tab-auto-refresh 1.0.0] - 2026-09-07

### Added
- 首个版本：预设与自定义间隔、忽略缓存刷新、任务列表与倒计时、右键菜单、立即刷新、持久化与自动清理、角标计数
