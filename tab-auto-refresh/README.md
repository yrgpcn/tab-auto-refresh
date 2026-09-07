# tab-auto-refresh 标签页定时刷新

Chrome 浏览器扩展：为任意标签页设置定时自动刷新。

## 功能特性

- 预设间隔：30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时
- 自定义间隔：支持输入任意秒数（最小 30 秒）
- 右键菜单：在标签页上右键快速设置刷新间隔
- 任务管理：弹窗查看所有监控中的标签页，带倒计时
- 立即刷新：可手动触发一次刷新
- 忽略缓存：可选 Ctrl+F5 强制刷新（默认开启）
- 持久化：浏览器重启后任务自动继续
- 角标提示：工具栏图标显示当前监控数量

## 安装方法

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录（`tab-auto-refresh/`）

## 技术栈

- Manifest V3（Chrome 扩展最新规范）
- Background Service Worker（后台定时任务）
- Chrome Extensions API（Alarms / Storage / Context Menus / Tabs）

## 开发环境

- Chrome 120+
- Node.js（用于脚本生成图标等资源）
