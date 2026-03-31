// HTTP Bridge: MCP Server → Native Host 的进程间通信桥
// MCP Server 作为 HTTP 客户端，将工具调用请求 POST 给 Native Host 的 HTTP Server

const NATIVE_HOST_URL = "http://localhost:3282";  // Native Host进程地址
const REQUEST_TIMEOUT_MS = 30_000;// ms 30s 请求超时时间

export async function callNativeHost(
  scriptName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);// 实现30s超时的逻辑

  try {// 打包请求 Fetch请求
    const response = await fetch(`${NATIVE_HOST_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptName, params }),
      signal: controller.signal, // 绑上定时
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Native Host 返回错误 ${response.status}: ${text}`);
    }

    return await response.json();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("请求 Native Host 超时（30s）");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
