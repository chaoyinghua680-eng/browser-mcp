// ────────────────────────────────────────────────
//  Background Service Worker
//  职责：
//  1. 与 Native Host 保持 Native Messaging 长连接
//  2. 收到 EXECUTE_SCRIPT 指令后，路由到对应 Tab
//  3. 先 Ping 检测脚本是否已注入，未注入则 Reload Tab
//  4. 通过 chrome.tabs.sendMessage 转发给 User Script
//  5. 支持 proxyFetch：在 MAIN world 执行 fetch 解决 Origin 问题
//  6. 将执行结果原路回传给 Native Host
// ────────────────────────────────────────────────

const NATIVE_HOST_NAME = "com.browsermcp.host";
const DEEPSEEK_MARKER = "browsermcp=1";
const DEEPSEEK_MARKER_URL = `https://chat.deepseek.com/?${DEEPSEEK_MARKER}`;

let nativePort: chrome.runtime.Port | null = null;
let deepseekBusy = false;
let deepseekTabId: number | null = null;

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
  // 内建 DeepSeek：完全绕开 userScripts 链路
  if (scriptName === "deepseek_send_message") {
    if (deepseekBusy) {
      throw new Error("[DeepSeek] 正在处理中，请等待上一个请求完成");
    }

    deepseekBusy = true;
    try {
      const tab = await findOrOpenDeepSeekTab();
      if (!tab.id) throw new Error("[DeepSeek] 无法获取 Tab ID");
      return await executeDeepSeekInMainWorld(tab.id, params);
    } finally {
      deepseekBusy = false;
    }
  }

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

  // 淘宝订单：直接在 MAIN world 执行（绕过 Origin 问题）
  if (scriptName === "get_taobao_orders") {
    return await executeTaobaoOrdersInMainWorld(tab.id, params);
  }

  // 其他脚本：走原有的 user script 消息通道
  const userResult = await sendMessageToTab(tab.id, { type: "RUN_SCRIPT", scriptName, params });
  return userResult;
}

// ── 淘宝订单：MAIN world 一步执行 ────────────
async function executeTaobaoOrdersInMainWorld(
  tabId: number,
  params: Record<string, unknown>
): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: taobaoOrdersMainWorldFunc,
    args: [params],
  });

  const result = results?.[0]?.result as { data?: unknown; error?: string } | undefined;
  if (!result) throw new Error("MAIN world 执行无返回");
  if (result.error) throw new Error(result.error);
  return result.data;
}

// ── DeepSeek：MAIN world UI 自动化 ─────────────
async function executeDeepSeekInMainWorld(
  tabId: number,
  params: Record<string, unknown>
): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: deepseekMainWorldFunc,
    args: [params],
  });

  const result = results?.[0]?.result as { data?: unknown; error?: string } | undefined;
  if (!result) {
    throw new Error("[DeepSeek] MAIN world 执行无返回，请确认 chat.deepseek.com 页面已加载完成");
  }
  if (result.error) throw new Error(result.error);
  return result.data;
}

