# 代码审查标准与流程

> **项目**: 一起看 · Watch Together  
> **版本**: v24  
> **技术栈**: Vanilla JS (ES6+) + CSS + HTML，单文件 IIFE 架构  
> **部署**: 腾讯云 EdgeOne Pages  
> **最后更新**: 2026-06-02

---

## 目录

1. [审查维度](#1-审查维度)
2. [门禁标准](#2-门禁标准)
3. [审查流程](#3-审查流程)
4. [特有 Critical Check 清单](#4-特有-critical-check-清单)
5. [自动化检测规则](#5-自动化检测规则)
6. [附录](#6-附录)

---

## 1. 审查维度

### 1.1 安全性 (Security)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 1.1 | **XSS 防护**: 所有 `innerHTML` 赋值是否经过 `escapeHtml()` 处理？特别注意 `renderSearchResults()`、`renderEpisodes()`、`renderPlaylist()` 中的动态内容拼接 | 🔴 Blocker |
| 1.2 | **CORS 代理链安全**: 代理 URL 是否来自可信列表？`PROXY_LIST` 变更后是否检查过代理服务商的隐私政策？禁止将用户视频 URL 发送到不可信代理 | 🔴 Blocker |
| 1.3 | **信令服务器安全**: `CONFIG.signalServers` 中的 TURN 凭据是否为公开中继？生产环境禁止使用 `openrelayproject` 凭据处理敏感数据 | 🟡 Warning |
| 1.4 | **内容安全策略**: 是否配置了 CSP 头？当前页面加载了 `unpkg.com`、`cdn.jsdelivr.net` 的外部脚本，缺少 `integrity` 属性（SRI） | 🟡 Warning |
| 1.5 | **输入验证**: `roomIdInput`、`nicknameInput`、`chatInput` 是否有长度限制和字符白名单？房间号是否仅允许 `[A-Z0-9]`？ | 🔴 Blocker |

### 1.2 同步逻辑正确性 (Sync Correctness)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 2.1 | **竞态条件**: `State.isSyncing` 锁的粒度是否足够？`setTimeout(200ms)` 解锁是否可能在慢网络下过早释放？ | 🔴 Blocker |
| 2.2 | **状态一致性**: `State.videoUrl` / `State.videoSource` / `State.videoType` 是否在每次 `loadVideo()` / `cleanVideo()` 调用时保持三元组一致？ | 🔴 Blocker |
| 2.3 | **重复消息去重**: `sync-state` 和 `video-load` 消息是否有幂等性保护？Guest 收到重复 `video-load` 是否会重复加载视频？ | 🔴 Blocker |
| 2.4 | **HLS 同步时序**: `loadVideoFromPeer()` 注册的 `loadedmetadata` 事件是否可能在 HLS `MANIFEST_PARSED` 之前触发？ | 🔴 Blocker |
| 2.5 | **心跳超时**: 心跳间隔 5000ms，多久未收到视为断线？当前缺少对端心跳超时检测 | 🟡 Warning |

### 1.3 错误处理与韧性 (Error Handling & Resilience)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 3.1 | **空 catch 块**: `catch (e) {}` 是否绝对必要？每个空 catch 必须添加注释说明原因，或至少 `console.debug()` 记录 | 🔴 Blocker |
| 3.2 | **CORS 代理降级**: `proxyFetch()` 的降级链是否完整？所有代理失败时是否有用户可见的错误提示？ | 🔴 Blocker |
| 3.3 | **重连退避策略**: 重试延迟 `1000 * retryCount` 和 `1500 * retryCount` 是否有最大上限？是否会导致雪崩？ | 🟡 Warning |
| 3.4 | **视频加载错误恢复**: `showVideoError()` 后用户是否有清晰的恢复路径？错误码映射是否完整（1=MEDIA_ERR_ABORTED 未覆盖）？ | 🟡 Warning |
| 3.5 | **PeerJS 异常状态**: `peer.destroyed` 检查是否在所有异步回调中一致？`disconnected` vs `close` vs `error` 事件的处理是否完备？ | 🔴 Blocker |

### 1.4 性能 (Performance)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 4.1 | **定时器泄漏**: `setInterval`（同步心跳、syncInterval）是否在 `leaveRoom()` / `handleDisconnect()` 时正确清除？是否存在多个定时器并存的窗口期？ | 🔴 Blocker |
| 4.2 | **DOM 批量操作**: `renderSearchResults()`、`renderEpisodes()`、`renderPlaylist()` 中是否一次性构建 HTML 字符串再赋值 `innerHTML`（当前已做到），避免多次 DOM 重排 | 🟢 良好 |
| 4.3 | **内存泄漏**: `loadVideo()` 中注册的事件监听器（`loadedmetadata`、HLS 事件）是否在 `cleanVideo()` 中移除？`{ once: true }` 使用良好但需验证 HLS 路径 | 🟡 Warning |
| 4.4 | **网络请求去重**: 快速连续点击搜索/加载时是否有请求去重或节流？`doSearch()` 缺少对进行中请求的 AbortController | 🟡 Warning |
| 4.5 | **视频元素复用**: `cleanVideo()` 调用 `mainVideo.load()` 是否在所有浏览器上正确重置？Safari 上 `removeAttribute('src')` + `load()` 的行为是否验证过？ | 🟡 Warning |

### 1.5 可维护性 (Maintainability)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 5.1 | **魔法数字**: 超时/延迟值（500, 1500, 3000, 3500, 200）是否应提取到 `CONFIG`？已提取的有 `connectTimeout`、`heartbeatInterval`、`syncInterval`、`maxRetries`，其余是否合理？ | 🟡 Warning |
| 5.2 | **模块边界**: DOM 操作是否严格限定在 UI 相关模块？纯逻辑函数（如 `extractVideoUrl`、`resolveUrl`）是否误含 DOM 操作？ | 🟡 Warning |
| 5.3 | **函数复杂度**: `handleDataMessage()`（77行 switch）、`bindEvents()`（178行）、`searchSourceCupfox()`（116行，3层嵌套）是否需要拆分？ | 🟡 Warning |
| 5.4 | **命名一致性**: `loadVideo` / `loadVideoFromPeer` / `loadPlayCupfox` / `parseBilibili` 命名模式是否一致？建议统一为 `load*` / `parse*` / `handle*` 前缀 | 🟢 建议 |
| 5.5 | **死代码检测**: 是否有未使用的函数或 CSS 类？`.video-container video::-webkit-media-text-track-display` 选择器是否仍需要？ | 🟢 建议 |

### 1.6 DOM 操作规范 (DOM Discipline)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 6.1 | **直接 DOM 操作隔离**: 非 UI 模块（如 `extractVideoUrl`、`proxyFetch`、`fetchBilibiliPlayUrl`）是否包含 `innerHTML` / `style.display` 操作？ | 🟡 Warning |
| 6.2 | **内联样式**: HTML 中 15 处 `style="display:none"` 是否应改用 CSS 类（如 `.hidden` / `.visible`）控制？ | 🟡 Warning |
| 6.3 | **XSS via innerHTML**: `renderSearchResults()` 中 `data-title` 属性值通过 `it.title.replace(/"/g, '&quot;')` 转义是否充分？是否存在属性注入风险？ | 🔴 Blocker |
| 6.4 | **事件委托**: 搜索列表、分集列表、播放列表的点击事件是否使用事件委托（当前已做到），避免为每项绑定独立监听器 | 🟢 良好 |
| 6.5 | **DOM 引用缓存**: `dom` 对象在 `DOMContentLoaded` 时缓存，但 `leaveRoom()` → `createRoom()` 流程中是否有 DOM 重建导致引用失效？ | 🟡 Warning |

### 1.7 网络与连接 (Networking & Connectivity)

| # | 检查项 | 严重级别 |
|---|--------|----------|
| 7.1 | **AbortController 清理**: `fetchWithTimeout()` 创建的 `AbortController` 在请求完成/失败后是否被正确回收？ | 🟡 Warning |
| 7.2 | **请求超时一致性**: `proxyFetch` 默认 15000ms，各处调用传递的超时（12000/15000）是否合理且有文档说明？ | 🟢 建议 |
| 7.3 | **离线降级**: 用户断网时是否有明确的状态提示？当前 `handleDisconnect()` 提示较好，但缺少手动重连按钮 | 🟡 Warning |
| 7.4 | **信令服务器切换**: `serverIndex++` 切换是否在 `tryJoin` / `tryCreateHost` 重试时正确重置？重连时 `serverIndex = 0` 是否合理？ | 🟡 Warning |
| 7.5 | **连接状态机**: `isConnected` / `isConnecting` 双标志位是否存在非法组合（如两者同时为 true）？建议使用单一枚举状态 | 🟡 Warning |

---

## 2. 门禁标准

### 🔴 Blocker (必须修复，否则禁止合并)

适用于：任何可能导致以下后果的问题：

- **安全漏洞**: XSS、CORS 配置错误、未验证的用户输入进入 DOM
- **数据丢失**: 同步状态不一致导致双方视频永久不同步
- **功能崩溃**: 特定条件下 JS 异常未捕获导致白屏
- **连接彻底中断**: 重连逻辑缺陷导致用户无法恢复会话
- **隐私泄露**: 用户视频 URL 通过不安全的代理传输

**具体判定规则：**

| 规则 | 说明 |
|------|------|
| 空 catch 无注释 | `catch (e) {}` 必须加注释说明为何忽略，或至少 `console.debug()` |
| innerHTML 未转义 | 任何包含用户/第三方数据的 `innerHTML` 必须经过 `escapeHtml()` |
| 定时器未清理 | `setInterval` / `setTimeout` 返回值必须在 `cleanVideo()` / `leaveRoom()` / `handleDisconnect()` 中清理 |
| 竞态条件 | 异步操作（fetch、HLS 事件、PeerJS 回调）中修改 State 必须有锁或幂等保护 |
| 视频重复加载 | `loadVideo()` 调用前必须检查 `State.videoUrl === url` 并跳过 |
| 请求未超时 | 所有 fetch 必须有超时机制（当前已全量使用 `fetchWithTimeout`，但需检查新增请求） |

### 🟡 Warning (建议修复，需在合并后 7 天内解决)

适用于：可能导致以下后果但不阻塞当前发布的问题：

- 性能退化但不影响功能
- 代码可维护性降低
- 边界条件下的潜在问题
- 缺少错误处理但不导致崩溃

### 🟢 Suggestion (改进建议，下次迭代考虑)

适用于：代码风格、命名优化、架构改进等非功能性改进。

---

## 3. 审查流程

### 3.1 提交前自检清单

每个 PR 提交者必须在提交前逐项确认：

```
□ 1. 所有新增 innerHTML 使用前已调用 escapeHtml()
□ 2. 所有新增 catch 块有注释或无空块
□ 3. 所有新增 setTimeout/setInterval 在 cleanVideo()/leaveRoom() 中有对应清理
□ 4. 新增异步操作有适当的锁（isSyncing/isConnecting 模式）
□ 5. 新增 CONFIG 值有合理注释说明含义和单位
□ 6. 内联 style 优先使用 CSS 类
□ 7. 在 Chrome + Firefox 各测试一遍完整流程
□ 8. 在移动端 375px 宽度测试一遍
□ 9. 测试：房主创建 → 加载视频 → Guest 加入 → 同步播放
□ 10. 测试：断开重连 → 恢复同步
□ 11. 测试：B站解析 → 茶杯狐搜索 → 直链加载
□ 12. 测试：HLS 流加载 → 切换分集
```

### 3.2 同行审查步骤

```
步骤 1: 自动化检查（提交时自动运行）
  ├── 运行 lint-checks.sh（见第5节）
  ├── 确认所有检测通过
  └── 输出检查报告

步骤 2: 审查者分配
  ├── 至少有 1 名熟悉 PeerJS/WebRTC 的审查者
  └── 复杂变更（>100 行）需 2 名审查者

步骤 3: 审查维度覆盖
  ├── 第一轮：安全性 + 同步逻辑正确性（1.1 + 1.2）
  ├── 第二轮：错误处理 + 性能（1.3 + 1.4）
  ├── 第三轮：可维护性 + DOM 规范（1.5 + 1.6）
  └── 第四轮：网络连接（1.7）

步骤 4: 问题分级
  ├── 审查者按 Blocker / Warning / Suggestion 标记
  ├── Blocker 问题必须在当前 PR 修复
  └── Warning 问题创建 Issue 并链接到 PR

步骤 5: 审批
  ├── 所有 Blocker 解决后 Approve
  └── 审查者确认自检清单完整
```

### 3.3 审查时间盒建议

| 变更规模 | 建议审查时间 | 备注 |
|----------|-------------|------|
| < 30 行 | 15 分钟 | 重点检查安全性和同步逻辑 |
| 30-100 行 | 30 分钟 | 完整维度覆盖 |
| 100-300 行 | 45-60 分钟 | 需 2 名审查者 |
| > 300 行 | 分多次审查 | 建议拆分为多个 PR |

> **针对本项目 2300 行级别变更**：强烈建议不要一次性审查整个文件。若必须进行大规模重构，请：
> 1. 先做模块拆分（如将 CORS 代理、B站解析、茶杯狐搜索各自独立为 PR）
> 2. 每个 PR 不超过 300 行
> 3. 使用 `git diff --stat` 确认变更范围

---

## 4. 特有 Critical Check 清单

基于已修复的 P0/P1 问题和项目架构特点，以下 8 条为本项目最为关键的审查检查项：

### C-1: CORS 代理降级完整性

> **来源**: P0-1「CORS 代理失效未及时清理」

```
审查要点：
□ PROXY_LIST 中的每个代理 URL 是否仍可访问？
□ 代理全部失败时，proxyFetch() 是否返回可读的错误？
□ 代理成功时 PROXY_INDEX 是否正确更新为当前可用索引？
□ 是否存在代理返回非 200 但被误判为成功的情况？
□ 新增代理是否经过隐私合规审查？
```

### C-2: 重连状态机一致性

> **来源**: P0-3「重连竞态条件」

```
审查要点：
□ isConnecting 和 isConnected 是否可能同时为 true？
□ handleDisconnect() 触发的延迟重连是否可能和用户手动操作冲突？
□ disconnect 回调中检查 peer.destroyed 是否在所有路径上都正确？
□ 重连时 serverIndex 重置为 0 是否合理？
□ 是否存在 "连接超时回调" 和 "实际已连接" 的时序竞争？
```

### C-3: HLS 异步操作时序

> **来源**: P0-4「HLS 异步 seek 未等待」

```
审查要点：
□ loadVideo() 中 HLS MANIFEST_PARSED 回调是否在 seek/play 前等待足够？
□ loadVideoFromPeer() 的 loadedmetadata 事件是否会与 HLS 内部事件竞争？
□ hlsInstance 在 cleanVideo() 中 destroy 后，是否还有悬空回调引用？
□ HLS error 回调中的 switch-case 是否覆盖所有错误类型？
□ HLS 原生回退路径（Safari）的 seek 行为是否一致？
```

### C-4: 重复视频加载去重

> **来源**: P0-5「重复视频加载未去重」

```
审查要点：
□ loadVideo() 入口是否检查 url === State.videoUrl && 视频已在播放？
□ Guest 收到重复 video-load 消息时是否跳过相同 URL？
□ addToPlaylist() 的去重逻辑是否覆盖所有视频来源？
□ 快速切换分集时是否可能加载同一视频两次？
□ sync-state 消息触发的 loadVideoFromPeer 是否检查当前 URL？
```

### C-5: DOM XSS 防护全覆盖

> **来源**: 项目使用大量 innerHTML 拼接动态内容

```
审查要点：
□ renderSearchResults() - 茶杯狐搜索结果 title/status 是否转义？
□ renderEpisodes() - 分集名称是否可能包含 HTML 标签？
□ renderPlaylist() - 播放记录标题是否转义？
□ addChatMessage() - 已使用 escapeHtml()，但新增的消息类型是否也如此？
□ data-* 属性注入：title.replace(/"/g, '&quot;') 是否充分？单引号呢？
```

### C-6: 域名/外部资源降级完整性

> **来源**: P0-2「域名降级不完整」

```
审查要点：
□ PeerJS CDN (unpkg.com) 是否有备用 CDN？
□ HLS.js CDN (cdn.jsdelivr.net) 加载失败时的降级是否完善？
□ Google Fonts 加载失败是否影响页面可用性？
□ 茶杯狐搜索 primary → legacy mirror 降级是否覆盖所有情况？
□ cobalt.tools API 不可用时是否有合理降级？
```

### C-7: 定时器生命周期管理

> **来源**: 项目有 3 个定时器：heartbeat (5s), syncInterval (4s), disconnect 延迟 (3s)

```
审查要点：
□ startHeartbeat / stopHeartbeat 配对是否在所有退出路径上调用？
□ setupVideoEvents 中的 setInterval(sync, 4000) 是否在 cleanVideo 中清除？
□ handleDisconnect 中的 setTimeout(3000) 是否可能在不当时机触发？
□ leaveRoom() 是否清理了 connectTimeoutId？
□ 是否存在 "旧定时器还在运行，新定时器又创建" 的窗口？
```

### C-8: PeerJS Data Connection 数据校验

> **来源**: WebRTC Data Channel 传输二进制/JSON 数据

```
审查要点：
□ handleDataMessage() 是否校验 data.type 为已知类型？
□ 非法 type 是否有 default 分支静默丢弃？
□ data.currentTime 是否校验为有效数字（非 NaN、非负）？
□ 消息大小是否有上限？聊天消息 maxlength=500 是否同步到发送端检查？
□ JSON 序列化错误（循环引用等）是否被 try/catch 包裹？
```

---

## 5. 自动化检测规则

### 5.1 Shell 脚本：提交前检查

创建 `scripts/lint-checks.sh`：

```bash
#!/bin/bash
# Watch Together - 提交前自动化检查
# 用法: bash scripts/lint-checks.sh

set -e
APP="app.js"
CSS="styles.css"
HTML="index.html"
ERRORS=0

echo "========================================="
echo "  Watch Together - Code Lint Checks"
echo "========================================="

# 1. 检查空 catch 块
echo ""
echo "[1] 空 catch 块检测..."
EMPTY_CATCH=$(grep -n 'catch\s*(\s*[a-z]\s*)\s*{\s*}' "$APP" || true)
if [ -n "$EMPTY_CATCH" ]; then
  echo "  ⚠️  发现空 catch 块 (应添加注释说明原因):"
  echo "$EMPTY_CATCH" | while read line; do
    echo "    $line"
  done
  # 不算错误，但需要人工确认
else
  echo "  ✅ 未发现空 catch 块"
fi

# 2. 检查 innerHTML 是否都经过 escapeHtml
echo ""
echo "[2] innerHTML 安全检查..."
INNERHTML_LINES=$(grep -n '\.innerHTML\s*=' "$APP" | grep -v '//' || true)
UNSAFE_COUNT=0
if [ -n "$INNERHTML_LINES" ]; then
  while IFS= read -r line; do
    LINENUM=$(echo "$line" | cut -d: -f1)
    # 检查附近行是否有 escapeHtml 调用
    CONTEXT=$(sed -n "$((LINENUM-2)),$((LINENUM+2))p" "$APP")
    if ! echo "$CONTEXT" | grep -q 'escapeHtml'; then
      echo "  🔴 第 $LINENUM 行: innerHTML 赋值可能未转义"
      echo "     $line"
      UNSAFE_COUNT=$((UNSAFE_COUNT + 1))
    fi
  done <<< "$INNERHTML_LINES"
fi
if [ $UNSAFE_COUNT -eq 0 ]; then
  echo "  ✅ 所有 innerHTML 赋值已检查"
else
  echo "  ⚠️  共 $UNSAFE_COUNT 处 innerHTML 需人工确认"
fi

# 3. 检查定时器是否配对
echo ""
echo "[3] 定时器配对检查..."
SET_INTERVAL=$(grep -c 'setInterval' "$APP" || true)
CLEAR_INTERVAL=$(grep -c 'clearInterval' "$APP" || true)
SET_TIMEOUT=$(grep -c 'setTimeout' "$APP" || true)
CLEAR_TIMEOUT=$(grep -c 'clearTimeout' "$APP" || true)

echo "  setInterval: $SET_INTERVAL | clearInterval: $CLEAR_INTERVAL"
echo "  setTimeout: $SET_TIMEOUT | clearTimeout: $CLEAR_TIMEOUT"

if [ "$SET_INTERVAL" -gt "$CLEAR_INTERVAL" ]; then
  echo "  ⚠️  setInterval 数量($SET_INTERVAL) > clearInterval($CLEAR_INTERVAL)，可能有泄漏"
fi

# 4. var 声明检查
echo ""
echo "[4] var 声明检查..."
VAR_COUNT=$(grep -c '\bvar\s' "$APP" || true)
echo "  var 声明数: $VAR_COUNT"
if [ "$VAR_COUNT" -gt 0 ]; then
  echo "  ℹ️  以下 var 声明 (应确认是否可以改为 const/let):"
  grep -n '\bvar\s' "$APP" | head -10
fi

# 5. 内联 style 检查
echo ""
echo "[5] 内联 style 检查..."
INLINE_STYLE=$(grep -n 'style="' "$HTML" || true)
INLINE_COUNT=$(echo "$INLINE_STYLE" | grep -c 'style=' || true)
echo "  HTML 内联 style 数量: $INLINE_COUNT"
if [ "$INLINE_COUNT" -gt 0 ]; then
  echo "  ℹ️  内联 style 位置:"
  echo "$INLINE_STYLE" | while read line; do echo "    $line"; done
fi

# 6. 事件监听器内存泄漏检查
echo ""
echo "[6] 事件监听器检查..."
ADD_LISTENER=$(grep -c 'addEventListener' "$APP" || true)
REMOVE_LISTENER=$(grep -c 'removeEventListener' "$APP" || true)
echo "  addEventListener: $ADD_LISTENER | removeEventListener: $REMOVE_LISTENER"
if [ "$ADD_LISTENER" -gt 0 ] && [ "$REMOVE_LISTENER" -eq 0 ]; then
  echo "  ⚠️  无 removeEventListener 调用，确认所有监听器使用 { once: true } 或已在 cleanVideo 中清理"
fi

# 7. TODO/FIXME 检查
echo ""
echo "[7] TODO/FIXME 检查..."
TODOS=$(grep -n -i 'todo\|fixme\|hack\|xxx\|temp' "$APP" "$CSS" "$HTML" 2>/dev/null || true)
if [ -n "$TODOS" ]; then
  echo "  ℹ️  发现标记:"
  echo "$TODOS" | while read line; do echo "    $line"; done
else
  echo "  ✅ 未发现 TODO/FIXME"
fi

# 8. console.log 残留检查
echo ""
echo "[8] console 残留检查..."
CONSOLE_COUNT=$(grep -c 'console\.' "$APP" || true)
echo "  console.* 调用数: $CONSOLE_COUNT"
if [ "$CONSOLE_COUNT" -gt 2 ]; then
  echo "  ℹ️  生产代码中 console 调用 (console.error 除外):"
  grep -n 'console\.' "$APP" | grep -v 'console\.error' | head -10
fi

# 9. 文件大小检查
echo ""
echo "[9] 文件大小检查..."
APP_LINES=$(wc -l < "$APP")
CSS_LINES=$(wc -l < "$CSS")
HTML_LINES=$(wc -l < "$HTML")
echo "  app.js: $APP_LINES 行"
echo "  styles.css: $CSS_LINES 行"
echo "  index.html: $HTML_LINES 行"
if [ "$APP_LINES" -gt 2500 ]; then
  echo "  ⚠️  app.js 超过 2500 行，建议考虑模块拆分"
  ERRORS=$((ERRORS + 1))
fi

# 10. CONFIG 值使用检查
echo ""
echo "[10] CONFIG 引用检查..."
CONFIG_KEYS=$(grep -oP "CONFIG\.\w+" "$APP" | sort -u | wc -l)
echo "  不同 CONFIG key 引用数: $CONFIG_KEYS"

echo ""
echo "========================================="
echo "  检查完成"
echo "========================================="
```

### 5.2 Node.js 脚本：结构分析

创建 `scripts/analyze-structure.js`：

```javascript
#!/usr/bin/env node
/**
 * Watch Together - 代码结构分析脚本
 * 用法: node scripts/analyze-structure.js
 */
const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '..', 'app.js');

const source = fs.readFileSync(APP_FILE, 'utf-8');
const lines = source.split('\n');

// 1. 模块分布分析
console.log('📊 模块分布分析\n');
const modulePattern = /^\/\/\s=+\s*$/;
const moduleNamePattern = /^\/\/\s(.+?)\s*$/;

let currentModule = 'TOP LEVEL';
const modules = {};
let moduleStart = 1;

lines.forEach((line, i) => {
  if (modulePattern.test(line) && i + 1 < lines.length) {
    const nameMatch = lines[i + 1].match(moduleNamePattern);
    if (nameMatch && nameMatch[1] !== '=') {
      if (!modules[currentModule]) modules[currentModule] = { start: moduleStart, end: i, lines: 0 };
      modules[currentModule].end = i;
      modules[currentModule].lines = i - modules[currentModule].start;
      currentModule = nameMatch[1].trim();
      moduleStart = i;
    }
  }
});
modules[currentModule] = { start: moduleStart, end: lines.length, lines: lines.length - moduleStart };

console.log('Module'.padEnd(35) + 'Lines'.padEnd(8) + 'Range');
console.log('-'.repeat(55));
for (const [name, info] of Object.entries(modules)) {
  if (info.lines > 0) {
    console.log(
      name.padEnd(35) +
      String(info.lines).padEnd(8) +
      `${info.start}-${info.end}`
    );
  }
}

// 2. 函数统计
console.log('\n📊 函数统计\n');
const funcPattern = /^(?:async\s+)?function\s+(\w+)/;
const arrowPattern = /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/;
const functions = [];

lines.forEach((line, i) => {
  const funcMatch = line.match(funcPattern);
  const arrowMatch = line.match(arrowPattern);
  if (funcMatch) {
    functions.push({ name: funcMatch[1], line: i + 1, type: 'function' });
  } else if (arrowMatch && !arrowMatch[1].match(/^(CONFIG|State|dom|\$)/)) {
    functions.push({ name: arrowMatch[1], line: i + 1, type: 'arrow' });
  }
});

console.log(`总函数数: ${functions.length}`);

// 3. 复杂度警告
console.log('\n📊 函数复杂度警告 (按行数)\n');
functions.forEach(f => {
  // 简单估算：找下一个函数声明或模块分隔符
  const start = f.line - 1;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (funcPattern.test(lines[j]) ||
        (arrowPattern.test(lines[j]) && j > start + 1) ||
        modulePattern.test(lines[j])) {
      end = j;
      break;
    }
  }
  const funcLines = end - start;
  if (funcLines > 50) {
    console.log(`  ⚠️  ${f.name}(): ${funcLines} 行 — 建议拆分`);
  }
});

// 4. Error handling 统计
console.log('\n📊 错误处理统计\n');
const tryCount = (source.match(/\btry\s*\{/g) || []).length;
const catchCount = (source.match(/\bcatch\s*\(/g) || []).length;
const emptyCatchCount = (source.match(/catch\s*\(\s*\w+\s*\)\s*\{\s*\}/g) || []).length;

console.log(`  try 块: ${tryCount}`);
console.log(`  catch 块: ${catchCount}`);
console.log(`  空 catch 块: ${emptyCatchCount}`);

if (emptyCatchCount > 0) {
  console.log(`  ⚠️  发现 ${emptyCatchCount} 个空 catch 块，建议添加注释`);
}
```

### 5.3 手动检查命令速查

```bash
# 搜索所有 catch 块
grep -n 'catch' app.js

# 搜索 innerHTML 赋值
grep -n 'innerHTML\s*=' app.js

# 搜索 setInterval/setTimeout
grep -n 'setInterval\|setTimeout' app.js

# 搜索对应的 clear 操作
grep -n 'clearInterval\|clearTimeout' app.js

# 搜索 console 残留
grep -n 'console\.' app.js

# 搜索 var 声明
grep -n '\bvar\s' app.js

# 搜索内联 style
grep -n 'style="' index.html

# 搜索魔法数字（排除常见常量）
grep -nP '(?<![\w.])[5-9]\d{2,}(?![\w])' app.js | grep -v 'CONFIG\|1024\|2000\|3500\|5000\|4000'
```

---

## 6. 附录

### A. 审查报告模板

```markdown
## Code Review Report

**PR**: #XXX | **审查者**: @name | **日期**: YYYY-MM-DD
**变更文件**: app.js (+120 / -45), styles.css (+10 / -2)

### 审查摘要

| 维度 | Blocker | Warning | Suggestion |
|------|---------|---------|------------|
| 安全性 | 0 | 1 | 0 |
| 同步逻辑 | 0 | 0 | 1 |
| 错误处理 | 1 | 0 | 0 |
| 性能 | 0 | 1 | 0 |
| 可维护性 | 0 | 0 | 2 |
| DOM 规范 | 0 | 1 | 0 |

### Blocker 问题

#### B1: [安全性] innerHTML 未转义 — renderSearchResults() L840
...

### Warning 问题

#### W1: [性能] 缺少请求去重 — doSearch() L807
...

### 判定

- [ ] Approve (所有 Blocker 已解决)
- [ ] Request Changes (存在未解决 Blocker)
- [ ] Comment (仅建议)
```

### B. 已知风险清单

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| PeerJS 信令服务不可用 | 无法创建/加入房间 | 双信令服务器降级 |
| TURN 中继不可用 | 对称 NAT 用户无法连接 | 使用 metered.ca 免费 TURN |
| B站 API 限流 | B站视频解析失败 | 降级到搜索模式 |
| 茶杯狐域名变更 | 搜索不可用 | legacy mirror 降级 |
| cobalt.tools API 变更 | 通用解析失效 | 本地正则回退 |
| HLS 流过期 | 视频无法播放 | showVideoError 提示 |

### C. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-02 | v1.0 | 初始版本，基于 v24 代码库制定 |
