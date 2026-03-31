import express from "express";

// ────────────────────────────────────────────────
//  Native Host 进程：双重职责
//  职责A: HTTP Server（监听 localhost:3282）
//        接收来自 MCP Server 进程的工具调用请求
//  职责B: Native Messaging 客户端
//        通过 Chrome Native Messaging 协议（stdin/stdout + 4字节头）
//        与 Chrome 插件 Background Service Worker 双向通信
// ────────────────────────────────────────────────

const HTTP_PORT = 3282;

// ── 等待 Chrome 响应的 Promise 映射 ──────────────
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

// ── Native Messaging 写入（发给 Chrome）──────────
function writeToChrome(message: object) {
  const payload = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

// ── Native Messaging 读取（来自 Chrome）──────────
function startChromeListener() {
  let buffer = Buffer.alloc(0);

  // 必须 resume，否则 Node.js 的 stdin pipe 在没有数据时会立刻关闭
  process.stdin.resume();

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32LE(0);
      if (buffer.length < 4 + msgLen) break;

      const msgBody = buffer.subarray(4, 4 + msgLen).toString("utf-8");
      buffer = buffer.subarray(4 + msgLen);

      try {
        const response = JSON.parse(msgBody) as {
          requestId: string;
          data?: unknown;
          error?: string;
        };

        const pending = pendingRequests.get(response.requestId);
        if (!pending) continue;
        pendingRequests.delete(response.requestId);

        if (response.error) {
          pending.reject(new Error(response.error));
        } else {
          pending.resolve(response.data);
        }
      } catch {
        // 忽略解析失败的消息
      }
    }
  });

  // Chrome 关闭连接时退出（Native Messaging 规范要求）
  process.stdin.on("end", () => process.exit(0));
}

// ── HTTP Server（MCP Server → Native Host 桥）──
function startHttpServer() {
  const app = express();
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

    const requestId = crypto.randomUUID();

    // 设 30s 超时
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        res.status(504).json({ error: "等待 Chrome 响应超时（30s）" });
      }
    }, 30_000);

    // 注册等待回调
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });

    // 通过 Native Messaging 将指令发给 Chrome 插件
    writeToChrome({
      type: "EXECUTE_SCRIPT",
      scriptName,
      params,
      requestId,
    });

    try {
      const data = await resultPromise;
      clearTimeout(timeout);
      res.json({ data });
    } catch (err) {
      clearTimeout(timeout);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 健康检查
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(HTTP_PORT, "127.0.0.1", () => {
    // 写到 stderr，避免污染 stdout（stdout 专用于 Native Messaging）
    process.stderr.write(
      `[Native Host] HTTP Server 已启动 → http://127.0.0.1:${HTTP_PORT}\n`
    );
  });
}

// ── 启动 ──────────────────────────────────────
startChromeListener();
startHttpServer();
