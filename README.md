# Chrome Extensions

个人开发的 Chrome 浏览器扩展集合，每个插件独立一个分支。

## 插件列表

### tab-auto-refresh

标签页定时刷新工具，支持为任意标签页设置自动刷新间隔。

**功能特性**
- 预设间隔：30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时
- 自定义间隔：支持输入任意秒数（最小 30 秒）
- 右键菜单：在标签页上右键快速设置刷新间隔
- 任务管理：弹窗查看所有监控中的标签页，带倒计时
- 立即刷新：可手动触发一次刷新
- 忽略缓存：可选 Ctrl+F5 强制刷新（默认开启）
- 持久化：浏览器重启后任务自动继续
- 角标提示：工具栏图标显示当前监控数量

**分支**：`tab-auto-refresh`

**详细文档**：[tab-auto-refresh/README.md](./tab-auto-refresh/README.md)

## 安装方法

1. 克隆仓库或下载对应分支的代码
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择插件文件夹

## 技术栈

- Manifest V3（Chrome 扩展最新规范）
- Background Service Worker（后台定时任务）
- Chrome Extensions API（Alarms / Storage / Context Menus / Tabs）

## 开发环境

- Chrome 120+
- Node.js（用于脚本生成图标等资源）

## License

MIT
