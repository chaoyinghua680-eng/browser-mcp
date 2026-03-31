# Browser MCP

让 AI（Claude Desktop / Cursor）通过 MCP 协议安全访问你浏览器中已登录的网站数据。

## 系统架构

项目由三个部分协同工作：

```
AI 客户端 (Claude/Cursor)
    ↓ MCP 协议 (Stdio)
MCP Server (mcp-server/)
    ↓ HTTP (localhost:3282)
Native Host (native-host/)
    ↓ Native Messaging (Stdio)
Chrome Extension (chrome-extension/)
    ↓ chrome.tabs.sendMessage
User Script (scripts/)
    ↓ DOM 抓取
目标网页
```

## 环境要求

- Node.js >= 18
- npm >= 9
- Google Chrome（支持 Manifest V3）
- Claude Desktop 或 Cursor

---

## 启动流程

### 第一步：克隆并安装依赖

```bash
git clone <仓库地址>
cd browser-mcp

# 安装三个子模块的依赖
cd mcp-server && npm install && cd ..
cd native-host && npm install && cd ..
cd chrome-extension && npm install && cd ..
```

### 第二步：编译 TypeScript

```bash
# 编译 MCP Server
cd mcp-server && npm run build && cd ..

# 编译 Native Host
cd native-host && npm run build && cd ..

# 编译 Chrome Extension
cd chrome-extension && npm run build && cd ..
```

### 第三步：加载 Chrome 插件

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目中的 `chrome-extension/` 目录
5. 插件加载后，记录页面上显示的 **插件 ID**（格式如 `abcdefghijklmnopqrstuvwxyzabcdef`）

### 第四步：注册 Native Messaging Host

运行一键安装脚本，将上一步获取的插件 ID 作为参数传入：

```bash
bash install.sh <你的插件ID>
```

脚本会自动：
- 在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` 创建注册文件
- 在 `native-host/` 目录生成 `start.sh` 启动包装脚本

> **注意**：此步骤仅需执行一次。重新编译 native-host 后无需重复注册，但若插件 ID 变更则需重新运行。

### 第五步：配置 Claude Desktop

1. 复制配置示例文件：

```bash
cp claude_desktop_config.json.example ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

2. 编辑该文件，将路径替换为实际绝对路径：

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/你的实际路径/browser-mcp/mcp-server/dist/index.js"]
    }
  }
}
```

> 如果使用 **Cursor**，在 Cursor 的 MCP 设置中填入同样的 `command` 和 `args`。

### 第六步：启动各组件

按以下顺序启动：

**① 重启 Chrome**（使 Native Messaging Host 注册生效）

**② 确认插件已激活**
Chrome 工具栏应出现 Browser MCP 图标，控制台（`chrome://extensions` → 插件 → Service Worker → 检查）打印：
```
[BrowserMCP] Native Messaging 已连接
```

**③ 启动 MCP Server**（由 Claude Desktop / Cursor 自动管理，无需手动启动）
AI 客户端启动时会根据配置文件自动通过 Stdio 拉起 `mcp-server/dist/index.js`。

**④ 重启 Claude Desktop 或 Cursor**
使 MCP 配置生效。工具列表中应出现 `get_taobao_orders`、`get_jd_orders` 等工具。

---

## 安装 User Script

User Script 是在目标网页内执行 DOM 抓取的脚本，需要通过插件 Popup 手动安装：

1. 点击 Chrome 工具栏中的 **Browser MCP** 图标
2. 在弹出的 Popup 中，点击需要的脚本旁边的 **安装** 按钮（如"淘宝订单"、"京东订单"）
3. 安装后，访问对应网站时脚本将自动生效

---

## 验证是否正常运行

在 Claude Desktop 或 Cursor 中发送：

```
帮我查一下我的淘宝最近的订单
```

如果 AI 能正确返回订单数据，说明整个链路工作正常。

---

## 目录结构

```
browser-mcp/
├── mcp-server/          # MCP Server，处理 AI 客户端的工具调用请求
│   ├── src/
│   │   ├── index.ts     # 入口，注册 MCP tools/list 和 tools/call handler
│   │   ├── tools.ts     # 工具声明与参数白名单校验
│   │   └── http-bridge.ts  # 转发请求到 Native Host (localhost:3282)
│   └── dist/            # 编译产物（npm run build 后生成）
│
├── native-host/         # Native Messaging Host，桥接 Chrome 与 MCP Server
│   ├── src/
│   │   └── index.ts     # HTTP Server (3282) + Chrome Stdio 双协议桥接
│   ├── dist/            # 编译产物
│   └── start.sh         # Chrome 启动包装脚本（install.sh 自动生成）
│
├── chrome-extension/    # Chrome 扩展
│   ├── manifest.json    # 扩展声明（MV3）
│   ├── background.ts    # Service Worker，管理 Native Messaging 连接
│   ├── popup/           # 插件 Popup UI，用于安装/卸载 User Script
│   └── dist/            # 编译产物
│
├── scripts/             # User Script 脚本（在目标页面内执行 DOM 抓取）
│   ├── taobao_orders.js # 淘宝订单抓取
│   └── jd_orders.js     # 京东订单抓取
│
├── install.sh           # 一键注册 Native Messaging Host（macOS）
└── claude_desktop_config.json.example  # Claude Desktop 配置示例
```

---

## 常见问题

**Q: Chrome 控制台没有打印 "Native Messaging 已连接"**
A: 检查 `install.sh` 是否使用了正确的插件 ID；确认 `native-host/dist/index.js` 存在；尝试重启 Chrome。

**Q: Claude Desktop 看不到 MCP 工具**
A: 确认 `claude_desktop_config.json` 中的路径为绝对路径；重启 Claude Desktop；检查 MCP Server 编译是否成功（`mcp-server/dist/index.js` 是否存在）。

**Q: 工具调用返回超时**
A: Native Host 内置 30 秒超时。检查目标网站是否已打开并登录；确认 User Script 是否已通过 Popup 安装。

**Q: 插件 ID 变了怎么办**
A: 重新运行 `bash install.sh <新插件ID>` 并重启 Chrome。
