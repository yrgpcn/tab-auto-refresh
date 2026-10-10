# Issue #8 实现与验证证据

基准：`main@1e2b713041748919d0e6b6c27aed17994fe05b3d`。任务范围来自 Issue #8 正文与 2026-10-10 Handoff。产品版本、权限、默认值和发布流程未改变。

## 红 → 绿

2026-10-10，本机 Node v24.19.0，以真实 `background.js` + 共用 Chrome/Cookie 桩件运行新增 `startup-cookies.test.mjs`：

- 改产品代码之前：最初 6 条测试，2 通过、4 失败。失败为持久票据冷启动保护、会话票据冷启动保护、keep 缺失刷新 alarm、PRIVATE 租户边界。
- 修复后：最初 6 条全部通过；随后扩展恢复专项至 16 条，覆盖重进、失败重试、计数落盘、迟到心跳、关闭开关、Cookie API 失败与能力边界。
- 最终全量结果与 GitHub-hosted CI 链接记录在 Draft PR；不以本地结果替代 CI 或真机结果。

## 回归所证行为

| 场景 | 自动化证据 |
|---|---|
| 持久/会话备份，早期多次 complete 与 401 心跳 | 备份内容与计数均不写；恢复后 reload 时 Cookie 已可读取，无错误通知 |
| keep / remap / watch | 已加载 keep/remap 最多补刷新；watch 只新开一次，不额外 reload；keep 只补缺失 alarm |
| Chrome 已保留同名 Cookie / 页面仍加载 | 不覆盖新票据；不额外 reload |
| prune 异常、SW 重进、无再次 onStartup | session 无收尾标记时普通事件可重试；成功后重新开放备份 |
| reload 后清理异常、SW 重进 | `rt:cookieReload:<tabId>` 先记后刷，重进不会形成 reload 循环 |
| 默认关闭、运行中关闭、恢复中关闭 | 不暗中备份；清理明文存档；停止尚未发出的恢复写入 |
| 过期 Cookie / 超过 30 天备份 / set reject 或无返回值 | 无成功重载，诊断不宣称登录成功 |
| PRIVATE 租户与历史越界存档 | 查询不到 github.io 上其他租户；恢复前剔除越界条目；wildcard 边界有用例 |
| 部分 Cookie API 查询失败 | 不用不完整样本覆盖好备份，不记录异常正文 |
| 分区 Cookie / 其他 Cookie store | 默认 API mock 不提供这些票据；调用未扩大 partitionKey/storeId 查询范围 |

新设置开关未增加；原本运行期的 Cookie 计数/任务锁测试明确种入已收尾 session 标记，冷启动测试则从空 session 开始。Cookie mock 的 hostOnly 还原现在由 URL 推导 domain，使补刷新能真正读取已写票据。

## UI 验证

两份语言包保留“重启恢复登录（明文）”开关，提示改为尝试恢复并列出能力边界。`screenshot-popup.mjs --measure` 七种布局均通过，最高 571px / 600px，页面零报错；两张截图经脚本重新生成并目视检查。可见布局没有变化，按仓库契约不提交动态时间引起的截图漂移。

## 安全与能力限制

Cookie 写入成功只说明浏览器 API 接受写入，服务端登录仍未验证。已作废票据、MFA/风控、退出清理策略、LocalStorage/IndexedDB 和跨独立站点 SSO 不保证恢复。不扩展分区 Cookie 或其他 store 的采集；日志只输出固定诊断与数量。

PRIVATE 后缀使用官方 PSL 的打包数据快照：VERSION `2026-10-07_07-28-19_UTC`，COMMIT `3929462652695bad04f0a27afb600974014a3c8b`，2026-10-10 获取，数据 MPL-2.0。ICANN 部分仍沿用现有保守形状规则，不宣称完整 PSL 覆盖。

## 真机验证与交接

真实 Chrome 重启尚未由 Codex执行；按 Handoff 交 WorkBuddy，在 Issue #3 记录开关勾选/未勾选、Chrome 版本、恢复时序、keep/remap/watch 类型、alarm 存在性与结果。禁止上传真实 Cookie/token；不得把公共 PR 代码接入个人 self-hosted runner。

Chat Review 重点：恢复屏障的异常路径、同名现存票据优先策略、PRIVATE 快照更新与范围、先记后刷导致浏览器异常时可能跳过一次补刷新。回滚用 revert 实现提交；紧急停止凭据备份可关闭开关并验证存档已清理。Merge、版本变更、tag 与 Release 均需另行授权。
