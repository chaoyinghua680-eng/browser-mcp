# DeepSeek Browser Transport 说明

## 1. 结论

你的核心需求已经在 **DeepSeek 网页版** 上验证成功：

- 不接入官方 API
- 不单独管理 API Key
- 复用浏览器里已经登录的网页会话
- 通过本地服务发起请求
- 成功取回模型回答

实际验证结果是：调用本地 OpenAI 兼容端点 `/v1/chat/completions`，`model=deepseek-chat` 时，能够通过已登录的 `chat.deepseek.com` 页面返回正常回复。

## 2. 需要澄清的地方

这个需求的目标已经达成，但**实现方式**和最初设想有一点区别。

### 最初设想

通过浏览器中的 Cookie / Session / Token，直接向第三方大模型网页端内部 API 发请求，再把回答取回。

### 当前实际实现

对于 DeepSeek，这条路不可行。原因是网页内部 API 依赖 WebAssembly PoW 机制，请求签名与载荷绑定，不能简单复用。

所以当前落地方案改为：

- 在 Chrome 扩展的 `MAIN world` 中进入 `chat.deepseek.com`
- 直接操作页面 DOM
- 模拟真实用户输入、点击发送
- 等待网页完成生成
- 从页面中提取最终回答文本

因此，准确表述应该是：

> 已经实现“复用浏览器登录态调用第三方大模型网页版并获取回答”，但当前在 DeepSeek 上采用的是 **UI 自动化方案**，而不是“直接复用 Cookie 后发 HTTP API 请求”的方案。

## 3. 当前实现范围

当前版本是一个 **MVP**，范围刻意收窄：

- 仅支持 `deepseek-chat`
- 仅支持 **single-turn**
- 不支持多轮上下文映射
- 不支持 `deepseek-reasoner`
- 不支持通用“任意第三方大模型网页”
- 不支持 ChatGPT 网页版

也就是说，现在证明成功的是：

> Browser MCP 可以把“已登录浏览器页面”封装成一个可调用的大模型入口。

但当前真正打通的只有 **DeepSeek 网页版** 这一条链路。

## 4. 架构概览

请求链路如下：

```text
客户端 / curl
  -> mcp-server /v1/chat/completions
  -> http-bridge
  -> native-host / bridge-server
  -> Chrome Extension background.ts
  -> chrome.scripting.executeScript(world=MAIN)
  -> chat.deepseek.com 页面 DOM
  -> 输入消息 / 点击发送 / 等待生成
  -> 读取最后一条回复文本
  -> 原路返回
```

## 5. DeepSeek 方案的关键点

### 5.1 为什么不用 API 拦截

DeepSeek 网页接口带有较强的反爬和防重放机制，包括：

- 登录态校验
- 页面内动态状态
- WebAssembly PoW
- 与请求内容绑定的校验逻辑

因此，直接在扩展或本地服务里伪造网页 API 请求，稳定性差，维护成本高。

### 5.2 为什么 UI 自动化能工作

因为真正的网页页面已经：

- 完成登录
- 持有有效会话
- 具备页面运行环境
- 能自然通过网页自身的校验和限制

扩展只是在这个真实页面里代替用户完成输入和点击，所以能避开 API 层的复杂限制。

## 6. 当前实现特性

当前 DeepSeek MVP 具备这些行为：

- DeepSeek 走扩展内建分支，不依赖 `storage.scripts`
- 使用专用后台 Tab，避免污染用户正在看的普通页面
- 单飞锁控制，并发请求会直接拒绝
- 超时链路统一到 `120s`
- OpenAI 兼容入口只允许 `model=deepseek-chat`
- 输入消息后，等待页面开始回复，再读取最终文本

## 7. 使用方式

先确保：

1. Chrome 扩展已重新加载
2. `chat.deepseek.com` 已登录
3. `./start.sh --build` 已启动

然后可以通过本地 OpenAI 兼容端点调用：

```bash
curl -X POST http://localhost:8006/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"model":"deepseek-chat"}'
```

成功时会返回类似：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！又见面啦～ 有什么我可以帮你的吗？"
      },
      "finish_reason": "stop"
    }
  ]
}
```

## 8. 这个成果说明了什么

这次打通说明 Browser MCP 已经具备一种可复用模式：

### 可复用的能力

- 将“浏览器里已登录的网站”变成一个可编程调用的能力入口
- 用 OpenAI 兼容接口对外暴露
- 不依赖官方 API Key

### 但不是通用结论

不能直接推导出：

- 任意网页版大模型都能同样方式接入
- ChatGPT 网页版已经可用
- 所有站点都适合做 API 拦截

更准确的结论是：

> “通过复用浏览器登录态调用网页版大模型”这类需求是可实现的；DeepSeek 已经用 UI 自动化方式成功验证。

## 9. 当前限制

这版仍然有明显限制：

- 依赖页面 DOM 结构，目标网站改版后可能失效
- 只能单轮，不维护会话映射
- 并发能力弱，同一时刻只处理一个 DeepSeek 请求
- 返回内容是页面最终文本，不是原始增量流
- 强依赖浏览器中已有登录态

## 10. 后续可选演进

如果后面继续做，可以按这个顺序推进：

1. 增加更稳定的 DOM 选择和调试日志
2. 增加并发/排队机制
3. 为每个提供方定义独立适配器
4. 评估 ChatGPT 网页版是否适合做同类 UI 自动化接入
5. 如有必要，再设计多轮会话映射

## 11. 最终结论

如果把你的原始需求拆成两层来看：

### 目标层

“复用浏览器中已登录的第三方大模型网页能力，对外提供一个可调用接口，省去单独接 API 的成本。”

这个目标，**已经成功**。

### 实现层

“直接复用 Cookie / Session 发网页内部 API 请求。”

这个实现路径，**在 DeepSeek 上没有采用**，因为不稳定且不可维护；最终成功落地的是 **浏览器登录态 + 页面 UI 自动化**。
