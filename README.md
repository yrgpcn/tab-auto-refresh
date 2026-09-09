# Tab Auto Refresh

轻量的 Chrome 标签页定时刷新扩展。仓库采用插件独立文件夹布局，便于后续加入其他扩展。

[![CI](https://github.com/yrgpcn/tab-auto-refresh/actions/workflows/ci.yml/badge.svg)](https://github.com/yrgpcn/tab-auto-refresh/actions/workflows/ci.yml)

## 插件列表

### tab-auto-refresh

标签页定时刷新工具：为任意标签页设置自动刷新间隔，支持全局暂停、快捷键与中英文界面。

![弹窗截图](./docs/tab-auto-refresh/popup.png)

**功能特性**
- 预设间隔：30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时
- 自定义间隔：支持输入任意秒数（最小 30 秒）
- 右键菜单：在网页或标签页上右键快速设置刷新间隔
- 快捷键：`Alt+Shift+R` 开关当前标签页的定时刷新，启动时使用上次设置的间隔
- 全局暂停：一键暂停 / 恢复全部任务
- 任务管理：弹窗查看所有监控中的标签页，带倒计时
- 立即刷新：可手动触发一次刷新
- 忽略缓存：可选 Ctrl+F5 强制刷新（默认开启）
- 跳过休眠：可选不唤醒已丢弃（休眠）的标签页
- 持久化：浏览器重启后任务自动继续
- 自动重开：误关监控中的标签页会自动重新打开并继续任务
- 登录保持：定期备份站点 cookie（含父域 SSO 票据），浏览器重启后自动恢复登录态
- 站点锁定：监控页面漂移到其他网站时自动导航回来；同站（含子域登录跳转）正常跟随
- 自动清理：标签页失效或刷新失败时自动取消任务并通知
- 角标提示：工具栏图标显示当前监控数量
- 中英文界面：自动跟随浏览器语言

> 使用边界：监控中的标签页若被手动换到其他网站，到刷新周期会自动导航回监控页面；想换监控对象，先停止任务再在新页面重新开启。详见插件文档。

**详细文档**：[tab-auto-refresh/README.md](./tab-auto-refresh/README.md)

## 开发

- 仓库校验与单元测试：`node scripts/validate.mjs`、`node --test "tests/**/*.test.mjs"`（CI 自动执行）
- 发布：打 tag `tab-auto-refresh/vX.Y.Z` 并推送，Actions 自动打包并创建 GitHub Release

## 安装方法

1. 克隆仓库：`git clone https://github.com/yrgpcn/tab-auto-refresh.git`
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择对应插件文件夹

## License

MIT
