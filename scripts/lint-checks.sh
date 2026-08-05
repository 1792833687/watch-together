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
