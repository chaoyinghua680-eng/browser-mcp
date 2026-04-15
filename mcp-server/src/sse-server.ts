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

// ---------- OpenAI 兼容端点（供 Clawith 等客户端直接调用）----------
app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const { messages, model = "deepseek-chat", stream = false } = req.body;

  if (!Array.isArray(messages)) {
    res.status(400).json({
      error: { message: "messages 必须是数组", type: "invalid_request_error" },
    });
    return;
  }

  if (
    messages.length > 1 ||
    messages.some((message: any) => message?.role !== "user")
  ) {
    console.warn(
      "[sse-server] 警告: 收到多轮消息，当前为 single-turn 模式，只取最后一条 user 消息，system/assistant 均被忽略"
    );
  }

  // 取最后一条 user 消息作为输入
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  if (!lastUser) {
    res.status(400).json({ error: { message: "请求中未找到 user 消息", type: "invalid_request_error" } });
    return;
  }
  const message = typeof lastUser.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser.content)
      ? lastUser.content.map((c: any) => c.text ?? "").join("")
      : "";

  if (!message) {
    res.status(400).json({ error: { message: "user 消息内容为空", type: "invalid_request_error" } });
    return;
  }

  if (model !== "deepseek-chat") {
    res.status(400).json({
      error: {
        message: `不支持的 model: ${model}，当前仅支持 deepseek-chat`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const scriptName = "deepseek_send_message";
  const scriptParams: Record<string, unknown> = { message };

  console.log(`[sse-server] /v1/chat/completions → ${scriptName} (model=${model})`);

  try {
    const result = await callNativeHost(scriptName, scriptParams) as any;
    const content = typeof result?.content === "string" ? result.content : "";
    if (!content) {
      throw new Error("[DeepSeek] 收到空响应");
    }

    if (stream) {
      // 伪流式：一次性发送完整内容
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const chunk = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    const status = errMsg.includes("正在处理中") ? 429 : 502;
    console.error(`[sse-server] /v1/chat/completions 错误: ${errMsg}`);
    res.status(status).json({
      error: {
        message: errMsg,
        type: status === 429 ? "rate_limit_error" : "upstream_error",
      },
    });
  }
});

// 健康检查
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: transports.size });
});

// ---------- 启动 ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[sse-server] MCP SSE Server 已启动`);
  console.log(`[sse-server]   SSE 端点:    http://0.0.0.0:${PORT}/sse`);
  console.log(`[sse-server]   消息端点:    http://0.0.0.0:${PORT}/message`);
  console.log(`[sse-server]   Streamable:  http://0.0.0.0:${PORT}/mcp`);
  console.log(`[sse-server]   OpenAI 兼容: http://0.0.0.0:${PORT}/v1/chat/completions`);
  console.log(`[sse-server]   健康检查:    http://0.0.0.0:${PORT}/health`);
});
