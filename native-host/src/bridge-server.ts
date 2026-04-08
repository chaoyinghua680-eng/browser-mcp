// ────────────────────────────────────────────────
//  Bridge Server（持久进程，由 start.sh 启动）
//  职责A: HTTP Server（localhost:3282）
//        接收来自 MCP Server 的工具调用请求
//  职责B: WebSocket Server（localhost:3283）
//        与 Native Host 进程保持长连接
//        将 HTTP 请求转发给 Native Host → Chrome → 回传结果
// ────────────────────────────────────────────────

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";

const HTTP_PORT = 3282;
const WS_PORT = 3283;

// 当前连接的 native host WebSocket
let nativeSocket: WebSocket | null = null;

// 等待 Chrome 响应的 Promise 映射
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

// ── WebSocket Server（等待 native host 连接）──
const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("listening", () => {
  process.stderr.write(`[Bridge Server] WebSocket 已启动 → ws://127.0.0.1:${WS_PORT}\n`);
});

wss.on("connection", (ws) => {
  process.stderr.write("[Bridge Server] Native Host 已连接\n");
  nativeSocket = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        requestId: string;
        data?: unknown;
        error?: string;
      };
      const pending = pendingRequests.get(msg.requestId);
      if (!pending) return;
      pendingRequests.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.data);
      }
    } catch {
      // 忽略解析失败
    }
  });

  ws.on("close", () => {
    process.stderr.write("[Bridge Server] Native Host 已断开\n");
    nativeSocket = null;
  });
});

// ── HTTP Server（MCP Server → Bridge）──────────
const app = express();
app.use(cors());
app.use(express.json());

app.post("/execute", async (req, res) => {
  const { scriptName, params } = req.body as {
    scriptName: string;
    params: Record<string, unknown>;
  };

  if (!scriptName) {
    res.status(400).json({ error: "缺少 scriptName" });
    return;
  }

  if (!nativeSocket || nativeSocket.readyState !== WebSocket.OPEN) {
    res.status(503).json({ error: "Native Host 未连接，请确认 Chrome 插件已打开" });
    return;
  }

  const requestId = crypto.randomUUID();

  const timeout = setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);
      res.status(504).json({ error: "等待 Chrome 响应超时（30s）" });
    }
  }, 30_000);

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
  });

  nativeSocket.send(JSON.stringify({ type: "EXECUTE_SCRIPT", scriptName, params, requestId }));

  try {
    const data = await resultPromise;
    clearTimeout(timeout);
    res.json({ data });
  } catch (err) {
    clearTimeout(timeout);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok", nativeConnected: nativeSocket?.readyState === WebSocket.OPEN }));

app.listen(HTTP_PORT, "127.0.0.1", () => {
  process.stderr.write(`[Bridge Server] HTTP 已启动 → http://127.0.0.1:${HTTP_PORT}\n`);
});
