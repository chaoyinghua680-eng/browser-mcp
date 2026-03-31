// ────────────────────────────────────────────────
//  京东订单抓取脚本
//  通过 userScripts API 注入到京东页面的独立沙箱中
// ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_SCRIPT") return false;
  if (message.scriptName !== "get_jd_orders") return false;

  const params = message.params as { pageNum?: number };

  fetchJdOrders(params)
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: (err as Error).message }));

  return true;
});

async function fetchJdOrders(params: { pageNum?: number }): Promise<object> {
  const page = params.pageNum ?? 1;

  const response = await fetch(
    `https://api.m.jd.com/api?functionId=queryOrderList&appid=jd-chrome-plugin&body=${encodeURIComponent(
      JSON.stringify({ pageNum: page, pageSize: 20 })
    )}`,
    {
      credentials: "include", // 携带京东登录 Cookie
      headers: {
        referer: "https://order.jd.com/center/list.action",
        "x-requested-with": "XMLHttpRequest",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`京东接口返回 ${response.status}，请确认已登录京东`);
  }

  const json = await response.json();
  const orderList = json.orderInfoList ?? [];

  const orders = orderList.map((o: Record<string, unknown>) => {
    const baseInfo = o.baseInfo as Record<string, unknown> | undefined;
    const detailInfo = o.detailInfo as Record<string, unknown> | undefined;
    const skuList = (o.skuList as Record<string, unknown>[] | undefined) ?? [];

    return {
      orderId: baseInfo?.id,
      shop: baseInfo?.vendorId,
      total: detailInfo?.actualTotalMoney,
      status: baseInfo?.orderStatusName,
      createTime: baseInfo?.submitTime,
      items: skuList.map((sku) => ({
        name: sku.skuName,
        qty: sku.num,
        price: sku.actualPrice,
        image: sku.pic,
      })),
    };
  });

  return {
    page,
    total: json.page?.totalResult ?? orders.length,
    orders,
  };
}
