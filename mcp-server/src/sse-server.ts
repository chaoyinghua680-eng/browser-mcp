/**
 * SSE 模式入口 —— 每个 SSE 连接创建独立的 Server 实例
 * 解决 "Already connected to a transport" 问题
 *
 * 启动方式: node dist/sse-server.js [--port 8006]
 */
import express, { Request, Response, NextFunction } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getToolDefinitions, validateToolParams } from "./tools.js";
import { callNativeHost } from "./http-bridge.js";

// ---------- 配置 ----------
const PORT = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "8006",
  10
);

// ---------- MCP Server 工厂 ----------
// 每个 SSE 连接都需要独立的 Server 实例（MCP SDK 约束：Server 只能绑定一个 transport）
function createMcpServer(): Server {
  const server = new Server(
    { name: "browser-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // 列出所有可用工具
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefinitions() };
  });

  // 处理工具调用
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 严格参数白名单校验
    const validatedParams = validateToolParams(name, args ?? {});
    if (!validatedParams.ok) {
      return {
        content: [{ type: "text", text: `参数校验失败: ${validatedParams.error}` }],
        isError: true,
      };
    }

    try {
      const result = await callNativeHost(name, validatedParams.data);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `执行失败: ${(err as Error).message}\n\n请确认 Native Host 进程已启动（npm start in native-host/）`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ---------- Express + SSE ----------
const app = express();

// CORS（允许云端客户端跨域连接）
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// 请求日志
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[sse-server] ${req.method} ${req.url} (from ${req.ip})`);
  next();
});

app.use(express.json());

// 存储活跃的 transport（按 sessionId 索引）
const transports = new Map<string, SSEServerTransport>();

// GET /sse —— 建立 SSE 长连接
app.get("/sse", async (req: Request, res: Response) => {
  console.log(`[sse-server] 新 SSE 连接来自 ${req.ip}`);

  // 每个连接创建独立的 Server + Transport
  const server = createMcpServer();
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);
  console.log(`[sse-server] 会话 ${transport.sessionId} 已创建`);

  // 连接关闭时清理
  res.on("close", () => {
    console.log(`[sse-server] 会话 ${transport.sessionId} 已断开`);
    transports.delete(transport.sessionId);
    server.close().catch(() => {});
  });

  await server.connect(transport);
});

// POST /message?sessionId=xxx —— 接收客户端的 JSON-RPC 请求
app.post("/message", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.error(`[sse-server] 未找到会话: ${sessionId}`);
    res.status(404).json({ error: `未找到会话: ${sessionId}` });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ALL /mcp —— Streamable HTTP 端点（新版 MCP 协议）
app.all("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// 健康检查
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: transports.size });
});

// ---------- 启动 ----------
app.listen(PORT, () => {
  console.log(`[sse-server] MCP SSE Server 已启动`);
  console.log(`[sse-server]   SSE 端点:    http://localhost:${PORT}/sse`);
  console.log(`[sse-server]   消息端点:    http://localhost:${PORT}/message`);
  console.log(`[sse-server]   Streamable:  http://localhost:${PORT}/mcp`);
  console.log(`[sse-server]   健康检查:    http://localhost:${PORT}/health`);
});
