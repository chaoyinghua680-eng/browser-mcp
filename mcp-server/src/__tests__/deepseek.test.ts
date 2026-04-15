import { describe, test, expect } from "vitest";
import { validateToolParams } from "../tools.js";

// ── validateToolParams 参数校验 ──────────────────

describe("deepseek_send_message tool validation", () => {
  test("accepts valid params with message only", () => {
    const r = validateToolParams("deepseek_send_message", { message: "hello" });
    expect(r.ok).toBe(true);
  });

  test("rejects unknown param (additionalProperties: false)", () => {
    const r = validateToolParams("deepseek_send_message", {
      message: "hello",
      unknown_field: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不允许的参数字段");
  });

  test("rejects non-object params", () => {
    const r = validateToolParams("deepseek_send_message", "bad");
    expect(r.ok).toBe(false);
  });

  test("rejects null params", () => {
    const r = validateToolParams("deepseek_send_message", null);
    expect(r.ok).toBe(false);
  });

  test("rejects missing required message", () => {
    const r = validateToolParams("deepseek_send_message", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("缺少必填参数");
  });

  test("rejects non-string message", () => {
    const r = validateToolParams("deepseek_send_message", { message: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("必须是字符串");
  });

  test("rejects unknown tool name", () => {
    const r = validateToolParams("nonexistent_tool", { message: "hello" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("未知工具");
  });
});

// ── 既有工具不受影响 ──────────────────

describe("existing tools still work", () => {
  test("get_taobao_orders accepts valid params", () => {
    const r = validateToolParams("get_taobao_orders", { pageNum: 1 });
    expect(r.ok).toBe(true);
  });

  test("get_jd_orders accepts valid params", () => {
    const r = validateToolParams("get_jd_orders", { pageNum: 2 });
    expect(r.ok).toBe(true);
  });

  test("get_taobao_orders rejects unknown param", () => {
    const r = validateToolParams("get_taobao_orders", { pageNum: 1, bad: "x" });
    expect(r.ok).toBe(false);
  });
});
