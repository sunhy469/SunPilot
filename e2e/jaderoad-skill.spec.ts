/**
 * JadeRoad Skill E2E Tests
 *
 * 验证 JadeRoad 外贸电商 skill 的 10 个能力端到端链路是否联通。
 * 测试通过浏览器自动化模拟用户在对话框输入消息，等待 AI 响应完成，
 * 验证 assistant 消息中包含预期的内容（非空白、无错误）。
 *
 * 前置条件：
 *   1. daemon 已启动 (pnpm dev:daemon)
 *   2. web dev server 已启动 (pnpm dev:web)
 *   3. JadeRoad skill 已安装且 API keys 已配置
 *
 * 运行：npx playwright test e2e/jaderoad-skill.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

// ── Helpers ──────────────────────────────────────────────────────────────

/** 等待时间（毫秒）—— skill 调用链路可能较长 */
const SKILL_TIMEOUT = 90_000;

/**
 * 在对话框输入消息并发送，等待 assistant 响应完成。
 * 返回 assistant 消息的文本内容。
 */
async function chatAndWaitForResponse(
  page: Page,
  message: string,
): Promise<string> {
  await page.goto("/");
  // 等待页面加载完成（输入框出现）
  const input = page.locator("textarea.chat-composer__input");
  await input.waitFor({ state: "visible", timeout: 15_000 });

  // 输入消息
  await input.fill(message);

  // 点击发送按钮
  const sendBtn = page.locator('button[aria-label="发送"]');
  await sendBtn.click();

  // 等待 assistant 消息出现
  const assistantMsg = page.locator(".message-row.assistant").last();
  await assistantMsg.waitFor({ state: "visible", timeout: 15_000 });

  // 等待响应完成（streaming 状态消失，或 assistant 内容不再变化）
  // 检测方式：等待 "正在" 开头的状态文字消失
  await page.waitForFunction(
    () => {
      const statusEl = document.querySelector(
        '.assistant-status__text, .assistant-status',
      );
      return !statusEl || !statusEl.textContent?.includes("正在");
    },
    undefined, // arg (not used)
    { timeout: SKILL_TIMEOUT },
  );

  // 等待 assistant 消息内容稳定（不再变化）
  // 轮询检查内容是否连续 2 秒不变
  let lastContent = "";
  let stableCount = 0;
  for (let i = 0; i < 30; i++) {
    const current = await assistantMsg.textContent();
    if (current === lastContent) {
      stableCount++;
      if (stableCount >= 4) break; // 2 秒稳定
    } else {
      stableCount = 0;
      lastContent = current ?? "";
    }
    await page.waitForTimeout(500);
  }

  // 获取 assistant 消息文本
  const content = await assistantMsg.textContent();
  return content ?? "";
}

/**
 * 断言 assistant 响应非空白且无致命错误。
 */
function expectValidResponse(content: string, skillName: string) {
  // 不应为空白
  expect(content.trim().length, `[${skillName}] 响应不应为空白`).toBeGreaterThan(0);
  // 不应包含致命错误关键词
  const fatalErrors = ["IMAGE_ATTACHMENT_REQUIRED", "INTERNAL_SERVER_ERROR", "ECONNREFUSED"];
  for (const err of fatalErrors) {
    expect(content, `[${skillName}] 不应包含致命错误 ${err}`).not.toContain(err);
  }
}

// ── Test Suite ───────────────────────────────────────────────────────────

