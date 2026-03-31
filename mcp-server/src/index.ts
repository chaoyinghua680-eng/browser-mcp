import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getToolDefinitions, validateToolParams } from "./tools.js";
import { callNativeHost } from "./http-bridge.js";

const server = new Server(
  { name: "browser-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ① 列出所有可用工具（Claude Desktop 启动时会拉取）
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getToolDefinitions() };
});

// ② 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // 严格参数白名单校验，防止 AI 幻觉/提示词注入
  const validatedParams = validateToolParams(name, args ?? {});
  if (!validatedParams.ok) {
    return {
      content: [{ type: "text", text: `参数校验失败: ${validatedParams.error}` }],
      isError: true,
    };
  }

  try {
    // ③ 通过 HTTP 桥接发给独立运行的 Native Host 进程
    //    绝不在此进程的 Stdio 上混用 Native Messaging 协议
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

// MCP Server 使用 Stdio 与 Claude Desktop 通信
const transport = new StdioServerTransport();
await server.connect(transport);
