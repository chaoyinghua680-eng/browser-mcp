// 淘宝订单抓取脚本 — 最简版
// 实际逻辑由 background.ts 通过 chrome.scripting.executeScript(MAIN world) 执行
// 此脚本只需保留 PING 响应，确保 background 能检测到脚本已注入
console.log("[TaobaoOrders] 脚本已加载");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ type: "PONG" });
    return true;
  }
  if (message.type === "RUN_SCRIPT" && message.scriptName === "get_taobao_orders") {
    // 实际逻辑已由 background MAIN world 处理，此处不再需要
    sendResponse({ data: { info: "此脚本已由 background MAIN world 处理" } });
    return true;
  }
  return false;
});
