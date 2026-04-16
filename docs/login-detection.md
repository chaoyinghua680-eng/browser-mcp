# 登录检测与等待机制

## 背景与问题

当用户调用 `get_taobao_orders` 或 `deepseek_send_message` 工具时，如果浏览器中对应网站没有登录，原来的做法是直接报错返回。

这种体验很差——用户不知道为什么失败，也没有机会去登录。

### 最初的想法与为什么不行

最直觉的方案是：**在 MAIN world 函数里等待登录**（检测到未登录 → 显示提示 → 轮询等待 → 登录后继续）。

但这行不通，因为：

> 登录时，浏览器会发生**页面跳转**（从登录页跳转回目标页）。
> 页面一旦跳转，`chrome.scripting.executeScript` 注入的函数就会被浏览器**直接杀死**，Promise 永远不会 resolve，最终返回 `undefined`，触发「MAIN world 执行无返回」错误。

### 正确做法

把登录等待逻辑移到 **Service Worker（background.ts）** 里。Service Worker 是独立进程，不受页面跳转影响，可以安全地轮询等待。

---

## 实现架构

整个登录检测分为两个阶段，以淘宝为例：

```text
executeScript()（background 调度层）
    │
    ├─① ensureTaobaoLoggedIn()     ← 阶段一：调用前检查（未登录时等待）
    │
    └─② executeTaobaoOrdersInMainWorld()  ← 阶段二：执行 API
            │
            └─ 若返回 __needRelogin__    ← Session 过期时等待重登录
```

---

## 淘宝：两阶段登录检测

### 阶段一：`ensureTaobaoLoggedIn()`（首次未登录）

**检测方式**：用 `chrome.cookies.getAll` 查询是否存在 `_m_h5_tk` cookie。

选择 `chrome.cookies.getAll` 而不是 `chrome.cookies.get`（指定 URL）的原因：淘宝的 `_m_h5_tk` cookie 设置在根域 `.taobao.com` 上，登录时可能通过 `login.taobao.com` 写入，用特定 URL 查询容易漏掉。

```typescript
const hasCookie = async () => {
  const cookies = await chrome.cookies.getAll({ name: "_m_h5_tk" });
  return cookies.some(c => c.domain.includes("taobao.com"));
};
```

**等待流程**：

```text
hasCookie() === false
    │
    ├─ 通过 executeScript 在淘宝页面注入蓝色横幅提示
    │   "🔗 Browser MCP：请登录淘宝，登录后将自动继续获取数据..."
    │
    └─ 每 2 秒轮询一次 hasCookie()
           │
           ├─ cookie 出现 → 等 1 秒让页面稳定 → 移除横幅 → 继续执行
           └─ 60 秒超时 → 抛出错误
```

注意：横幅注入和移除都是通过 `chrome.scripting.executeScript` 完成的，而不是在 MAIN world 函数内部，所以页面跳转不影响轮询本身。

---

### 阶段二：Session 过期处理（已登录但 Session 失效）

Cookie 存在并不代表 Session 有效。Session 过期时，淘宝 mtop 接口会返回 `FAIL_SYS_SESSION_EXPIRED`。

**为什么不能在 MAIN world 等待**：同样的原因——重新登录会发生页面跳转，函数会被杀死。

**解决方案**：MAIN world 函数检测到 Session 过期时，不等待，直接通过返回值向 background 传递信号：

```typescript
// taobaoOrdersMainWorldFunc 内部
if (Array.isArray(ret) && ret.some(r => /FAIL_SYS_SESSION_EXPIRED/.test(r))) {
  return { __needRelogin__: true };  // 通过返回值传递信号
}
```

background 层的 `executeTaobaoOrdersInMainWorld` 检测到 `__needRelogin__` 后，在 Service Worker 里处理重登录：

```text
MAIN world 返回 { __needRelogin__: true }
    │
    ├─ 在页面注入红色横幅提示（区别于蓝色的「未登录」提示）
    │   "🔗 Browser MCP：淘宝登录已过期，请重新登录，登录后将自动继续..."
    │
    └─ 每 5 秒重新执行一次 taobaoOrdersMainWorldFunc
           │
           ├─ 返回值不含 __needRelogin__ → 登录成功 → 移除横幅 → 返回数据
           └─ 60 秒超时 → 抛出错误
```

重试 API 而不是监测 cookie 变化，是因为 Session 过期时 cookie 值可能不变（只是服务端 Session 失效），直接重试 API 才是最可靠的登录成功判断。

---

## DeepSeek：登录检测

**检测方式**：检测页面上是否存在聊天输入框（`textarea`）。

有输入框 = 已登录进入聊天页；没有输入框 = 还在登录页。

```typescript
const hasTextarea = async (tid: number) => {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: () => !!document.querySelector('textarea[placeholder="Message DeepSeek"], textarea'),
  });
  return results?.[0]?.result === true;
};
```

**等待流程**：

```text
hasTextarea() === false
    │
    ├─ 在 DeepSeek 页面注入蓝色横幅提示
    │   "🔗 Browser MCP：请登录 DeepSeek，登录后将自动继续..."
    │
    └─ 每 3 秒轮询一次
           │
           ├─ 重新查询 chat.deepseek.com 的所有 Tab（登录后页面会跳转回聊天页）
           ├─ hasTextarea() === true → 移除横幅 → 继续执行
           └─ 60 秒超时 → 抛出错误
```

DeepSeek 不需要处理「Session 过期」的情况，因为 DeepSeek 的聊天页面只要输入框在，说明 Session 有效。

---

## 横幅颜色约定

| 颜色 | 含义 | 触发场景 |
| --- | --- | --- |
| 🔵 蓝色（`#6366f1`） | 从未登录 | 淘宝无 cookie、DeepSeek 无输入框 |
| 🔴 红色（`#e84040`） | 登录已过期 | 淘宝 Session 过期（`FAIL_SYS_SESSION_EXPIRED`） |

---

## 关键设计决策

### 为什么用 background 轮询而不是 MAIN world 轮询

| 方式 | 页面跳转时 | 结果 |
| --- | --- | --- |
| MAIN world 内等待 | 函数被杀死 | ❌ 永远返回 `undefined` |
| background 轮询 | 继续运行 | ✅ 正确等待 |

### 为什么淘宝用 `chrome.cookies.getAll` 而不是 `chrome.cookies.get`

`chrome.cookies.get` 需要指定 URL，查询的是「会被发送到该 URL 的 cookie」。淘宝的 `_m_h5_tk` 设置在 `.taobao.com` 根域，通过不同子域登录时行为不一致。`chrome.cookies.getAll({ name: "_m_h5_tk" })` 直接搜索所有域，更可靠。

### 为什么 Session 过期用重试 API 而不是检测 cookie 变化

Session 过期时，`_m_h5_tk` cookie 依然存在，只是服务端 Session 已失效。登录后 cookie 值**可能不变**（取决于淘宝的实现），所以无法通过 cookie 值变化来判断是否重新登录成功。直接重试 API，根据返回结果判断，是最可靠的方式。
