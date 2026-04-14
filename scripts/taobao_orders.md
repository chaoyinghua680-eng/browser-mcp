# 淘宝订单抓取流程说明

## 架构概览

```
MCP 调用 get_taobao_orders
  → mcp-server (stdio)
    → Native Host (bridge-server :3282)
      → Chrome Extension Background Service Worker
        → chrome.scripting.executeScript({ world: "MAIN" })
          → 在淘宝页面主世界中一步完成：
            1. 读 document.cookie 提取 _m_h5_tk token
            2. MD5 计算签名
            3. POST 请求 mtop API
            4. 解析订单 JSON
            5. 返回结构化数据
        ← 订单数据原路返回给调用方
```

## 为什么使用 MAIN world

淘宝 mtop 网关会校验请求的 Origin 头。在尝试过程中，以下方案均失败：

| 方案 | 失败原因 |
|------|---------|
| USER_SCRIPT world 直接 fetch | Origin 是 `chrome-extension://xxx`，mtop 返回 `FAIL_SYS_ILLEGAL_ACCESS` |
| 注入 inline `<script>` 到页面 | 淘宝页面 CSP 禁止 inline script |
| User Script ↔ Background 消息传递代理 fetch | `chrome.runtime.sendMessage`（user script → background 方向）在 USER_SCRIPT world 中不可靠，报 `Receiving end does not exist` |

最终方案：`chrome.scripting.executeScript({ world: "MAIN" })`
- 由 Background Service Worker 直接调用，不受页面 CSP 限制
- 在页面主世界执行，Origin = `buyertrade.taobao.com`
- Cookie 自动携带（`credentials: "include"`）
- 一步到位，无需多步消息传递

## 接口信息

```
API:    mtop.taobao.order.queryboughtlistV2
URL:    https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/
方法:   POST
```

### 签名算法

```
token = cookie "_m_h5_tk" 的第一段（按 "_" 分割取 [0]）
t     = 当前时间戳（毫秒）
sign  = md5(token + "&" + t + "&" + "12574478" + "&" + data)
```

其中 `data` 是 POST body 中的 JSON 字符串。

### Query 参数

| 参数 | 值 |
|------|-----|
| jsv | 2.7.2 |
| appKey | 12574478 |
| v | 1.0 |
| ttid | 1@tbwang_mac_1.0.0#pc |
| needLogin | true |
| type | originaljson |
| t | 当前时间戳 |
| sign | MD5 签名 |

### POST Body（Form Data）

```json
{
  "tabCode": "all",
  "page": <pageNum>,
  "OrderType": "OrderList",
  "appName": "tborder",
  "appVersion": "3.0",
  "condition": { "directRouteToTm2Scene": "1" },
  "__needlessClearProtocol__": true
}
```

### Token 续期

如果响应返回 `FAIL_SYS_TOKEN_EXPIRED` 或 `FAIL_SYS_TOKEN_EMPTY`，浏览器已自动将新的 `_m_h5_tk` 写入 cookie。重读 cookie → 重算签名 → 重发请求（只重试一次）。

## 响应解析

mtop 返回 `data.data` 是一个扁平 key-value 对象，按 `entry.tag` 分类：

| tag | 含义 | 关键字段 |
|-----|------|---------|
| `shopInfo` | 订单基本信息 | `fields.orderId`, `fields.shopName`, `fields.tradeTitle`（状态）, `fields.createTime` |
| `orderItemInfo` | 商品信息 | `fields.item.title`, `fields.item.pic`, `fields.item.priceInfo.actualTotalFee`, `fields.item.quantity` |

用 `entry.id` 关联订单和商品：
- `shopInfo` 的 `id` 即 `orderId`
- `orderItemInfo` 的 `id` 格式为 `orderId_subOrderId`，取 `_` 前的部分关联到对应订单

### 最终输出格式

```json
{
  "total": 15,
  "orders": [
    {
      "orderId": "2244642387687265462",
      "shop": "西安新华书店图书专营店",
      "status": "交易成功",
      "createTime": "2024-08-02 15:37:37",
      "items": [
        {
          "name": "正版新编c语言习题与解析...",
          "image": "//img.alicdn.com/...",
          "price": "￥34.10",
          "qty": "1"
        }
      ]
    }
  ]
}
```

## 关键文件

| 文件 | 作用 |
|------|------|
| `chrome-extension/background.ts` | `executeTaobaoOrdersInMainWorld` + `taobaoOrdersMainWorldFunc` — 核心抓取逻辑 |
| `chrome-extension/manifest.json` | 需要 `scripting` 权限 |
| `scripts/taobao_orders.js` | 最简脚本，只负责 PING 响应（确保 background 检测到脚本已注入） |

## 安装与测试

1. 编译扩展：`cd chrome-extension && npm run build`
2. `chrome://extensions` → 加载/重新加载 Browser MCP 扩展
3. 在 Popup 中安装脚本：名称 `get_taobao_orders`，URL `https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm`
4. 打开淘宝订单页（需已登录）
5. 通过 MCP 调用 `get_taobao_orders`，传 `pageNum: 1`
6. 验证返回包含真实订单数据
7. 传 `pageNum: 2` 验证翻页