// 此函数会被序列化后在页面 MAIN world 中执行
// 不能引用外部变量，必须完全自包含
async function deepseekMainWorldFunc(params: Record<string, unknown>) {
  try {
    const message = typeof params.message === "string" ? params.message.trim() : "";
    if (!message) {
      return { error: "[DeepSeek] message 不能为空" };
    }

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const waitFor = async <T>(
      getValue: () => T | null,
      timeoutMs: number,
      intervalMs = 100
    ): Promise<T | null> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const value = getValue();
        if (value) return value;
        await sleep(intervalMs);
      }
      return null;
    };

    const getTextarea = () => {
      const preferred = document.querySelector('textarea[placeholder="Message DeepSeek"]');
      if (preferred instanceof HTMLTextAreaElement) return preferred;
      const fallback = document.querySelector("textarea");
      return fallback instanceof HTMLTextAreaElement ? fallback : null;
    };

    const getSendButton = () => {
      const preferred = document.querySelector('[role="button"].bd74640a');
      if (preferred instanceof HTMLElement) return preferred;

      const fallback = document
        .querySelector('svg path[d^="M8.3125"]')
        ?.closest('[role="button"]');
      return fallback instanceof HTMLElement ? fallback : null;
    };

    const getMarkdownNodes = () =>
      Array.from(document.querySelectorAll(".ds-markdown")).filter(
        (node): node is HTMLElement => node instanceof HTMLElement
      );

    const getLatestContent = () => {
      const nodes = getMarkdownNodes();
      return nodes[nodes.length - 1]?.innerText.trim() ?? "";
    };

    const isButtonDisabled = (button: HTMLElement | null) =>
      !button ||
      button.classList.contains("ds-icon-button--disabled") ||
      button.getAttribute("aria-disabled") === "true" ||
      button.hasAttribute("disabled");

    const triggerClick = (button: HTMLElement) => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    const textarea = await waitFor(getTextarea, 10_000);
    if (!textarea) {
      // 可能是未登录，检查页面是否有登录相关元素
      const isLoginPage = !!document.querySelector('input[type="password"]')
        || !!document.querySelector('[class*="login"]')
        || window.location.href.includes("/login");

      if (isLoginPage) {
        console.warn("[BrowserMCP DeepSeek] 未检测到登录态，请在页面中完成登录，等待中...");
        // 弹出提示横幅
        try {
          const banner = document.createElement("div");
          banner.id = "browsermcp-login-banner";
          banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#6366f1;color:#fff;text-align:center;padding:12px;font-size:15px;font-weight:600;";
          banner.textContent = "🔗 Browser MCP：请登录 DeepSeek，登录后将自动继续...";
          document.body.appendChild(banner);
        } catch { /* 忽略 */ }

        // 登录后页面通常会跳转，等待输入框出现（最多 60 秒）
        const textareaAfterLogin = await waitFor(getTextarea, 60_000, 2_000);

        // 移除提示横幅
        try { document.getElementById("browsermcp-login-banner")?.remove(); } catch { /* 忽略 */ }

        if (!textareaAfterLogin) {
          return { error: "[DeepSeek] 等待登录超时（60s），请先登录 DeepSeek 后再试" };
        }

        console.log("[BrowserMCP DeepSeek] 登录态已检测到，继续执行");
        // 用登录后找到的 textarea 继续流程
        return await doSendMessage(textareaAfterLogin);
      }

      return { error: "[DeepSeek] 未找到输入框，请确认页面已完全加载并已登录" };
    }

    return await doSendMessage(textarea);

    // 将发送消息逻辑提取为内部函数，避免登录等待后重复代码
    async function doSendMessage(ta: HTMLTextAreaElement) {

    ta.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(ta, message);
    } else {
      ta.value = message;
    }

    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));

    const sendButton = await waitFor(getSendButton, 3_000);
    if (!sendButton) {
      return { error: "[DeepSeek] 未找到发送按钮，页面结构可能已更新" };
    }

    const enabledButton = await waitFor(
      () => {
        const button = getSendButton();
        return isButtonDisabled(button) ? null : button;
      },
      3_000
    );

    if (!enabledButton) {
      return { error: "[DeepSeek] 发送按钮未激活，消息可能未被接受" };
    }

    const previousCount = getMarkdownNodes().length;
    const previousText = getLatestContent();
    enabledButton.click();

    const responseStarted = await waitFor(() => {
      const nodes = getMarkdownNodes();
      const latestText = getLatestContent();
      const button = getSendButton();

      if (nodes.length > previousCount) return nodes[nodes.length - 1];
      if (latestText && latestText !== previousText) return true;
      if (button && isButtonDisabled(button)) return true;
      return null;
    }, 30_000);

    if (!responseStarted) {
      const fallbackButton = getSendButton();
      if (fallbackButton && fallbackButton !== enabledButton && !isButtonDisabled(fallbackButton)) {
        triggerClick(fallbackButton);
      } else if (!isButtonDisabled(enabledButton)) {
        triggerClick(enabledButton);
      }

      const retryStarted = await waitFor(() => {
        const nodes = getMarkdownNodes();
        const latestText = getLatestContent();
        const button = getSendButton();

        if (nodes.length > previousCount) return true;
        if (latestText && latestText !== previousText) return true;
        if (button && isButtonDisabled(button)) return true;
        return null;
      }, 10_000);

      if (!retryStarted) {
        return { error: "[DeepSeek] 等待回复超时（30s），请检查页面状态" };
      }
    }

    const timeoutSeconds = typeof params.timeout === "number" ? params.timeout : 120;
    const maxWaitMs = Math.max(5, timeoutSeconds) * 1000;
    const replyStartedAt = Date.now();
    let lastText = "";
    let stableCount = 0;

    while (Date.now() - replyStartedAt < maxWaitMs) {
      await sleep(500);

      const currentText = getLatestContent();
      if (currentText && currentText === lastText) {
        stableCount += 1;
      } else {
        stableCount = currentText ? 1 : 0;
        lastText = currentText;
      }

      const currentButton = getSendButton();
      if (currentText && currentButton && !isButtonDisabled(currentButton)) {
        break;
      }

      if (currentText && stableCount >= 2) {
        break;
      }
    }

    const content = getLatestContent();
    const hasNewReply = getMarkdownNodes().length > previousCount || content !== previousText;
    if (!content || !hasNewReply) {
      return { error: "[DeepSeek] 收到空响应" };
    }

    return { data: { content } };
    } // end doSendMessage
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: "[DeepSeek] 执行异常: " + message };
  }
}

