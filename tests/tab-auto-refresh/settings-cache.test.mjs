/* 生效设置的内存快照必须在正确时机作废，且两条"读基座 → 整份写回"的链必须串行。
   前一半是 2.1.0 批次 1 的门禁：getSettings() 原先每次都读盘，改成缓存后，"写完立刻读""外部改了再读"
   两条路全靠显式 invalidateSettings() 撑着。契约坏掉的表现是静默的——开关改了但后台按旧值收敛，
   或者 save-settings 拿过期快照当合并基座，把用户这次没碰的开关按旧值写回去。后者正是
   2.0.0 修过的"填完凭据点测试读到旧值"那一类竞态，不能被缓存重新引入。

   后一半是 A7（2026-09-19）：同一条合并写回链有两个入口（点"开始"的 rememberLastInterval、
   切开关的 save-settings），两边各自 getSettings → 整份 set，交错执行时后落地的写会把先落地的
   那笔抹掉。所以两边都收进 patchSettings 的串行锁，锁本身与失效点、与"任务锁内等设置锁"的
   单向等待各由一条用例钉住。

   桩件来自 tests/helpers/background-harness.mjs，被测的是真实的 background.js。
   桩件的 set 不自动回流 onChanged（真实 Chrome 会），所以"写完立刻读"测的是写盘后那次
   显式失效，事件回流另开一条用例，两者不互相顶包。
   每条 onChanged 的改动键一律挑 bypassCache：它不在后台"需要收敛"的名单里，不会牵出
   reconcileKeepAlive 去多读一轮设置、多注入一次脚本，把断言的因果搅浑。 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeEnv, bootBackground } from "../helpers/background-harness.mjs";

/* 一个只读设置、并把两个注入开关回出来的入口，当"读侧探针"用：
   它反映的是后台此刻生效的值，不是弹窗自己合并的值 */
const readEffective = (env) => env.send({ type: "keepalive-query" });

/* 模拟另一台设备同步过来的改动。changes.settings 必须存在，否则监听器在入口就早退；
   但两侧的差值一律只落在 bypassCache 上，后台收敛名单里的那几个键保持相等。
   生效值由 getSettings 回读 store 得到，与这份 payload 无关 */
const BASE = {
  keepAlive: true,
  httpHeartbeat: true,
  skipOnActivity: true,
  keepAwake: false,
  cookieBackup: false,
  bypassCache: true
};
function externalChange(env) {
  return env.fire.onChanged(
    {
      bypassCache: { oldValue: true, newValue: false },
      settings: { oldValue: BASE, newValue: Object.assign({}, BASE, { bypassCache: false }) }
    },
    "sync"
  );
}

async function boot(settings) {
  const env = makeEnv();
  if (settings) env.store.sync.settings = settings;
  await bootBackground(env);
  return env;
}

test("settings are read from disk once, then served from the snapshot", async () => {
  const env = await boot({ keepAlive: false, bypassCache: true });

  const first = await readEffective(env);
  assert.equal(first.heartbeat, false, "首读要按存盘值");
  assert.equal(env.calls.syncGet, 1, "冷启动只需一笔 sync 读");
  assert.equal(env.calls.localGet, 0, "sync 有值时不该回读 local（改前的写法每次多一笔）");

  const second = await readEffective(env);
  assert.equal(second.heartbeat, false);
  assert.equal(env.calls.syncGet, 1, "第二次读仍在发存储读：快照没生效");
});

test("save-settings invalidates before merging and again after writing", async () => {
  const env = await boot({ keepAlive: true, httpHeartbeat: true });
  await readEffective(env); /* 预热：快照里 keepAlive=true */

  const saved = await env.send({ type: "save-settings", settings: { keepAlive: false } });
  assert.equal(saved.ok, true);

  /* 不喂 onChanged：这一步只验写盘后那次显式失效。缺了它，这里拿到的还是预热时的旧快照 */
  const after = await readEffective(env);
  assert.equal(after.heartbeat, false, "改完立刻读仍是旧值：写盘后没失效");

  /* 合并基座必须是新值。第二次只改 httpHeartbeat，基座过期就会把上一个 save 丢回去 */
  await env.send({ type: "save-settings", settings: { httpHeartbeat: false } });
  assert.equal(env.store.sync.settings.keepAlive, false, "过期基座把上一次的改动覆盖了");
  assert.equal(env.store.sync.settings.httpHeartbeat, false);
});

test("an external settings change invalidates the snapshot", async () => {
  const env = await boot({ keepAlive: true });
  const primed = await readEffective(env);
  assert.equal(primed.heartbeat, true);

  env.store.sync.settings = { keepAlive: false };
  await externalChange(env);

  const after = await readEffective(env);
  assert.equal(after.heartbeat, false, "外部改动后读到旧快照，表现为开关改了不生效");
});

