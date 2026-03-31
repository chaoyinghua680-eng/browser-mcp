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
  if (!tool) return { ok: false, error: `未知工具: ${toolName}` };// 1、检查工具是否存在
  if (typeof params !== "object" || params === null) // 2、检查传入的参数是否是对象
    return { ok: false, error: "参数必须是对象" };

  const allowedKeys = Object.keys(tool.inputSchema.properties ?? {});// 拿到允许的工具
  const inputKeys = Object.keys(params as object);// 拿到AI发过来的字段
  for (const key of inputKeys) { // 3、检查AI发过来的参数都是允许的工具里要求的参数，有任何一个不是，直接拒绝
    if (!allowedKeys.includes(key)) {
      return { ok: false, error: `不允许的参数字段: ${key}` };
    }
  }

  return { ok: true, data: params as Record<string, unknown> };
}
