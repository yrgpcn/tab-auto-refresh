# Changelog

鏍煎紡鍙傝€?[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)锛岀増鏈彿閬靛惊璇箟鍖栫増鏈€?
## [tab-auto-refresh 1.4.0] - 2026-09-09

### Added
- 误关闭标签页自动重开：定时刷新中的标签页被关闭时，自动在后台重新打开并继续刷新
- Cookie 备份与恢复：每次刷新前备份域名 cookie，浏览器重启后自动恢复登录状态
- 新增 `cookies` 权限和 `<all_urls>` 主机权限，用于 cookie 备份恢复功能

### Fixed
- 修复关闭浏览器后残留幽灵任务的 bug：prune() 函数添加延迟等待标签页恢复

## [tab-auto-refresh 1.3.0] - 2026-09-07

### Added
- tab-auto-refresh 蹇嵎閿惎鍔ㄤ换鍔℃椂浣跨敤鏈€杩戜竴娆℃垚鍔熻缃殑闂撮殧锛堥粯璁や粛涓?5 鍒嗛挓锛?
### Changed
- Release zip 澧炲姞椤跺眰 `tab-auto-refresh/` 鐩綍锛岃В鍘嬪悗鍙洿鎺ラ€夋嫨鏂囦欢澶瑰姞杞?
### Fixed
- tab-auto-refresh 蹇嵎閿弿杩版敼涓轰腑鑻辨枃璇█鍖呮枃妗?
## [tab-auto-refresh 1.2.0] - 2026-09-07

### Added
- 鍏ㄥ眬鏆傚仠 / 鎭㈠锛氬脊绐椾竴閿殏鍋滃叏閮ㄤ换鍔★紝瑙掓爣鏄剧ず鏆傚仠鐘舵€侊紱鏆傚仠鏈熼棿涓嶈Е鍙戝埛鏂帮紝鎭㈠鍚庢寜鍘熷懆鏈熺户缁?
- 椤甸潰鍙抽敭鑿滃崟锛氬湪缃戦〉浠绘剰浣嶇疆鍙抽敭鍗冲彲璁剧疆瀹氭椂鍒锋柊锛堟鍓嶄粎鏀寔鏍囩椤靛彸閿級
- 閿洏蹇嵎閿?`Alt+Shift+R`锛氬紑鍏冲綋鍓嶆爣绛鹃〉鐨勫畾鏃跺埛鏂?
- 銆岃烦杩囧凡涓㈠純鏍囩椤点€嶉€夐」锛氬紑鍚悗浼戠湢鏍囩椤典笉浼氳鑷姩鍒锋柊鍞ら啋
- 鑻辨枃鐣岄潰锛坄_locales/en`锛夛紝涓嫳鏂囧畬鏁存敮鎸?
- 浠撳簱绾ф牎楠岃剼鏈笌鍗曞厓娴嬭瘯锛坄scripts/validate.mjs`銆乣tests/`锛夛紝CI 璐ㄩ噺闂ㄧ
- MIT LICENSE

### Changed
- 鍋忓ソ璁剧疆锛堝拷鐣ョ紦瀛樸€佽烦杩囧凡涓㈠純锛夎縼绉诲埌 `chrome.storage.sync` 澶氳澶囧悓姝ワ紱鏃ф湰鍦拌缃嚜鍔ㄨ縼绉伙紝浠诲姟绛夌姸鎬佷粛瀛?`chrome.storage.local`
- 鎵嬪姩寮€濮嬫柊浠诲姟浼氳嚜鍔ㄨВ闄ゅ叏灞€鏆傚仠
- 鎻愬彇绾€昏緫鍒?`shared/logic.js`锛堥棿闅斿厹搴曘€侀棿闅斾笌鍊掕鏃舵牸寮忓寲锛夛紝鍚庡彴涓庡脊绐楀叡鐢?

### Fixed
- 宸ュ叿鏍忓浘鏍?`default_title` 鏀圭敤鍥介檯鍖栧悕绉?`__MSG_extName__`

## [tab-auto-refresh 1.1.0] - 2026-09-07

### Added
- 浠诲姟鍐欓攣锛坄withTaskLock`锛夛紝闃叉寮圭獥 / 鍙抽敭鑿滃崟 / 瀹氭椂鍣ㄥ苟鍙戣鍐欎换鍔″垪琛?
- 寮圭獥姣忕鍚屾 alarm 鍒楄〃锛屽€掕鏃跺綊闆跺悗缁х画婊氬姩
- 浠诲姟澶辨晥鏃惰嚜鍔ㄥ彇娑堝苟閫氳繃 `chrome.notifications` 閫氱煡
- 鑷畾涔夐棿闅斿皬浜?30 绉掓椂缁欏嚭鏄庣‘鎻愮ず
- favicon 涓虹┖鏃堕殣钘忓崰浣嶅浘鏍?
- 鍥介檯鍖栭鏋讹紙`chrome.i18n`锛屼腑鏂囨枃妗堣縼鍏?`_locales/zh_CN`锛?
- tag 椹卞姩鐨勮嚜鍔ㄥ彂甯冨伐浣滄祦涓庨」鐩蹇嗘枃妗?`AGENTS.md`

### Changed
- `shared/config.js` 缁熶竴绠＄悊鍓嶇紑涓庨璁鹃棿闅旓紝鍚庡彴鍜屽脊绐楀叡鐢?
- service worker 鏀逛负 ES module
- `minimum_chrome_version` 璁句负 120

## [tab-auto-refresh 1.0.0] - 2026-09-07

### Added
- 棣栦釜鐗堟湰锛氶璁句笌鑷畾涔夐棿闅斻€佸拷鐣ョ紦瀛樺埛鏂般€佷换鍔″垪琛ㄤ笌鍊掕鏃躲€佸彸閿彍鍗曘€佺珛鍗冲埛鏂般€佹寔涔呭寲涓庤嚜鍔ㄦ竻鐞嗐€佽鏍囪鏁?
