# tab-auto-refresh 标签页定时刷新

Chrome 浏览器扩展：为任意标签页设置定时自动刷新。

## 功能特性

- 预设间隔：30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时
- 自定义间隔：支持输入任意秒数（最小 30 秒）
- 右键菜单：在网页或标签页上右键快速设置刷新间隔
- 快捷键：`Alt+Shift+R` 开关当前标签页的定时刷新
- 全局暂停：弹窗一键暂停 / 恢复全部任务，角标同步显示暂停状态
- 任务管理：弹窗查看所有监控中的标签页，带倒计时
- 立即刷新：可手动触发一次刷新
- 忽略缓存：可选 Ctrl+F5 强制刷新（默认开启）
- 跳过休眠：可选不唤醒已丢弃（休眠）的标签页
- 同步设置：偏好设置通过 `chrome.storage.sync` 跨设备同步
- 持久化：浏览器重启后任务自动继续
- 自动清理：标签页失效或刷新失败时自动取消任务并通知
- 角标提示：工具栏图标显示当前监控数量
- 中英文界面：自动跟随浏览器语言

![弹窗截图](../docs/tab-auto-refresh/popup.png)

## 安装方法

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录（`tab-auto-refresh/`）

## 技术栈

- Manifest V3（Chrome 扩展最新规范）
- Background Service Worker（后台定时任务）
- Chrome Extensions API（Alarms / Storage / Context Menus / Tabs）

## 开发与测试

- 校验与单元测试：`node scripts/validate.mjs`、`node --test tests/`（CI 自动执行）
- 弹窗截图：`scripts/screenshot-popup.mjs`（mock chrome API 后用本机 Chrome 渲染）

## 开发环境

- Chrome 120+
- Node.js（用于脚本生成图标等资源）