test("a read in flight across an invalidation must not refill the snapshot", async () => {
  const env = await boot({ keepAlive: true });

  /* 制造"读盘结果已取到、但还没回填缓存"的窗口：先把值读出来，再挂起等待放行。
     挂起点必须在读之后——否则放行的那一刻读到的是新值，用例就没有判别力了 */
  let release;
  const gate = new Promise((r) => (release = r));
  const realGet = env.chrome.storage.sync.get;
  let hooked = false;
  env.chrome.storage.sync.get = async (keys) => {
    const out = await realGet(keys);
    if (!hooked) {
      hooked = true;
      await gate;
    }
    return out;
  };

  const pending = readEffective(env); /* 此刻已取到 keepAlive=true，挂起中 */
  env.store.sync.settings = { keepAlive: false };
  await externalChange(env); /* 失效发生在这次读盘途中 */
  release();
  const stale = await pending;
  assert.equal(stale.heartbeat, true, "挂起中的那次调用本就该拿到它读到的值");

  const after = await readEffective(env);
  assert.equal(after.heartbeat, false, "被失效过的那次读盘结果回填了缓存：过期快照复活");
});

test("an empty sync store falls back to local and migrates", async () => {
  const env = makeEnv();
  env.store.local.settings = { keepAlive: false, skipDiscarded: true };
  await bootBackground(env);

  const first = await readEffective(env);
  assert.equal(first.heartbeat, false, "1.1.0 及之前存 local 的设置没被接续");
  assert.equal(env.store.local.settings, undefined, "迁移后 local 的旧键没删");
  assert.equal(env.store.sync.settings.skipDiscarded, true);
  assert.equal(env.store.sync.settings.cookieBackup, false, "迁移结果没补齐默认值");

  const second = await readEffective(env);
  assert.equal(second.heartbeat, false);
  assert.equal(env.calls.localGet, 1, "迁移之后不该再回读 local");
});

/* ---------- A7：两条"读基座 → 整份写回"的链必须串行 ---------- */

test("onChanged 还没回流时，写盘不许拿内存里的过期快照当基座", async () => {
  /* 这条是为"读之前那次失效"补的：第一次对照跑发现拆掉它没有任何用例变红——
     上面那条 onChanged 用例喂的是回流已经到达的情况，管不到回流还在路上的窗口。
     真实 Chrome 里 onChanged 是异步到达的，而 save-settings 的注释就写着"onChanged 回流有延迟" */
  const env = await boot({ keepAlive: true, httpHeartbeat: true });
  await readEffective(env); /* 快照里 httpHeartbeat=true */

  env.store.sync.settings = { keepAlive: true, httpHeartbeat: false }; /* 另一台设备写的，不派发 onChanged */
  await env.send({ type: "save-settings", settings: { keepAlive: false } });

  assert.equal(
    env.store.sync.settings.httpHeartbeat, false,
    "基座取自过期快照，把外部那次改动按旧值写回去了"
  );
  assert.equal(env.store.sync.settings.keepAlive, false, "这次真正的改动反而没落地");
});

test("两个并发的 save-settings 不互相覆盖", async () => {
  const env = await boot({ keepAlive: true, httpHeartbeat: true, skipOnActivity: true });
  await readEffective(env);

  /* 制造重叠窗口：把第一条链的第一笔 sync 读挂起，第二条链在这期间发起。
     挂起点必须在读之后，否则放行的那一刻读到的是新值，用例就没有判别力了 */
  let release;
  const gate = new Promise((r) => (release = r));
  let hooked = false;
  const realGet = env.chrome.storage.sync.get;
  env.chrome.storage.sync.get = async (keys) => {
    const out = await realGet(keys);
    if (!hooked) {
      hooked = true;
      await gate;
    }
    return out;
  };

  const a = env.send({ type: "save-settings", settings: { keepAlive: false } });
  const b = env.send({ type: "save-settings", settings: { httpHeartbeat: false } });
  release();
  await Promise.all([a, b]);

  /* 不串行时两条链各自拿着同一份旧基座写回，后落地的把先落地的那笔抹掉。
     哪一条先失败取决于写入次序，所以三条断言都留着——失败信息要点名是"谁的改动丢了" */
  assert.equal(env.store.sync.settings.keepAlive, false, "keepAlive 这笔改动被后落地的写覆盖了");
  assert.equal(env.store.sync.settings.httpHeartbeat, false, "httpHeartbeat 这笔改动被后落地的写覆盖了");
  assert.equal(env.store.sync.settings.skipOnActivity, true, "谁都没碰过的开关被写没了");
});

