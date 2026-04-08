// ────────────────────────────────────────────────
//  Native Host（由 Chrome 按需启动）
//  职责：纯 Native Messaging 桥
//  - 从 stdin 读取 Chrome 消息，转发给 Bridge Server（WebSocket）
//  - 从 Bridge Server 收到指令，写入 stdout 发给 Chrome
// ────────────────────────────────────────────────

import { WebSocket } from "ws";

const WS_URL = "ws://127.0.0.1:3283";

// ── Native Messaging 写入（发给 Chrome）──────────
function writeToChrome(message: object) {
  const payload = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

// ── 连接 Bridge Server ───────────────────────────
function connectBridge() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    process.stderr.write("[Native Host] 已连接 Bridge Server\n");
  });

  // Bridge Server 发来指令 → 转发给 Chrome
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      writeToChrome(msg);
    } catch {
      // 忽略
    }
  });

  ws.on("error", (err) => {
    process.stderr.write(`[Native Host] WebSocket 错误: ${err.message}\n`);
  });

  ws.on("close", () => {
    process.stderr.write("[Native Host] Bridge Server 连接断开，1s 后重连\n");
    setTimeout(connectBridge, 1000);
  });

  // ── Native Messaging 读取（来自 Chrome）──────────
  let buffer = Buffer.alloc(0);
  process.stdin.resume();

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32LE(0);
      if (buffer.length < 4 + msgLen) break;

      const msgBody = buffer.subarray(4, 4 + msgLen).toString("utf-8");
      buffer = buffer.subarray(4 + msgLen);

      try {
        const msg = JSON.parse(msgBody);
        // Chrome 响应 → 转发给 Bridge Server
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      } catch {
        // 忽略
      }
    }
  });

  // Chrome 关闭连接时退出（Native Messaging 规范要求）
  process.stdin.on("end", () => process.exit(0));
}

connectBridge();
