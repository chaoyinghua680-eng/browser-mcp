#!/usr/bin/env bash
#
# browser-mcp 一键启动脚本
# 用法:
#   ./start.sh          — 直接启动（跳过构建）
#   ./start.sh --build  — 先构建再启动
#   ./start.sh --stop   — 停止所有服务
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_HOST_DIR="$ROOT_DIR/native-host"
MCP_SERVER_DIR="$ROOT_DIR/mcp-server"

NATIVE_HOST_PORT=3282
SSE_SERVER_PORT=8006

# 日志文件
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"
NATIVE_HOST_LOG="$LOG_DIR/native-host.log"
SSE_SERVER_LOG="$LOG_DIR/sse-server.log"

# ─── 颜色 ────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[  OK]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[FAIL]${NC}  $*"; }

# ─── 杀掉占用端口的进程 ─────────────────────────────────
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "端口 $port 被占用，正在终止进程: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

# ─── 等待端口就绪 ────────────────────────────────────────
wait_for_port() {
  local port=$1
  local name=$2
  local max_wait=15
  local waited=0

  while ! lsof -ti :"$port" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [ $waited -ge $max_wait ]; then
      error "$name 未能在 ${max_wait}s 内启动"
      error "查看日志: $3"
      return 1
    fi
  done
  return 0
}

# ─── 健康检查 ────────────────────────────────────────────
health_check() {
  local url=$1
  local name=$2
  local result
  result=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$result" = "200" ]; then
    success "$name 健康检查通过 ✓"
    return 0
  else
    error "$name 健康检查失败 (HTTP $result)"
    return 1
  fi
}

# ─── 停止所有服务 ─────────────────────────────────────────
stop_all() {
  echo ""
  echo -e "${BOLD}🛑 停止 browser-mcp 服务...${NC}"
  echo ""
  kill_port $NATIVE_HOST_PORT
  kill_port $SSE_SERVER_PORT
  success "所有服务已停止"
  echo ""
}

# ─── 构建 ────────────────────────────────────────────────
build_all() {
  echo ""
  echo -e "${BOLD}🔨 构建项目...${NC}"
  echo ""

  info "构建 native-host..."
  (cd "$NATIVE_HOST_DIR" && npm run build) || { error "native-host 构建失败"; exit 1; }
  success "native-host 构建完成"

  info "构建 mcp-server..."
  (cd "$MCP_SERVER_DIR" && npm run build) || { error "mcp-server 构建失败"; exit 1; }
  success "mcp-server 构建完成"

  echo ""
}

# ─── 启动 ────────────────────────────────────────────────
start_all() {
  echo ""
  echo -e "${BOLD}🚀 启动 browser-mcp 服务${NC}"
  echo -e "   项目目录: ${CYAN}$ROOT_DIR${NC}"
  echo ""

  # 1. 清理旧进程
  info "检查端口占用..."
  kill_port $NATIVE_HOST_PORT
  kill_port $SSE_SERVER_PORT
  success "端口已清理"

  # 2. 检查 dist 目录
  if [ ! -f "$NATIVE_HOST_DIR/dist/bridge-server.js" ]; then
    warn "native-host 未构建，正在自动构建..."
    (cd "$NATIVE_HOST_DIR" && npm run build) || { error "构建失败"; exit 1; }
  fi
  if [ ! -f "$MCP_SERVER_DIR/dist/sse-server.js" ]; then
    warn "mcp-server 未构建，正在自动构建..."
    (cd "$MCP_SERVER_DIR" && npm run build) || { error "构建失败"; exit 1; }
  fi

  # 3. 启动 Bridge Server
  info "启动 Bridge Server (端口 $NATIVE_HOST_PORT)..."
  (cd "$NATIVE_HOST_DIR" && node dist/bridge-server.js >> "$NATIVE_HOST_LOG" 2>&1) &
  BRIDGE_SERVER_PID=$!

  if wait_for_port $NATIVE_HOST_PORT "Bridge Server" "$NATIVE_HOST_LOG"; then
    success "Bridge Server 已启动 (PID: $BRIDGE_SERVER_PID)"
  else
    exit 1
  fi

  # 4. 启动 SSE MCP Server
  info "启动 SSE MCP Server (端口 $SSE_SERVER_PORT)..."
  (cd "$MCP_SERVER_DIR" && node dist/sse-server.js >> "$SSE_SERVER_LOG" 2>&1) &
  SSE_SERVER_PID=$!

  if wait_for_port $SSE_SERVER_PORT "SSE MCP Server" "$SSE_SERVER_LOG"; then
    success "SSE MCP Server 已启动 (PID: $SSE_SERVER_PID)"
  else
    exit 1
  fi

  # 5. 健康检查
  echo ""
  info "运行健康检查..."
  sleep 1
  health_check "http://localhost:$NATIVE_HOST_PORT/health" "Bridge Server"
  health_check "http://localhost:$SSE_SERVER_PORT/health" "SSE MCP Server"

  # 6. 输出摘要
  echo ""
  echo -e "${BOLD}┌─────────────────────────────────────────────────┐${NC}"
  echo -e "${BOLD}│${NC}  ${GREEN}✅ browser-mcp 已成功启动!${NC}                     ${BOLD}│${NC}"
  echo -e "${BOLD}├─────────────────────────────────────────────────┤${NC}"
  echo -e "${BOLD}│${NC}                                                 ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  Bridge Server: ${CYAN}http://localhost:$NATIVE_HOST_PORT${NC}        ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  SSE Server:    ${CYAN}http://localhost:$SSE_SERVER_PORT${NC}         ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  SSE 端点:      ${CYAN}http://localhost:$SSE_SERVER_PORT/sse${NC}     ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}                                                 ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  日志目录:      ${YELLOW}.logs/${NC}                          ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  停止服务:      ${YELLOW}./start.sh --stop${NC}                ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}                                                 ${BOLD}│${NC}"
  echo -e "${BOLD}│${NC}  ${RED}⚠  请确保 Chrome 浏览器 + 插件已打开${NC}           ${BOLD}│${NC}"
  echo -e "${BOLD}└─────────────────────────────────────────────────┘${NC}"
  echo ""

  # 7. 前台等待（Ctrl+C 可退出）
  info "服务已在后台运行，按 ${BOLD}Ctrl+C${NC} 停止所有服务"
  echo ""

  # 捕获退出信号，清理子进程
  trap 'echo ""; warn "正在停止服务..."; kill $BRIDGE_SERVER_PID $SSE_SERVER_PID 2>/dev/null; success "服务已停止"; exit 0' INT TERM

  # 等待子进程
  wait
}

# ─── 主入口 ──────────────────────────────────────────────
case "${1:-}" in
  --stop)
    stop_all
    ;;
  --build)
    build_all
    start_all
    ;;
  --help|-h)
    echo ""
    echo -e "${BOLD}browser-mcp 启动脚本${NC}"
    echo ""
    echo "用法:"
    echo "  ./start.sh          直接启动服务"
    echo "  ./start.sh --build  先构建再启动"
    echo "  ./start.sh --stop   停止所有服务"
    echo "  ./start.sh --help   显示帮助信息"
    echo ""
    ;;
  "")
    start_all
    ;;
  *)
    error "未知选项: $1"
    echo "使用 ./start.sh --help 查看帮助"
    exit 1
    ;;
esac
