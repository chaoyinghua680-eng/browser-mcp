#!/usr/bin/env bash
# ────────────────────────────────────────────────
#  install.sh - 一键注册 Native Messaging Host（macOS）
#  用法：bash install.sh <你的Chrome插件ID>
# ────────────────────────────────────────────────
set -e

EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
  echo "用法: bash install.sh <Chrome插件ID>"
  echo "插件ID可在 chrome://extensions 开发者模式下查看"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_HOST_JS="$SCRIPT_DIR/native-host/dist/index.js"

if [ ! -f "$NATIVE_HOST_JS" ]; then
  echo "❌ 未找到 $NATIVE_HOST_JS，请先运行: cd native-host && npm install && npm run build"
  exit 1
fi

# 生成最终的 manifest（替换占位符）
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/com.browsermcp.host.json" <<EOF
{
  "name": "com.browsermcp.host",
  "description": "Browser MCP Native Messaging Host",
  "path": "/usr/local/bin/node",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

# 创建启动包装脚本（解决 Native Messaging 的环境变量问题）
WRAPPER="$SCRIPT_DIR/native-host/start.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$NATIVE_HOST_JS"
EOF
chmod +x "$WRAPPER"

# 用包装脚本路径更新 manifest
sed -i '' "s|/usr/local/bin/node|$WRAPPER|g" "$MANIFEST_DIR/com.browsermcp.host.json"

echo "✅ Native Messaging Host 已注册："
echo "   $MANIFEST_DIR/com.browsermcp.host.json"
echo ""
echo "下一步："
echo "  1. 重启 Chrome"
echo "  2. 启动 Native Host: cd native-host && npm start"
echo "  3. 配置 Claude Desktop（见 claude_desktop_config.json.example）"