test("手动起任务与切开关并发：两条都要完成，谁都不许把对方等死", async () => {
  const env = await boot({ keepAlive: true, httpHeartbeat: true, lastIntervalSec: 300 });
  env.putTab(7, "https://shop.example.com/pricing");
  /* startTask 是在 withTaskLock 里 await rememberLastInterval 的，也就是"任务锁内等设置锁"。
     方向反过来（设置锁内再排任务锁）就会死锁，弹窗表现为一直卡住——这条守的是那个反向 */
  const started = env.send({ type: "start", tabId: 7, seconds: 90 });
  const saved = env.send({ type: "save-settings", settings: { keepAlive: false } });
  const done = await Promise.race([
    Promise.all([started, saved]).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 3000))
  ]);
  assert.equal(done, true, "两条链互相等死：设置写盘与起任务都停住");
  assert.equal(env.store.sync.settings.lastIntervalSec, 90);
  assert.equal(env.store.sync.settings.keepAlive, false);
});

test("间隔没变就不写 sync：这条判断仍在设置锁内", async () => {
  const env = await boot({ keepAlive: false, lastIntervalSec: 300 });
  env.putTab(7, "https://shop.example.com/pricing");
  await env.send({ type: "start", tabId: 7, seconds: 300 });
  assert.equal(env.calls.syncSet.length, 0, "值没变也整份写回：sync 变更风暴回来了");
  await env.send({ type: "stop", tabId: 7 });
  await env.send({ type: "start", tabId: 7, seconds: 60 });
  assert.equal(env.calls.syncSet.length, 1, "值变了却没写盘");
  assert.equal(env.store.sync.settings.lastIntervalSec, 60);
});

/* 红→绿对照（在本仓库根执行；副本一律放仓库外，别污染 validate.mjs 的全仓扫描）：
     V=/tmp/tar-bg && rm -rf $V && mkdir -p $V && cp -r tab-auto-refresh/. "$V/"
     # 1) 改前源码（2.1.0 批次 1 用 HEAD；A7 那轮指的是 patchSettings 还没引入的那版 background.js，
     #    提交后就得按那个 commit 的父取，别照抄下面的 HEAD）
     git show HEAD:tab-auto-refresh/background.js > "$V/background.js"
     # 2~4) 逐个拆掉新写的守卫：去掉 epoch 守卫 / 去掉 save-settings 写盘后的失效 /
     #      去掉 onChanged 里的失效。每次对 $V/background.js 做一处字符串替换
     # 5~) A7 的六处见下面 2026-09-19 那段，同样是每处一处字符串替换
     TAR_BG="$(cygpath -w "$V")/background.js" node --test tests/tab-auto-refresh/settings-cache.test.mjs

   2026-09-18 实跑结果，四条都判得动：
     改前源码      → 红「只读一次」+「local 迁移」（localGet 从 1 变 2，正是被省掉的那笔）
     去 epoch 守卫 → 只红「在飞行中失效」
     去写盘后失效  → 只红「save-settings 两头失效」
     去 onChanged 失效 → 红「外部改动」+「在飞行中失效」，后者本来要靠 onChanged 触发作废，
                        一个失效点管两条用例是正常的，不说明断言空跑
   三条失效类用例在改前源码上照旧绿：它们验的是"有缓存时失效点必须在"，而没有缓存的代码
   本来就不会读到旧值。这三条是前瞻守卫，防的是以后有人删掉 invalidateSettings()。

   2026-09-19 A7 实跑结果，六处每处恰好红一条：
     改前源码（无设置锁） → 只红「两个并发的 save-settings 不互相覆盖」。其余三条 A7 用例在改前
                           源码上照旧绿，且不是空跑：改前的 rememberLastInterval 已有"没变不写"
                           与读前失效，只是这两步锁在函数外、互相之间没有串行关系
     withSettingsLock 退化成直接执行 → 只红「两个并发的 save-settings」
     去读之前那次失效 → 只红「onChanged 还没回流时」。这处第一次跑是绿的：那时唯一的失效类
                       用例喂的是 onChanged 已到达的情况，管不到回流还在路上的窗口。补了那条
                       用例（直接改 store 不派发事件，再 save-settings）才判得动
     去写盘后那次失效 → 只红「save-settings invalidates before merging and again after writing」
     去 rememberLastInterval 的「没变就不写」 → 只红「间隔没变就不写 sync」
     反向成环（设置锁内部再去排任务锁） → 只红「手动起任务与切开关并发」。这处前两版都不合格：
       版 1 把整个 patchSettings 套进 withTaskLock，跑出来是绿的——那与 startTask 的
       「任务锁内等设置锁」是同一个等待方向，不成环，判不出任何东西；
       版 2 无条件在 patchSettings 内插一次 withTaskLock，整份 suite 挂住跑不完（rememberLastInterval
       走的是函数形态、也在任务锁里被 await，于是自己也参与成环，把没有超时判据的「间隔没变就不写」
       一起吊死）。挂住最初没被发现，因为跑手只等退出码——现在加了 90 秒超时并把挂住单独报出来。
       现版把插环限定在对象形态（即 save-settings 那条链），成环只落在有 3 秒判据的那条用例上 */
