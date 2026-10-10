# Issue #8 实现与验证证据

基准：`main@1e2b713041748919d0e6b6c27aed17994fe05b3d`。任务范围来自 Issue #8 正文与 2026-10-10 Handoff。产品版本、权限、默认值和发布流程未改变。

## 红 → 绿

2026-10-10，本机 Node v24.19.0，以真实 `background.js` + 共用 Chrome/Cookie 桩件运行新增 `startup-cookies.test.mjs`：

- 改产品代码之前：最初 6 条测试，2 通过、4 失败。失败为持久票据冷启动保护、会话票据冷启动保护、keep 缺失刷新 alarm、PRIVATE 租户边界。
- 修复后：最初 6 条全部通过；随后扩展恢复专项至 16 条，覆盖重进、失败重试、计数落盘、迟到心跳、关闭开关、Cookie API 失败与能力边界。
- 最终全量结果与 GitHub-hosted CI 链接记录在 Draft PR；不以本地结果替代 CI 或真机结果。

### PR #9 最新 Chat Review 的修复批次

针对 head `300d9fdba244cdde7b0dbf6965e29bbc65227f62` 的 [Review 评论](https://github.com/yrgpcn/tab-auto-refresh/pull/9#issuecomment-6098424851)，先在未修改产品代码上实跑新增 `review-recovery.test.mjs`：首批 14 条全部失败，覆盖历史刷新 alarm（keep/remap/watch/ID 复用 × 有/无备份）、默认关闭无备份的早期同主机 URL 跟随、三种游客/持久票据冲突组合、两种逐条查询失败顺序。修复后该批全部通过，专项最终扩展到 21 条。

- 历史 `refresh-` alarm 在认领前 defer，不提前 STOP、reload 或重新排期；事件早于 onStartup 时触发恢复并放弃旧事件。默认关闭且没有 Cookie 备份仍需完成任务认领。认领后正常 alarm 与 URL 跟随恢复。
- 同名同域同路径未过期但异值的 Cookie 不能证明已认证；采用 **诊断性降级**，不盲目覆盖可能有效的新登录，也不把 guest 当作登录成功。控制台给固定 `conflict-unverified` 与数量；`rt:cookieRecovery` 按注册域冻结旧存档，SW 重进、正常页面、登录页、普通 2xx 均不会凭空解冻。该方案可能仍需用户登录，交 Chat 审核产品取舍。
- 单条 getAll 失败不写入未知现场、不影响其它条目计数；前/后条目成功均补刷新一次。API 失败保护旧存档；保护状态写入失败不写 pruneDone，允许下次重试。关闭开关发生在挂起查询中时不晚写 Cookie。
- 相同值无需回写且正常采样开放；已过期的游客 Cookie 不阻止还原。冲突包括可能更有效的新登录，双方保留。确认登录后可关闭开关、等待明文存档清理完成、再开启重新采样；清理失败则保留保护，不覆盖遗留票据。重置会删除旧存档。
- 运行期测试使用 `makeEnv({ startupComplete: true })` 显式声明状态；harness 默认仍是空 session，冷启动测试不绕过门控。存储契约同步加入新 session 键，没有改变 Cookie 存档 schema 或权限边界。
- 本机 Node v24.19.0：`node scripts/validate.mjs` 通过（57 JS / 4 JSON），全量 `node --test "tests/**/*.test.mjs"` **674 / 674 pass，0 fail / cancelled / skipped**。最新 head 的 GitHub-hosted CI / Orchestrator Check 链接及结果记录在原 Draft PR #9 正文与 Handoff。

## 回归所证行为

| 场景 | 自动化证据 |
|---|---|
| 持久/会话备份，早期多次 complete 与 401 心跳 | 备份内容与计数均不写；恢复后 reload 时 Cookie 已可读取，无错误通知 |
| keep / remap / watch | 已加载 keep/remap 最多补刷新；watch 只新开一次，不额外 reload；keep 只补缺失 alarm |
| Chrome 已保留异值同名 Cookie / 页面仍加载 | 异值报告未验证冲突，冻结旧存档；不盲目覆盖；页面仍加载不额外 reload |
| prune 异常、SW 重进、无再次 onStartup | session 无收尾标记时普通事件可重试；成功后重新开放备份 |
| reload 后清理异常、SW 重进 | `rt:cookieReload:<tabId>` 先记后刷，重进不会形成 reload 循环 |
| 默认关闭、运行中关闭、恢复中关闭 | 不暗中备份；清理明文存档；停止尚未发出的恢复写入 |
| 过期 Cookie / 超过 30 天备份 / set reject 或无返回值 | 无成功重载，诊断不宣称登录成功 |
| PRIVATE 租户与历史越界存档 | 查询不到 github.io 上其他租户；恢复前剔除越界条目；wildcard 边界有用例 |
| 部分 Cookie API 查询失败 | 采样不覆盖好备份；恢复逐条隔离，保留其它成功写入计数与补刷新，不记录异常正文 |
| 分区 Cookie / 其他 Cookie store | 默认 API mock 不提供这些票据；调用未扩大 partitionKey/storeId 查询范围 |

新设置开关未增加；原本运行期的 Cookie 计数/任务锁测试明确种入已收尾 session 标记，冷启动测试则从空 session 开始。Cookie mock 的 hostOnly 还原现在由 URL 推导 domain，使补刷新能真正读取已写票据。

## UI 验证

两份语言包保留“重启恢复登录（明文）”开关，提示改为尝试恢复并列出能力边界。`screenshot-popup.mjs --measure` 七种布局均通过，最高 571px / 600px，页面零报错；两张截图经脚本重新生成并目视检查。可见布局没有变化，按仓库契约不提交动态时间引起的截图漂移。

## 安全与能力限制

Cookie 写入成功只说明浏览器 API 接受写入，服务端登录仍未验证。已作废票据、MFA/风控、退出清理策略、LocalStorage/IndexedDB 和跨独立站点 SSO 不保证恢复。不扩展分区 Cookie 或其他 store 的采集；日志只输出固定诊断与数量。

PRIVATE 后缀使用官方 PSL 的打包数据快照：VERSION `2026-10-07_07-28-19_UTC`，COMMIT `3929462652695bad04f0a27afb600974014a3c8b`，2026-10-10 获取，数据 MPL-2.0。ICANN 部分仍沿用现有保守形状规则，不宣称完整 PSL 覆盖。

## 真机验证与交接

真实 Chrome 重启尚未由 Codex执行；按 Handoff 交 WorkBuddy，在 Issue #3 记录开关勾选/未勾选、Chrome 版本、恢复时序、keep/remap/watch 类型、alarm 存在性与结果。禁止上传真实 Cookie/token；不得把公共 PR 代码接入个人 self-hosted runner。

Chat Review 重点：包含无备份/历史 alarm 的恢复屏障、异值票据诊断降级与手动重置的产品取舍、逐条失败计数与旧存档保护、PRIVATE 快照更新与范围、先记后刷导致浏览器异常时可能跳过一次补刷新。回滚用 revert 实现及本批修复提交；紧急停止凭据备份可关闭开关并验证存档已清理。Merge、版本变更、tag 与 Release 均需另行授权。
