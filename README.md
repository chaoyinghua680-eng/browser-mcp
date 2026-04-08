# Browser MCP

让 AI（Claude Desktop / Cursor）通过 MCP 协议访问你浏览器中已登录的网站数据。

## 系统架构

```
AI 客户端 (Claude/Cursor)
    ↓ MCP 协议 (Stdio)
MCP Server (mcp-server/)
    ↓ HTTP (localhost:3282)
Bridge Server (native-host/)
    ↓ WebSocket (localhost:3283)
Native Host (native-host/) ← Chrome 按需启动
    ↓ Native Messaging
Chrome Extension (chrome-extension/)
    ↓ chrome.tabs.sendMessage
User Script (注册在目标页面)
    ↓ DOM 抓取
目标网页
```

## 环境要求

- Node.js >= 18（路径：`/opt/homebrew/bin/node`）
- Google Chrome（开发者模式）
- Claude Desktop 或 Cursor

---

## 首次安装

### 1. 安装依赖并编译

```bash
cd browser-mcp

cd mcp-server && npm install && npm run build && cd ..
cd native-host && npm install && npm run build && cd ..
cd chrome-extension && npm install && npx tsc && cd ..
```

### 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`
2. 右上角开启**开发者模式**
3. 点击**加载已解压的扩展程序** → 选择 `chrome-extension/` 目录
4. 记录页面上显示的**插件 ID**

### 3. 注册 Native Messaging Host

```bash
bash install.sh <你的插件ID>
```

> 插件 ID 变更后需重新运行此命令。

### 4. 配置 AI 客户端

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

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

Cursor 用户在 MCP 设置中填入相同的 `command` 和 `args`。

### 5. 安装 User Script

1. 点击 Chrome 工具栏中的 **Browser MCP** 图标
2. 在 Popup 中点击对应脚本的**安装**按钮（如"淘宝订单"、"京东订单"）

---

## 每次启动流程

**① 启动 Bridge Server**

```bash
cd /你的路径/browser-mcp/native-host && npm start
```

**② 确认 Chrome 扩展已连接**

`chrome://extensions` → Browser MCP → Service Worker → 检查，控制台应显示：
```
[BrowserMCP] Native Messaging 已连接
```

**③ 打开目标网站并保持登录状态**（如淘宝、京东）

**④ 启动 Claude Desktop 或 Cursor**

---

## 验证

在 AI 客户端中发送：
```
帮我查一下我的淘宝最近的订单
```

---

## 常见问题

**Q: 控制台报 `chrome.userScripts 不可用`**
A: `chrome://extensions` 右上角确认已开启**开发者模式**。

**Q: 控制台报 `Access to the specified native messaging host is forbidden`**
A: 插件 ID 变了，重新运行 `bash install.sh <新插件ID>` 并在 `chrome://extensions` 刷新扩展。

**Q: 工具调用返回"脚本未注册"**
A: 点击插件 Popup，安装对应的 User Script。

**Q: 工具调用超时**
A: 确认 Bridge Server 已启动（`npm start`）；确认目标网站 Tab 已打开并登录。

**Q: 插件加载了但没有新代码生效**
A: 重新编译后需在 `chrome://extensions` 点刷新按钮，或移除后重新加载。