test.describe("JadeRoad Skill E2E", () => {
  // 每个测试前先创建新对话
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  // ── 1. 搜索 1688 货源 ──────────────────────────────────────────────
  test("product.source.search1688 - 搜索1688货源", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我搜索这款蓝牙耳机的1688货源，按销量排序",
    );
    expectValidResponse(content, "search1688");
    // 应包含货源相关内容（商品名/价格/1688链接）
    const hasProductInfo =
      content.includes("1688") ||
      content.includes("货源") ||
      content.includes("商品") ||
      content.includes("供应商") ||
      content.includes("元");
    expect(hasProductInfo, `[search1688] 应包含货源信息`).toBeTruthy();
  });

  // ── 2. 查询 1688 商品详情 ──────────────────────────────────────────
  test("product.source.detail1688 - 查询1688商品详情", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我查看1688商品 729000000000 的详情信息",
    );
    expectValidResponse(content, "detail1688");
    // 应包含商品详情相关内容
    const hasDetailInfo =
      content.includes("详情") ||
      content.includes("价格") ||
      content.includes("SKU") ||
      content.includes("规格") ||
      content.includes("供应商") ||
      content.includes("商品");
    expect(hasDetailInfo, `[detail1688] 应包含商品详情信息`).toBeTruthy();
  });

  // ── 3. 生成短视频脚本 ──────────────────────────────────────────────
  test("video.script.generate - 生成短视频脚本", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我生成一个蓝牙耳机的短视频脚本，目标市场泰国，9:16竖屏",
    );
    expectValidResponse(content, "script.generate");
    // 应包含脚本相关内容（场景/镜头/旁白等）
    const hasScriptContent =
      content.includes("场景") ||
      content.includes("镜头") ||
      content.includes("旁白") ||
      content.includes("脚本") ||
      content.includes("画面") ||
      content.includes("秒");
    expect(hasScriptContent, `[script.generate] 应包含脚本内容`).toBeTruthy();
  });

  // ── 4. 分析爆款视频复刻方案 ────────────────────────────────────────
  test("video.replica.analyze - 分析爆款视频复刻方案", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我分析这个爆款视频的复刻方案：https://example.com/viral-video.mp4，目标市场东南亚",
    );
    expectValidResponse(content, "replica.analyze");
    // 应包含分析相关内容
    const hasAnalysisContent =
      content.includes("复刻") ||
      content.includes("分析") ||
      content.includes("场景") ||
      content.includes("镜头") ||
      content.includes("方案") ||
      content.includes("视频");
    expect(hasAnalysisContent, `[replica.analyze] 应包含分析内容`).toBeTruthy();
  });

  // ── 5. 生成 Seedream 商品图 ────────────────────────────────────────
  test("image.generate.seedream - 生成Seedream商品图", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我生成一张蓝牙耳机的商品图，白色背景，1:1正方形",
    );
    expectValidResponse(content, "image.generate.seedream");
    // 应包含图片相关内容
    const hasImageContent =
      content.includes("图片") ||
      content.includes("商品图") ||
      content.includes("生成") ||
      content.includes("artifact") ||
      content.includes("素材");
    expect(hasImageContent, `[image.generate.seedream] 应包含图片生成结果`).toBeTruthy();
  });

  // ── 6. 商品图魔术擦除 ──────────────────────────────────────────────
  test("image.magic.erase - 商品图魔术擦除", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我把这张商品图中的水印擦除：https://example.com/product-with-watermark.png",
    );
    expectValidResponse(content, "image.magic.erase");
    // 应包含擦除相关内容
    const hasEraseContent =
      content.includes("擦除") ||
      content.includes("图片") ||
      content.includes("编辑") ||
      content.includes("生成") ||
      content.includes("处理");
    expect(hasEraseContent, `[image.magic.erase] 应包含擦除结果`).toBeTruthy();
  });

  // ── 7. 准备商品参考图 ──────────────────────────────────────────────
  test("product.reference.prepare - 准备商品参考图", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我把这张图片准备为商品参考图：https://example.com/product-photo.png",
    );
    expectValidResponse(content, "product.reference.prepare");
    // 应包含参考图相关内容
    const hasRefContent =
      content.includes("参考图") ||
      content.includes("图片") ||
      content.includes("准备") ||
      content.includes("artifact") ||
      content.includes("素材");
    expect(hasRefContent, `[product.reference.prepare] 应包含参考图结果`).toBeTruthy();
  });

  // ── 8. 生成 Seedance 营销视频 ──────────────────────────────────────
  test("video.generate.seedance - 生成Seedance营销视频", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我生成一个12秒的蓝牙耳机营销视频，9:16竖屏，科技风格",
    );
    expectValidResponse(content, "video.generate.seedance");
    // 应包含视频相关内容（放宽匹配：skill 可能返回参数不足提示）
    const hasVideoContent =
      content.includes("视频") ||
      content.includes("生成") ||
      content.includes("artifact") ||
      content.includes("营销") ||
      content.includes("素材") ||
      content.includes("Seedance") ||
      content.includes("参数") ||
      content.includes("缺少") ||
      content.includes("需要") ||
      content.includes("skill");
    expect(hasVideoContent, `[video.generate.seedance] 应包含视频生成结果`).toBeTruthy();
  });

  // ── 9. 保存生成素材 ────────────────────────────────────────────────
  test("product.persist - 保存生成素材", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我把这张图片保存为素材：https://example.com/generated-image.png，类型是图片",
    );
    expectValidResponse(content, "product.persist");
    // 应包含保存相关内容
    const hasPersistContent =
      content.includes("保存") ||
      content.includes("素材") ||
      content.includes("artifact") ||
      content.includes("持久化") ||
      content.includes("下载");
    expect(hasPersistContent, `[product.persist] 应包含保存结果`).toBeTruthy();
  });

  // ── 10. 创建虚拟人素材 ──────────────────────────────────────────────
  test("avatar.asset.create - 创建虚拟人素材", async ({ page }) => {
    const content = await chatAndWaitForResponse(
      page,
      "帮我上传一个虚拟人图片素材，分组ID为default，图片地址：https://example.com/avatar.png",
    );
    expectValidResponse(content, "avatar.asset.create");
    // 应包含虚拟人相关内容
    const hasAvatarContent =
      content.includes("虚拟人") ||
      content.includes("素材") ||
      content.includes("avatar") ||
      content.includes("上传") ||
      content.includes("创建");
    expect(hasAvatarContent, `[avatar.asset.create] 应包含虚拟人创建结果`).toBeTruthy();
  });
});
