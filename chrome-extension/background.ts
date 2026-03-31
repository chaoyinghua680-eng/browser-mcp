// ────────────────────────────────────────────────
//  Background Service Worker
//  职责：
//  1. 与 Native Host 保持 Native Messaging 长连接
//  2. 收到 EXECUTE_SCRIPT 指令后，路由到对应 Tab
//  3. 通过 chrome.tabs.sendMessage 转发给 User Script
//  4. 将执行结果原路回传给 Native Host
// ────────────────────────────────────────────────

const NATIVE_HOST_NAME = "com.browsermcp.host";

let nativePort: chrome.runtime.Port | null = null;

// ── Native Messaging 连接管理 ─────────────────
function connectNative() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener(async (message: {
      type: string;
      scriptName: string;
      params: Record<string, unknown>;
      requestId: string;
    }) => {
      if (message.type !== "EXECUTE_SCRIPT") return;

      let responsePayload: { requestId: string; data?: unknown; error?: string };

      try {
        const data = await executeScript(message.scriptName, message.params);
        responsePayload = { requestId: message.requestId, data };
      } catch (err) {
        responsePayload = {
          requestId: message.requestId,
          error: (err as Error).message,
        };
      }

      // 回传结果给 Native Host（再转发给 MCP Server）
      nativePort?.postMessage(responsePayload);
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? "未知原因";
      console.warn(`[BrowserMCP] Native Messaging 断开: ${err}，1s 后重连`);
      nativePort = null;
      setTimeout(connectNative, 1000);
    });

    console.log("[BrowserMCP] Native Messaging 已连接");
  } catch (err) {
    console.error("[BrowserMCP] 连接 Native Host 失败:", err);
    setTimeout(connectNative, 3000);
  }
}

// ── 脚本执行路由 ──────────────────────────────
async function executeScript(
  scriptName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  // 从 storage 读取脚本配置
  const { scripts } = await chrome.storage.local.get("scripts") as {
    scripts?: Record<string, { targetUrl: string; code: string }>;
  };

  const scriptConfig = scripts?.[scriptName];
  if (!scriptConfig) {
    throw new Error(`脚本未注册: ${scriptName}，请在插件 Popup 中安装`);
  }

  // 找到或新开目标 Tab
  const tab = await findOrOpenTab(scriptConfig.targetUrl);
  if (!tab.id) throw new Error("无法获取 Tab ID");

  // 确保 User Script 已通过 userScripts API 注册
  await ensureUserScriptRegistered(scriptName, scriptConfig);

  // 通过 chrome.tabs.sendMessage 通知 User Script 执行
  // User Script 用 chrome.runtime.onMessage 接收（需配置 messaging: true）
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("User Script 响应超时（15s）")),
      15_000
    );

    chrome.tabs.sendMessage(
      tab.id!,
      { type: "RUN_SCRIPT", scriptName, params },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("User Script 无响应，请确认脚本已正确注册"));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.data);
        }
      }
    );
  });
}

// ── 确保 User Script 已注册 ───────────────────
async function ensureUserScriptRegistered(
  scriptName: string,
  config: { targetUrl: string; code: string }
) {
  const existing = await chrome.userScripts.getScripts({ ids: [scriptName] });
  if (existing.length > 0) return; // 已注册，跳过

  const origin = new URL(config.targetUrl).origin;
  await chrome.userScripts.register([
    {
      id: scriptName,
      matches: [`${origin}/*`],
      js: [{ code: config.code }],
      runAt: "document_idle",
      world: "USER_SCRIPT", // 独立沙箱，不污染页面全局
    },
  ]);
}

// ── Tab 管理 ──────────────────────────────────
async function findOrOpenTab(targetUrl: string): Promise<chrome.tabs.Tab> {
  const origin = new URL(targetUrl).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });

  if (tabs.length > 0 && tabs[0].id) {
    return tabs[0];
  }

  // 没有匹配的 Tab，新开一个并等待加载完成
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`打开 ${targetUrl} 超时`)),
      30_000
    );

    chrome.tabs.create({ url: targetUrl }, (tab) => {
      const listener = (
        tabId: number,
        info: chrome.tabs.TabChangeInfo,
        updatedTab: chrome.tabs.Tab
      ) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve(updatedTab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ── 插件安装/启动时初始化 ─────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // userScripts API 需要在 chrome://extensions 中为本插件开启「允许访问文件网址」
  // 以及 Chrome 需处于开发者模式，否则 chrome.userScripts 为 undefined
  if (!chrome.userScripts) {
    console.error(
      "[BrowserMCP] chrome.userScripts 不可用！\n" +
      "请到 chrome://extensions → 找到 Browser MCP → 开启「在开发者模式下允许」"
    );
    return;
  }
  // 开启 userScripts messaging 模式（允许沙箱内使用 chrome.runtime.onMessage）
  await chrome.userScripts.configureWorld({
    messaging: true,
  });
  console.log("[BrowserMCP] userScripts world messaging 已启用");
});

// 启动 Native Messaging 连接
connectNative();

// 强制 tsc 将此文件识别为 ES module（Service Worker type: module 要求）
export {};
