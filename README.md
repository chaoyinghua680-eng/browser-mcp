# Browser MCP

让 AI（Claude / Cursor 等）通过 MCP 协议，直接访问浏览器中**已登录**的网站数据，无需 API Key。

目前支持：

- 📦 **淘宝订单**查询（`get_taobao_orders`）
- 📦 **京东订单**查询（`get_jd_orders`）
- 🤖 **DeepSeek 网页版**对话（`deepseek_send_message`，复用浏览器登录态）

---

## 系统架构

```text
AI 客户端（Claude Code / Cursor）
    ↓ MCP 协议（Stdio）
MCP Server（mcp-server/）
    ↓ HTTP → localhost:3282
Bridge Server（native-host/src/bridge-server.ts）
    ↓ WebSocket → localhost:3283
Native Host（native-host/src/index.ts，由 Chrome 拉起）
    ↓ Native Messaging（stdin/stdout 二进制帧）
Chrome Extension Background（chrome-extension/background.ts）
    ↓ chrome.scripting / chrome.tabs.sendMessage
目标网页（淘宝 / 京东 / DeepSeek）
```

> **SSE 模式**（可选）：`mcp-server/src/sse-server.ts` 额外提供 SSE、Streamable HTTP 和 OpenAI 兼容接口（`/v1/chat/completions`），供不支持 Stdio 的客户端或 curl 使用。

---

## 环境要求

- Node.js ≥ 18
- npm ≥ 9
- Google Chrome（Manifest V3，需开启**开发者模式**）
- Claude Code CLI / Claude Desktop / Cursor（任选其一）

---

## 安装步骤

### 第一步：克隆并安装依赖、编译

```bash
git clone <仓库地址>
cd browser-mcp

cd mcp-server && npm install && npm run build && cd ..
cd native-host && npm install && npm run build && cd ..
cd chrome-extension && npm install && npm run build && cd ..
```

---

### 第二步：加载 Chrome 插件

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角开启**开发者模式**
3. 点击**加载已解压的扩展程序**，选择项目中的 `chrome-extension/` 目录
4. 记录页面上显示的**插件 ID**（格式如 `abcdefghijklmnopqrstuvwxyzabcdef`）

---

### 第三步：注册 Native Messaging Host

#### macOS / Linux

```bash
bash install.sh <你的插件ID>
```

#### Windows（PowerShell）

```powershell
.\install.ps1 <你的插件ID>
```

脚本会自动：

- 生成 Native Host 启动包装脚本（`start.sh` / `start.cmd`）
- 生成 Native Messaging manifest 文件
- macOS：写入 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Windows：写入注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\`

> 此步骤仅需执行一次。插件 ID 变更后需重新执行。

---

### 第四步：配置 AI 客户端

#### Claude Code CLI

运行以下命令，会自动写入配置，无需手动编辑文件：

```bash
claude mcp add browser-mcp node "/你的绝对路径/browser-mcp/mcp-server/dist/index.js"
```

#### Claude Desktop（需手动编辑配置文件）

配置文件路径：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`C:\Users\<用户名>\AppData\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/你的绝对路径/browser-mcp/mcp-server/dist/index.js"]
    }
  }
}
```

> Cursor：在 Cursor 设置界面的 MCP 配置中填入相同的 `command` 和 `args`，无需手动编辑文件。

---

### 第五步：安装 User Script（仅京东需要）

淘宝和 DeepSeek 的执行逻辑内置于插件，**无需安装 User Script**。

京东订单需要通过插件管理页面安装：

1. 点击 Chrome 工具栏中的 **Browser MCP** 图标
2. 点击 **⚙️ 管理脚本**，打开脚本管理页面
3. 点击右上角 **+ 新建脚本**，填写：
   - 工具名称：`get_jd_orders`
   - 目标网址：`https://order.jd.com/`
   - 脚本代码：粘贴 `scripts/jd_orders.js` 的内容
4. 点击**保存**

---

## 每次启动流程

### 方式一：一键启动（推荐）

**macOS / Linux：**

```bash
./start.sh
```

**Windows（PowerShell）：**

```powershell
.\start.ps1
```

脚本会自动完成：

- 清理端口占用
- 检测编译产物（未构建时自动构建）
- 在后台启动 Bridge Server（端口 3282）
- 在后台启动 SSE MCP Server（端口 8006）
- 运行健康检查
- 按 `Ctrl+C` 同时停止所有服务

其他选项：

```bash
./start.sh --build   # 先重新构建再启动
./start.sh --stop    # 停止所有服务
```

---

### 方式二：手动启动

#### ① 启动 Bridge Server（持久运行，不要关闭）

```bash
cd native-host
npm run start:bridge
```

启动后应看到：

```text
[Bridge Server] WebSocket 已启动 → ws://127.0.0.1:3283
[Bridge Server] HTTP 已启动 → http://127.0.0.1:3282
```

#### ② 可选：启动 SSE MCP Server

仅在需要通过 HTTP 调用（curl、OpenAI 兼容客户端）时才需要：

```bash
cd mcp-server
npm run start:sse
```

---

### ③ 确认 Chrome 插件已连接

`chrome://extensions` → Browser MCP → Service Worker → 检查，控制台应显示：

