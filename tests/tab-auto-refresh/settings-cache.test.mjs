/* 2.1.0 批次 1 的门禁：生效设置的内存快照必须在正确时机作废。
   背景：getSettings() 原先每次都读盘，改成缓存后，"写完立刻读""外部改了再读"两条路全靠
   显式 invalidateSettings() 撑着。契约坏掉的表现是静默的——开关改了但后台按旧值收敛，
   或者 save-settings 拿过期快照当合并基座，把用户这次没碰的开关按旧值写回去。后者正是
   2.0.0 修过的"填完凭据点测试读到旧值"那一类竞态，不能被缓存重新引入。

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

/* 红→绿对照（在本仓库根执行；副本一律放仓库外，别污染 validate.mjs 的全仓扫描）：
     V=/tmp/tar-bg && rm -rf $V && mkdir -p $V && cp -r tab-auto-refresh/. "$V/"
     # 1) 改前源码（无缓存）
     git show HEAD:tab-auto-refresh/background.js > "$V/background.js"
     # 2~4) 逐个拆掉新写的守卫：去掉 epoch 守卫 / 去掉 save-settings 写盘后的失效 /
     #      去掉 onChanged 里的失效。每次对 $V/background.js 做一处字符串替换
     TAR_BG="$(cygpath -w "$V")/background.js" node --test tests/tab-auto-refresh/settings-cache.test.mjs

   2026-09-18 实跑结果，四条都判得动：
     改前源码      → 红「只读一次」+「local 迁移」（localGet 从 1 变 2，正是被省掉的那笔）
     去 epoch 守卫 → 只红「在飞行中失效」
     去写盘后失效  → 只红「save-settings 两头失效」
     去 onChanged 失效 → 红「外部改动」+「在飞行中失效」，后者本来要靠 onChanged 触发作废，
                        一个失效点管两条用例是正常的，不说明断言空跑
   三条失效类用例在改前源码上照旧绿：它们验的是"有缓存时失效点必须在"，而没有缓存的代码
   本来就不会读到旧值。这三条是前瞻守卫，防的是以后有人删掉 invalidateSettings()。 */
