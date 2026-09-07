# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

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
