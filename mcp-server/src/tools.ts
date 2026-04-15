// 工具定义 + 参数白名单校验
const TOOL_DEFINITIONS = [
  {
    name: "get_taobao_orders",
    description: "获取淘宝历史订单，可按页码筛选",
    inputSchema: {
      type: "object" as const,
      properties: {
        month: {
          type: "string",
          description: "月份，格式 YYYYMM，如 202503",
          pattern: "^\\d{6}$",
        },
        pageNum: { type: "number", minimum: 1, maximum: 100 },
      },
      required: [] as string[],
    },
  },
  {
    name: "deepseek_send_message",
    description: "通过浏览器已登录的 DeepSeek 网页版发送消息并获取回复（single-turn，仅支持 deepseek-chat）",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "要发送的消息内容" },
      },
      required: ["message"] as string[],
      additionalProperties: false,
    },
  },
  {
    name: "get_jd_orders",
    description: "获取京东历史订单",
    inputSchema: {
      type: "object" as const,
      properties: {
        pageNum: { type: "number", minimum: 1, maximum: 100 },
      },
      required: [] as string[],
    },
  },
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

// 严格校验参数（防止 AI 幻觉/提示词注入）
export function validateToolParams(
  toolName: string,
  params: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!tool) return { ok: false, error: `未知工具: ${toolName}` };
  if (typeof params !== "object" || params === null)
    return { ok: false, error: "参数必须是对象" };

  const schemaProperties = (tool.inputSchema.properties ?? {}) as unknown as Record<string, {
    type?: "string" | "number";
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    pattern?: string;
  }>;
  const allowedKeys = Object.keys(schemaProperties);
  const inputKeys = Object.keys(params as object);
  const requiredKeys = tool.inputSchema.required ?? [];

  for (const key of requiredKeys) {
    if (!(key in (params as object))) {
      return { ok: false, error: `缺少必填参数: ${key}` };
    }
  }

  for (const key of inputKeys) {
    if (!allowedKeys.includes(key)) {
      return { ok: false, error: `不允许的参数字段: ${key}` };
    }

    const value = (params as Record<string, unknown>)[key];
    const fieldSchema = schemaProperties[key];

    if (!fieldSchema) continue;

    if (fieldSchema.type === "string" && typeof value !== "string") {
      return { ok: false, error: `参数 ${key} 必须是字符串` };
    }

    if (fieldSchema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `参数 ${key} 必须是数字` };
      }
      if (fieldSchema.minimum != null && value < fieldSchema.minimum) {
        return { ok: false, error: `参数 ${key} 不能小于 ${fieldSchema.minimum}` };
      }
      if (fieldSchema.maximum != null && value > fieldSchema.maximum) {
        return { ok: false, error: `参数 ${key} 不能大于 ${fieldSchema.maximum}` };
      }
    }

    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
      return { ok: false, error: `参数 ${key} 必须是允许的枚举值` };
    }

    if (fieldSchema.pattern && typeof value === "string") {
      const regex = new RegExp(fieldSchema.pattern);
      if (!regex.test(value)) {
        return { ok: false, error: `参数 ${key} 格式不正确` };
      }
    }
  }

  return { ok: true, data: params as Record<string, unknown> };
}