```text
[BrowserMCP] Native Messaging 已连接
```

### ④ 打开目标网站并登录

- 淘宝：打开 `https://buyertrade.taobao.com`，确保已登录
- 京东：打开 `https://order.jd.com/center/list.action`，确保已登录
- DeepSeek：打开 `https://chat.deepseek.com`，确保已登录

> 如果未登录，页面顶部会自动出现提示横幅，等待你登录后自动继续（最长等待 60 秒）。

### ⑤ 启动 AI 客户端

Claude Code CLI、Claude Desktop 或 Cursor 会根据配置自动管理 Stdio MCP Server，无需手动启动。

> **说明**：一键脚本启动的是 Bridge Server + SSE MCP Server，AI 客户端另外自动启动 Stdio MCP Server，两者走不同通道（HTTP vs Stdio），互不冲突。

---

## 使用示例

在 AI 客户端中直接对话：

```text
帮我查一下淘宝最近的订单
```

```text
帮我查一下京东第二页的订单
```

```text
用 DeepSeek 帮我分析一下量子计算的原理
```

---

## SSE 模式（可选）

如需通过 HTTP 接入（如 curl、OpenAI 兼容客户端），可启动 SSE Server：

```bash
cd mcp-server
npm run start:sse
# 默认监听 0.0.0.0:8006，可通过 --port 指定端口
```

提供以下端点：

| 端点 | 协议 | 用途 |
| --- | --- | --- |
| `GET /sse` | SSE | 标准 MCP SSE 长连接 |
| `POST /message?sessionId=xxx` | HTTP | SSE 协议消息端点 |
| `ALL /mcp` | Streamable HTTP | 新版 MCP Streamable HTTP |
| `POST /v1/chat/completions` | OpenAI 兼容 | 直接调用 DeepSeek（model: deepseek-chat） |
| `GET /health` | HTTP | 健康检查 |

**Windows PowerShell 测试：**

```powershell
Invoke-RestMethod -Uri "http://localhost:8006/v1/chat/completions" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

---

## 脚本管理页面

点击插件图标 → **⚙️ 管理脚本**，可打开独立的脚本管理页面，支持：

- **新建脚本**：填写工具名称、目标 URL、JS 代码
- **编辑脚本**：修改已有脚本的代码和目标 URL
- **启用 / 禁用**：临时关闭某个脚本，不影响数据
- **删除脚本**：永久移除

脚本数据存储在 `chrome.storage.local`，重启浏览器后自动恢复。

---

## 目录结构

```text
browser-mcp/
├── mcp-server/                # MCP Server
│   └── src/
│       ├── index.ts           # Stdio 模式入口（Claude Code / Desktop）
│       ├── sse-server.ts      # SSE / HTTP 模式入口（可选）
│       ├── tools.ts           # 工具声明与参数校验
│       └── http-bridge.ts     # HTTP 调用 Bridge Server
│
├── native-host/               # Native Host + Bridge Server
│   └── src/
│       ├── index.ts           # Native Host（Chrome 自动拉起）
│       └── bridge-server.ts   # Bridge Server（手动启动，持久运行）
│
├── chrome-extension/          # Chrome 扩展
│   ├── background.ts          # Service Worker（核心调度）
│   ├── popup/                 # 工具栏弹窗（只读展示 + 跳转）
│   ├── manager/               # 脚本管理页面（独立 Tab）
│   └── manifest.json
│
├── scripts/                   # User Script 参考实现
│   ├── taobao_orders.js       # 淘宝（仅 PING，实际逻辑内置于插件）
│   └── jd_orders.js           # 京东订单抓取
│
├── install.sh                 # macOS / Linux 一键安装
└── install.ps1                # Windows 一键安装
```

---

## 常见问题

### Q：Chrome 控制台没有打印 "Native Messaging 已连接"

检查 Bridge Server 是否已启动（`npm run start:bridge`）；确认安装脚本使用了正确的插件 ID；尝试重启 Chrome。

### Q：AI 客户端看不到 MCP 工具

确认 MCP Server 配置中的路径为绝对路径；重启 AI 客户端；检查 `mcp-server/dist/index.js` 是否存在。

### Q：调用工具时报 "fetch failed" 或 "Native Host 返回错误 500"

确认 Bridge Server 已启动（`npm run start:bridge`）。

### Q：调用工具时报 "脚本未注册"

京东需在脚本管理页面手动安装 `get_jd_orders`；淘宝和 DeepSeek 无需安装脚本，直接调用即可。

### Q：调用工具时报 "等待登录超时"

确保在提示横幅出现后的 60 秒内完成登录。若横幅未出现，请手动刷新目标网站页面后重试。

### Q：`chrome.userScripts` 不可用

前往 `chrome://extensions`，确认右上角已开启**开发者模式**，然后重新加载插件。

### Q：修改了脚本代码后不生效

在脚本管理页面重新保存对应脚本；若目标页面已打开，刷新目标页面使新脚本生效。

### Q：插件 ID 变了怎么办

重新运行 `bash install.sh <新插件ID>`（macOS）或 `.\install.ps1 <新插件ID>`（Windows），然后重启 Chrome。