// 此函数会被序列化后在页面 MAIN world 中执行
// 不能引用外部变量，必须完全自包含
async function taobaoOrdersMainWorldFunc(params: Record<string, unknown>) {
  // ---- MD5 ----
  function md5(str: string): string {
    function safeAdd(x: number, y: number) {
      const lsw = (x & 0xffff) + (y & 0xffff);
      const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xffff);
    }
    function bitRotateLeft(num: number, cnt: number) { return (num << cnt) | (num >>> (32 - cnt)); }
    function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
    function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
    function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

    function md5blks(s: string) {
      const nblk = ((s.length + 8) >> 6) + 1;
      const blks = new Array(nblk * 16).fill(0);
      for (let i = 0; i < s.length; i++) blks[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
      blks[s.length >> 2] |= 0x80 << ((s.length % 4) * 8);
      blks[nblk * 16 - 2] = s.length * 8;
      return blks;
    }

    const x = md5blks(str);
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const [oa, ob, oc, od] = [a, b, c, d];
      a=md5ff(a,b,c,d,x[i],7,-680876936);d=md5ff(d,a,b,c,x[i+1],12,-389564586);c=md5ff(c,d,a,b,x[i+2],17,606105819);b=md5ff(b,c,d,a,x[i+3],22,-1044525330);
      a=md5ff(a,b,c,d,x[i+4],7,-176418897);d=md5ff(d,a,b,c,x[i+5],12,1200080426);c=md5ff(c,d,a,b,x[i+6],17,-1473231341);b=md5ff(b,c,d,a,x[i+7],22,-45705983);
      a=md5ff(a,b,c,d,x[i+8],7,1770035416);d=md5ff(d,a,b,c,x[i+9],12,-1958414417);c=md5ff(c,d,a,b,x[i+10],17,-42063);b=md5ff(b,c,d,a,x[i+11],22,-1990404162);
      a=md5ff(a,b,c,d,x[i+12],7,1804603682);d=md5ff(d,a,b,c,x[i+13],12,-40341101);c=md5ff(c,d,a,b,x[i+14],17,-1502002290);b=md5ff(b,c,d,a,x[i+15],22,1236535329);
      a=md5gg(a,b,c,d,x[i+1],5,-165796510);d=md5gg(d,a,b,c,x[i+6],9,-1069501632);c=md5gg(c,d,a,b,x[i+11],14,643717713);b=md5gg(b,c,d,a,x[i],20,-373897302);
      a=md5gg(a,b,c,d,x[i+5],5,-701558691);d=md5gg(d,a,b,c,x[i+10],9,38016083);c=md5gg(c,d,a,b,x[i+15],14,-660478335);b=md5gg(b,c,d,a,x[i+4],20,-405537848);
      a=md5gg(a,b,c,d,x[i+9],5,568446438);d=md5gg(d,a,b,c,x[i+14],9,-1019803690);c=md5gg(c,d,a,b,x[i+3],14,-187363961);b=md5gg(b,c,d,a,x[i+8],20,1163531501);
      a=md5gg(a,b,c,d,x[i+13],5,-1444681467);d=md5gg(d,a,b,c,x[i+2],9,-51403784);c=md5gg(c,d,a,b,x[i+7],14,1735328473);b=md5gg(b,c,d,a,x[i+12],20,-1926607734);
      a=md5hh(a,b,c,d,x[i+5],4,-378558);d=md5hh(d,a,b,c,x[i+8],11,-2022574463);c=md5hh(c,d,a,b,x[i+11],16,1839030562);b=md5hh(b,c,d,a,x[i+14],23,-35309556);
      a=md5hh(a,b,c,d,x[i+1],4,-1530992060);d=md5hh(d,a,b,c,x[i+4],11,1272893353);c=md5hh(c,d,a,b,x[i+7],16,-155497632);b=md5hh(b,c,d,a,x[i+10],23,-1094730640);
      a=md5hh(a,b,c,d,x[i+13],4,681279174);d=md5hh(d,a,b,c,x[i],11,-358537222);c=md5hh(c,d,a,b,x[i+3],16,-722521979);b=md5hh(b,c,d,a,x[i+6],23,76029189);
      a=md5hh(a,b,c,d,x[i+9],4,-640364487);d=md5hh(d,a,b,c,x[i+12],11,-421815835);c=md5hh(c,d,a,b,x[i+15],16,530742520);b=md5hh(b,c,d,a,x[i+2],23,-995338651);
      a=md5ii(a,b,c,d,x[i],6,-198630844);d=md5ii(d,a,b,c,x[i+7],10,1126891415);c=md5ii(c,d,a,b,x[i+14],15,-1416354905);b=md5ii(b,c,d,a,x[i+5],21,-57434055);
      a=md5ii(a,b,c,d,x[i+12],6,1700485571);d=md5ii(d,a,b,c,x[i+3],10,-1894986606);c=md5ii(c,d,a,b,x[i+10],15,-1051523);b=md5ii(b,c,d,a,x[i+1],21,-2054922799);
      a=md5ii(a,b,c,d,x[i+8],6,1873313359);d=md5ii(d,a,b,c,x[i+15],10,-30611744);c=md5ii(c,d,a,b,x[i+6],15,-1560198380);b=md5ii(b,c,d,a,x[i+13],21,1309151649);
      a=md5ii(a,b,c,d,x[i+4],6,-145523070);d=md5ii(d,a,b,c,x[i+11],10,-1120210379);c=md5ii(c,d,a,b,x[i+2],15,718787259);b=md5ii(b,c,d,a,x[i+9],21,-343485551);
      a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
    }

    function hex(n: number) {
      const u = n >>> 0;
      return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff]
        .map(b => ('0' + b.toString(16)).slice(-2)).join('');
    }
    return [a, b, c, d].map(hex).join('');
  }

  // ---- 主逻辑 ----
  try {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // 登录检测：等待 _m_h5_tk cookie 出现（最多 60 秒）
    const LOGIN_TIMEOUT_MS = 60_000;
    const LOGIN_CHECK_INTERVAL_MS = 3_000;
    const loginStartedAt = Date.now();
    let match = document.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;]+)/);

    if (!match) {
      console.warn("[BrowserMCP 淘宝] 未检测到登录态，请在页面中完成登录，等待中...");
      // 尝试弹出提示（不阻塞流程）
      try {
        const banner = document.createElement("div");
        banner.id = "browsermcp-login-banner";
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#6366f1;color:#fff;text-align:center;padding:12px;font-size:15px;font-weight:600;";
        banner.textContent = "🔗 Browser MCP：请登录淘宝，登录后将自动继续获取数据...";
        document.body.appendChild(banner);
      } catch { /* 忽略 DOM 操作异常 */ }

      while (Date.now() - loginStartedAt < LOGIN_TIMEOUT_MS) {
        await sleep(LOGIN_CHECK_INTERVAL_MS);
        match = document.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;]+)/);
        if (match) break;
      }

      // 移除提示横幅
      try { document.getElementById("browsermcp-login-banner")?.remove(); } catch { /* 忽略 */ }

      if (!match) {
        return { error: "等待登录超时（60s），请先登录淘宝后再试" };
      }
      console.log("[BrowserMCP 淘宝] 登录态已检测到，继续获取数据");
    }

    const token = match[1].split("_")[0];

    const pageNum = (params as { pageNum?: number })?.pageNum ?? 1;
    const data = JSON.stringify({
      tabCode: "all",
      page: pageNum,
      OrderType: "OrderList",
      appName: "tborder",
      appVersion: "3.0",
      condition: { directRouteToTm2Scene: "1" },
      __needlessClearProtocol__: true,
    });

    const t = Date.now().toString();
    const appKey = "12574478";
    const sign = md5(token + "&" + t + "&" + appKey + "&" + data);

    const query = new URLSearchParams({
      jsv: "2.7.2", appKey, v: "1.0", ecode: "1", timeout: "8000",
      dataType: "json", valueType: "original", ttid: "1@tbwang_mac_1.0.0#pc",
      needLogin: "true", type: "originaljson", isHttps: "1", needRetry: "true",
      t, sign,
    });

    const url = "https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/?" + query.toString();

    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(data),
    })
    .then(r => r.json())
    .then((json: Record<string, unknown>) => {
      const ret = json.ret as string[] | undefined;

      // Token 续期重试
      if (Array.isArray(ret) && ret.some(r => /FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EMPTY/.test(r))) {
        // 重读 cookie 重试
        const m2 = document.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;]+)/);
        if (!m2) return { error: "Token 续期失败" };
        const token2 = m2[1].split("_")[0];
        const t2 = Date.now().toString();
        const sign2 = md5(token2 + "&" + t2 + "&" + appKey + "&" + data);
        const q2 = new URLSearchParams({
          jsv: "2.7.2", appKey, v: "1.0", ecode: "1", timeout: "8000",
          dataType: "json", valueType: "original", ttid: "1@tbwang_mac_1.0.0#pc",
          needLogin: "true", type: "originaljson", isHttps: "1", needRetry: "true",
          t: t2, sign: sign2,
        });
        const url2 = "https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/?" + q2.toString();
        return fetch(url2, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(data),
        }).then(r => r.json()).then(parseResult);
      }

      return parseResult(json);
    });
  } catch (e) {
    return { error: (e as Error).message };
  }

  function parseResult(json: Record<string, unknown>) {
    const d = json.data as Record<string, unknown> | undefined;
    const dd = d?.data as Record<string, Record<string, unknown>> | undefined;
    if (!d || !dd) {
      const ret = json.ret;
      const errMsg = Array.isArray(ret) ? ret.join("; ") : "未知错误";
      return { error: "mtop 接口返回错误：" + errMsg };
    }

    const ordersMap: Record<string, { orderId: string; shop: string | null; status: string | null; createTime: string | null; items: unknown[] }> = {};

    for (const key of Object.keys(dd)) {
      const entry = dd[key] as Record<string, unknown>;
      const fields = (entry.fields || entry) as Record<string, unknown>;
      const tag = entry.tag as string | undefined;
      const id = entry.id as string | undefined;

      if (tag === "shopInfo" && id) {
        const orderId = String(id);
        if (!ordersMap[orderId]) ordersMap[orderId] = { orderId, shop: null, status: null, createTime: null, items: [] };
        ordersMap[orderId].shop = (fields.shopName as string) || null;
        ordersMap[orderId].status = (fields.tradeTitle as string) || null;
        ordersMap[orderId].createTime = (fields.createTime as string) || null;
      } else if (tag === "orderItemInfo" && id) {
        const orderId = String(id).split("_")[0];
        if (!ordersMap[orderId]) ordersMap[orderId] = { orderId, shop: null, status: null, createTime: null, items: [] };
        const item = (fields.item || fields) as Record<string, unknown>;
        const priceInfo = item.priceInfo as Record<string, unknown> | undefined;
        ordersMap[orderId].items.push({
          name: item.title || null,
          image: item.pic || null,
          price: priceInfo?.actualTotalFee || null,
          qty: item.quantity || null,
        });
      }
    }

    const orders = Object.values(ordersMap);
    return { data: { total: orders.length, orders } };
  }
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

async function findOrOpenDeepSeekTab(): Promise<chrome.tabs.Tab> {
  if (deepseekTabId !== null) {
    try {
      const tab = await chrome.tabs.get(deepseekTabId);
      if (tab.url?.includes("chat.deepseek.com")) {
        return tab;
      }
    } catch {
      // tab 已关闭，继续向下查找
    }
    deepseekTabId = null;
  }

  const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
  const markerTab = tabs.find((tab) => tab.url?.includes(DEEPSEEK_MARKER));
  if (markerTab?.id) {
    deepseekTabId = markerTab.id;
    return markerTab;
  }

  const tab = await openAndWait(DEEPSEEK_MARKER_URL, { active: false });
  deepseekTabId = tab.id ?? null;
  return tab;
}

function openAndWait(
  url: string,
  options: Pick<chrome.tabs.CreateProperties, "active"> = {}
): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`打开 ${url} 超时`)),
      30_000
    );

    chrome.tabs.create({ ...options, url }, (tab) => {
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

// ── 连接状态查询（供管理页面/popup 调用）────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_CONNECTION_STATUS") {
    sendResponse({ connected: nativePort !== null });
    return true;
  }
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
