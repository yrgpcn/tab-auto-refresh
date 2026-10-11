# Issue #10 实现与验证证据

基准：`main@395eca7b3d5730ce460d55ece373b8762b952da1`（[基准 CI](https://github.com/yrgpcn/tab-auto-refresh/actions/runs/38109241885)）。范围来自 Issue #10 正文与最新 Chat Handoff。无版本号、权限、发布配置或产品默认值变更。

## 根因与修复

Chrome 的 `scripting.executeScript()` 把 `allFrames`、`frameIds` 定义在 `target`（`InjectionTarget`）内；`frameIds` 与 `allFrames` 不能同时指定。[Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-InjectionTarget)。原执行器把二者放在 `ScriptInjection` 顶层，真实 Chrome 会拒绝调用。现在 `executeInAllFrames()` 把 `target.allFrames = true` 放入首次调用；整次调用失败时，再用 `target.frameIds = [0]` 回退顶层，并保留其它 target 字段。

共享 Chrome mock 现在拒绝未知顶层/target 字段、缺少 `target.tabId`、互斥的 frame 选择器、无效 frame/document ID，以及不符合 `func` / `files` / `args` 组合的注入。只有通过校验的调用进入 `executeScriptAccepted` 并执行脚本 hook，测试不会把形状错误的尝试误计为已执行。

## 红 → 绿

在未修产品代码的基准副本上，用严格 mock 执行 `node --test tests/tab-auto-refresh/frame-scan.test.mjs`：28 条中 4 条失败。失败分别为注入参数形状、子框架关键词命中未产生 `keyword-hit`、子框架验证墙连续探测未暂停任务、顶层回退参数断言不成立。修复后专项 29 条全部通过。

最终测试分别断言关键词与验证墙的调用进入 `executeScriptAccepted`；子框架命中必须产生通知并按设置停止任务；连续三次子框架验证墙探测必须将任务自动暂停；小型 reCAPTCHA 挂件必须真实执行探测但不得误暂停；全帧注入被拒时顶层回退仍能完成命中；关键词的全帧与顶层回退都失败时任务保留且不会误通知或停止。API 错误仅由现有调用方隔离处理，不把异常正文写入日志或用户通知。mock 自身也直接验证顶层 `allFrames` / `frameIds`、冲突选择器、错误的函数/文件组合和 `args` 形状会在脚本 hook 前失败。

失败路径仍会像基准一样等待下个刷新/检测周期，不新增用户可见的注入错误提示。该问题的复现证明了真机静默失败，但增加通知或设置属于产品行为选择，本 PR 不引入；Chat Review 可决定后续是否另立设计。

## 全量验证与 CI

- `node scripts/validate.mjs`：通过，扫描 57 个 JS / 4 个 JSON 文件。
- `node --test "tests/**/*.test.mjs"`：676 / 676 通过，0 fail / cancelled / skipped。
- GitHub-hosted PR [CI](https://github.com/yrgpcn/tab-auto-refresh/actions/runs/38116640557) 与 [Orchestrator PR Check](https://github.com/yrgpcn/tab-auto-refresh/actions/runs/38116640547)：均成功。

## 风险、回滚与交接

API 仍可能因 Chrome 不允许访问某个 frame、页面在调用时导航或目标 frame 消失而拒绝注入；现有顶层回退保留原有降级行为。回滚方式为 revert 本 PR 的实现提交。没有真实 Chrome 的 end-to-end 执行证据；Chat Review 后由 WorkBuddy 按 Issue #3 最新 Handoff，在真实 Chrome 重启场景中复测关键词真实命中和验证墙探测，并把 PASS / FAIL / NOT TESTED 与非敏感证据写回 Issue。Review 与 WorkBuddy 复测完成前保持 Issue #10 开放；不合并、不修改版本、不打 Tag、不发布 Release。
