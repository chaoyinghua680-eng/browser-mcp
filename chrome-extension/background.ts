// ────────────────────────────────────────────────
//  Background Service Worker
//  职责：
//  1. 与 Native Host 保持 Native Messaging 长连接
//  2. 收到 EXECUTE_SCRIPT 指令后，路由到对应 Tab
//  3. 先 Ping 检测脚本是否已注入，未注入则 Reload Tab
//  4. 通过 chrome.tabs.sendMessage 转发给 User Script
//  5. 将执行结果原路回传给 Native Host
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
  const { scripts } = await chrome.storage.local.get("scripts") as {
    scripts?: Record<string, { targetUrl: string; code: string; enabled?: boolean }>;
  };

  const scriptConfig = scripts?.[scriptName];
  if (!scriptConfig) {
    throw new Error(`脚本未注册: ${scriptName}，请在插件 Popup 中安装`);
  }

  if (scriptConfig.enabled === false) {
    throw new Error(`脚本 ${scriptName} 已被禁用，请在脚本管理页面中启用`);
  }

  // 确保 userScript 已注册（新 Tab / 刷新后会自动注入）
  await ensureUserScriptRegistered(scriptName, scriptConfig);

  // 找到或新开目标 Tab
  const tab = await findOrOpenTab(scriptConfig.targetUrl);
  if (!tab.id) throw new Error("无法获取 Tab ID");

  // Ping 检测脚本是否已注入，未注入则 Reload
  await ensureScriptInjected(tab.id);

  // 发送正式执行请求
  return sendMessageToTab(tab.id, { type: "RUN_SCRIPT", scriptName, params });
}

// ── Ping + 按需 Reload ────────────────────────
async function ensureScriptInjected(tabId: number): Promise<void> {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "PING" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 1000)
      ),
    ]) as { type: string } | undefined;

    if (res?.type === "PONG") return; // 脚本已就绪
  } catch {
    // 无响应，说明 Tab 是在脚本注册前打开的，需要刷新
  }

  console.log(`[BrowserMCP] Tab ${tabId} 无脚本，刷新注入...`);
  await reloadAndWait(tabId);
}

// ── 向 Tab 发消息（带超时）────────────────────
function sendMessageToTab(
  tabId: number,
  message: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`User Script 响应超时（${timeoutMs / 1000}s）`)),
      timeoutMs
    );

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("User Script 无响应"));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.data);
      }
    });
  });
}

// ── 确保 User Script 已注册 ───────────────────
async function ensureUserScriptRegistered(
  scriptName: string,
  config: { targetUrl: string; code: string }
) {
  const existing = await chrome.userScripts.getScripts({ ids: [scriptName] });
  if (existing.length > 0) return;

  const origin = new URL(config.targetUrl).origin;

  // 包装用户代码：添加 PING/RUN_SCRIPT 消息监听
  const wrappedCode = `
(function() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "PING") {
      sendResponse({ type: "PONG" });
      return true;
    }
    if (request.type === "RUN_SCRIPT") {
      (async () => {
        ${config.code}
      })().then(data => {
        sendResponse({ data });
      }).catch(err => {
        sendResponse({ error: err.message || String(err) });
      });
      return true;
    }
  });
})();
`;

  await chrome.userScripts.register([
    {
      id: scriptName,
      matches: [`${origin}/*`],
      js: [{ code: wrappedCode }],
      runAt: "document_end",
      world: "USER_SCRIPT",
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

  return openAndWait(targetUrl);
}

function openAndWait(url: string): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`打开 ${url} 超时`)),
      30_000
    );

    chrome.tabs.create({ url }, (tab) => {
      const listener = (
        tabId: number,
        info: chrome.tabs.TabChangeInfo,
        updatedTab: chrome.tabs.Tab
      ) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve(updatedTab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function reloadAndWait(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Tab 刷新超时")),
      30_000
    );

    const listener = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// ── 插件安装/更新时初始化 ─────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  if (!chrome.userScripts) {
    console.error(
      "[BrowserMCP] chrome.userScripts 不可用！\n" +
      "请到 chrome://extensions → 找到 Browser MCP → 开启开发者模式"
    );
    return;
  }
  await chrome.userScripts.configureWorld({ messaging: true });
  console.log("[BrowserMCP] userScripts world messaging 已启用");
});

// 启动 Native Messaging 连接
connectNative();

// ── Service Worker 保活（MV3 会在 30s 无活动后挂起）──
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepAlive") return;
  if (!nativePort) connectNative();
});

export {};
