// 淘宝订单抓取脚本（DOM 读取方式，绕过 mtop 签名验证）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_SCRIPT") return false;
  if (message.scriptName !== "get_taobao_orders") return false;

  try {
    const data = scrapeTaobaoOrders(message.params);
    sendResponse({ data });
  } catch (err) {
    sendResponse({ error: err.message });
  }

  return true;
});

function scrapeTaobaoOrders(params) {
  const containers = document.querySelectorAll('[class*="shopOrderContainer"]');

  if (containers.length === 0) {
    throw new Error("未找到订单数据，请确认已打开淘宝已购买页面并已登录");
  }

  const orders = [];

  for (const container of containers) {
    const getText = (selector) =>
      container.querySelector(`[class*="${selector}"]`)?.textContent?.trim() ?? null;

    // 订单号（去掉"订单号: "前缀）
    const orderIdRaw = getText("shopInfoOrderId");
    const orderId = orderIdRaw?.replace(/^订单号:\s*/, "") ?? null;

    // 商品列表
    const itemContainers = container.querySelectorAll('[class*="itemInfoColItem"]');
    const items = [];
    for (const item of itemContainers) {
      const getItemText = (sel) =>
        item.querySelector(`[class*="${sel}"]`)?.textContent?.trim() ?? null;

      const name = item.querySelector('[class*="infoContent"]')?.textContent?.trim() ?? null;
      const price = item.querySelector('[class*="price"]')?.textContent?.trim() ?? null;
      const qty = item.querySelector('[class*="quantity"]')?.textContent?.trim()
        ?? item.querySelector('[class*="num"]')?.textContent?.trim()
        ?? null;
      const image = item.querySelector('img')?.src ?? null;

      items.push({ name, price, qty, image });
    }

    orders.push({
      orderId,
      shop: getText("shopInfoName"),
      status: getText("shopInfoStatus"),
      createTime: getText("shopInfoOrderTime"),
      items,
    });
  }

  return {
    total: orders.length,
    orders,
  };
}
