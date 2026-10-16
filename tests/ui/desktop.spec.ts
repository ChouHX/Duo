import { test, expect, type Page } from "@playwright/test";

// Synthetic API fixture. Never invokes native commands or Apple endpoints.
async function fixture(
  page: Page,
  withAccounts = true,
  firstEmail = "first@example.test",
) {
  await page.addInitScript(
    ({ withAccounts, firstEmail }) => {
      const defaults = {
        id: "00000000-0000-0000-0000-000000000000",
        name: "通用预设",
        email: "",
        preset_sku: "MK2U4CH",
        preset_quantity: 2,
        preset_items: [{ sku: "MK2U4CH", quantity: 2 }],
      };
      // 真实账号在建立时就继承了通用预设的 SKU 与数量。
      const accounts = withAccounts
        ? [
            {
              id: "a",
              name: "日常账号",
              email: firstEmail,
              preset_sku: "MK2U4CH",
              preset_quantity: 2,
              preset_items: [{ sku: "MK2U4CH", quantity: 2 }],
            },
            {
              id: "b",
              name: "备用账号",
              email: "second@example.test",
              preset_sku: "MK2U4CH",
              preset_quantity: 2,
              preset_items: [{ sku: "MK2U4CH", quantity: 2 }],
            },
          ]
        : [];
      const tasks: any[] = [];
      let callback = (task: any) => {};
      let counter = 0;
      const update = (task: any) => {
        if (task.result?.account_removed) {
          const index = accounts.findIndex((a) => a.id === task.account_id);
          if (index >= 0) accounts.splice(index, 1);
        }
        callback(structuredClone(task));
      };
      const root = window as any;
      root.sent = [];
      root.started = [];
      root.removed = [];
      root.opened = [];
      root.timed = [];
      root.finish = (id: string, changes: any) => {
        const t = tasks.find((t) => t.id === id);
        Object.assign(t, changes);
        update(t);
      };
      root.__DUO_KILLER_TEST__ = {
        remove: async (accountId: string) => {
          if (root.removeError) throw new Error(root.removeError);
          if (
            tasks.some(
              (t) =>
                t.account_id === accountId &&
                ["waiting", "running", "queued"].includes(t.status),
            )
          )
            throw new Error("该账号仍有任务执行，请完成或取消后再移除");
          root.removed.push(accountId);
          const index = accounts.findIndex((a) => a.id === accountId);
          if (index >= 0) accounts.splice(index, 1);
          for (let i = tasks.length - 1; i >= 0; i--)
            if (tasks[i].account_id === accountId) tasks.splice(i, 1);
        },
        snapshot: async () =>
          structuredClone({
            accounts,
            tasks,
            data_dir: "/fixture",
            defaults,
          }),
        openUrl: async (url: string) => {
          root.opened.push(url);
        },
        savePreset: async (accountId: string, items: any[]) => {
          const values = {
            preset_items: items,
            preset_sku: items[0].sku,
            preset_quantity: items[0].quantity,
          };
          if (accountId === "00000000-0000-0000-0000-000000000000") {
            Object.assign(defaults, values);
            return structuredClone(defaults);
          }
          const account = accounts.find((a) => a.id === accountId)!;
          Object.assign(account, values);
          return structuredClone(account);
        },
        add: async (email: string) => {
          if (accounts.some((a) => a.email === email))
            throw new Error("这个账号已添加");
          const a = {
            id: "new-" + ++counter,
            name: email,
            email,
            pending: true,
            preset_sku: defaults.preset_sku,
            preset_quantity: defaults.preset_quantity,
            preset_items: structuredClone(defaults.preset_items),
          };
          accounts.push(a);
          return a;
        },
        subscribe: async (cb: any) => {
          callback = cb;
          return () => {};
        },
        start: async (accountId: string, action: string, params: any) => {
          const id = "task-" + ++counter;
          const task: any = {
            id,
            account_id: accountId,
            action,
            status: "running",
            stage: "测试阶段",
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
            prompt: null,
            result: null,
            order_submitted: false,
            logs: ["测试日志：开始执行"],
          };
          tasks.unshift(task);
          root.started.push({ accountId, action, id, params });
          if (
            action === "login" ||
            action === "enroll" ||
            (action === "me" && root.waitForMe)
          ) {
            task.status = "waiting";
            task.prompt = {
              id: "p-" + id,
              kind: "password",
              label: "输入 Apple 账号密码",
            };
          } else if (action === "timed_purchase") {
            // 定时抢购会一直等到抢购时刻，这里保持"执行中"。
            task.status = "running";
            task.stage = "预热倒计时：还有 59 分 00 秒。";
            root.timed.push({ accountId, id, params });
          } else if (action === "purchase") {
            task.status = "waiting";
            task.prompt = {
              id: "p-" + id,
              kind: "confirm",
              label: "确认商品与金额，创建订单",
              details: {
                items: (params.items || []).map((item: any) => ({
                  name:
                    item.sku === "MK2U4CH" ? "测试商品" : `商品 ${item.sku}`,
                  sku: item.sku,
                  quantity: item.quantity,
                  subtotal: "RMB 138",
                })),
                total: "RMB 138",
                address: "测试地址",
              },
            };
          } else if (action === "qr") {
            task.status = "succeeded";
            task.result = {
              success: true,
              qr_data: "data:image/png;base64,iVBORw0KGgo=",
            };
          } else if (action === "orders") {
            task.status = "succeeded";
            task.result = {
              success: true,
              orders: [
                {
                  order_number: "TEST001",
                  items: [
                    {
                      name: "测试商品",
                      quantity: 2,
                      delivery_info: root.paidOrders
                        ? "预计 10 月 20 日送达"
                        : "我们正在等待你的付款",
                    },
                  ],
                },
              ],
              message: "订单列表读取完成。",
            };
          } else if (action === "checkout") {
            task.status = "waiting";
            task.prompt = {
              id: "p-" + id,
              kind: "select",
              label: "收货方式",
              default: "HOME",
              options: [
                { value: "HOME", label: "为我送货" },
                { value: "RETAIL", label: "我要自提" },
              ],
            };
          } else if (action === "address_read") {
            task.status = "succeeded";
            task.result = {
              success: true,
              config: root.addressConfig ?? {},
            };
          } else if (action === "address_save") {
            task.status = "succeeded";
            root.savedAddress = params;
            // 真实 worker 会返回合并后的完整配置（含送货方式等字段）。
            const merged = { ...(root.addressConfig || {}), ...params };
            root.addressConfig = merged;
            task.result = {
              success: true,
              config: merged,
              message: "快捷地址已保存",
            };
          } else if (action === "catalog") {
            task.status = root.catalogFails ? "failed" : "succeeded";
            task.stage = root.catalogFails
              ? "商品页查询失败：HTTP 541"
              : "查询完成";
            task.result = root.catalogFails
              ? null
              : {
                  success: true,
                  queried_at: new Date().toISOString(),
                  items: [
                    {
                      sku: "MK2Q4CH/A",
                      name: "iPhone Duo 512GB Night Sky",
                      price: 17999,
                      can_add_to_bag: false,
                      coming_soon: true,
                      reason: "即将发售",
                    },
                    {
                      sku: "MK2U4CH/A",
                      name: "iPhone Duo 1TB Night Sky",
                      price: 21499,
                      can_add_to_bag: null,
                      coming_soon: false,
                    },
                  ],
                };
          } else if (action === "me") {
            task.status = "succeeded";
            task.result = {
              success: true,
              logged_in: true,
              name:
                root.meName ?? accounts.find((a) => a.id === accountId)?.name,
              scope: "account",
              apple_id: accounts.find((a) => a.id === accountId)?.email,
            };
          } else if (action === "region_options") {
            task.status = "succeeded";
            const level = String(params?.level || "state");
            const shanghai = params?.state === "上海市";
            // 和真实官网一样按已选省市返回下级选项。
            const options =
              level === "state"
                ? [
                    { value: "四川", label: "四川" },
                    { value: "上海市", label: "上海市" },
                  ]
                : level === "city"
                  ? shanghai
                    ? [{ value: "上海市", label: "上海市" }]
                    : [{ value: "成都", label: "成都" }]
                  : shanghai
                    ? [{ value: "浦东新区", label: "浦东新区" }]
                    : [{ value: "锦江区", label: "锦江区" }];
            task.result = {
              success: true,
              level,
              state: params?.state || "",
              city: params?.city || "",
              options,
            };
          } else if (action === "stores") {
            task.status = "succeeded";
            task.result = {
              success: true,
              state: params?.state,
              city: params?.city,
              district: params?.district,
              stores: [
                {
                  id: "R648",
                  name: "成都万象城",
                  city: "成都",
                  state: "四川",
                  availability: [{ name: "iPhone Duo", quote: "今天可取货" }],
                },
                {
                  id: "R1",
                  name: "暂无供应门店",
                  disabled: true,
                  city: "成都",
                  state: "四川",
                },
              ],
            };
          } else if (action === "preset_apply") {
            task.status = "succeeded";
            const config = {
              ...(root.addressConfig || {}),
              delivery: {
                state: "上海市",
                city: "上海市",
                district: "浦东新区",
              },
              address: { street: "通用预设路 9 号" },
              delivery_method: "delivery",
            };
            root.addressConfig = config;
            task.result = {
              success: true,
              config,
              message: "已按通用预设填入并保存：地址、送货方式（快递配送）。",
            };
          } else if (action === "store_save") {
            task.status = "succeeded";
            const config = { ...(root.addressConfig || {}) };
            if (params && "method" in params)
              config.delivery_method = params.method;
            if (params && "store" in params)
              config.store = params.store || null;
            if (params && "applecare" in params)
              config.applecare = params.applecare;
            root.addressConfig = config;
            const parts: string[] = [];
            if (params && "method" in params)
              parts.push(
                params.method === "pickup"
                  ? "已选择门店自提：下单时直接自提。"
                  : "已选择快递配送：下单时直接送货。",
              );
            if (params && "applecare" in params)
              parts.push(
                params.applecare
                  ? "已开启 AppleCare+。"
                  : "已关闭 AppleCare+。",
              );
            task.result = {
              success: true,
              config,
              message: parts.join("") || "送货方式与门店已保存",
            };
          } else {
            task.status = "succeeded";
            task.result = { success: true };
          }
          if (action === "me" && task.result?.logged_in) {
            const a = accounts.find((a) => a.id === accountId)!;
            a.name = task.result.name?.trim() || a.email;
          }
          update(task);
          return id;
        },
        reply: async (
          accountId: string,
          taskId: string,
          requestId: string,
          value: any,
        ) => {
          root.sent.push({ accountId, taskId, requestId, value });
          const task = tasks.find((t) => t.id === taskId);
          if (task.prompt.kind === "password") {
            task.prompt = {
              id: "code-" + task.id,
              kind: "code",
              label: "设备六位验证码：",
              actions: [{ value: "s", label: "改用短信验证码" }],
            };
            task.status = "waiting";
            update(task); // A new prompt can arrive before the previous invoke resolves.
          } else if (
            task.prompt.kind === "code" &&
            ["s", "d"].includes(value)
          ) {
            task.prompt = {
              id: "code-" + value + "-" + task.id,
              kind: "code",
              label: value === "s" ? "短信六位验证码：" : "设备六位验证码：",
              actions:
                value === "s" ? [{ value: "d", label: "改用设备验证码" }] : [],
            };
            update(task);
          } else if (task.action === "enroll" || task.action === "me") {
            const a = accounts.find((a) => a.id === accountId)!;
            Object.assign(a, { pending: false, name: "接口昵称" });
            task.status = "succeeded";
            task.prompt = null;
            task.result = {
              success: true,
              logged_in: true,
              scope: "account",
              name: a.name,
              apple_id: a.email,
            };
            update(task);
          } else {
            task.status = "succeeded";
            task.prompt = null;
            task.result =
              task.action === "purchase" && value === true
                ? {
                    success: true,
                    status: "pending_payment",
                    order_number: "TEST001",
                    amount_due: "RMB 138",
                    qr_data: "data:image/png;base64,iVBORw0KGgo=",
                    applecare: root.applecareResult,
                  }
                : { success: true };
            update(task);
          }
        },
        cancel: async (accountId: string, taskId: string) => {
          const t = tasks.find((t) => t.id === taskId);
          t.status = "cancelled";
          t.prompt = null;
          update(t);
        },
      };
    },
    { withAccounts, firstEmail },
  );
}

// 进入某个账号的页面（账号与登录）：现在账号级功能都在这里。
async function enterWorkspace(page: Page) {
  await page.locator(".sidebar .account").first().click();
  await expect(
    page.getByRole("button", { name: "检查登录", exact: true }),
  ).toBeVisible();
}

// 进入"付款码"页（侧边栏入口）。
async function gotoPayment(page: Page) {
  await page.getByRole("link", { name: "付款码", exact: true }).click();
  await expect(page.locator(".pay-view")).toBeVisible();
}

// 进入账号工作台的"批量下单"页签（多账号下单入口）。
async function enterBatch(page: Page) {
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /立即下单（当前账号）/ }),
  ).toBeVisible();
}

test("new account is only added after password and OTP succeed", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/");
  await page.getByLabel("Apple 账号", { exact: true }).fill("new@example.test");
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "检查登录", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查登录", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("六位验证码").fill("012345");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查登录", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(() =>
    (window as any).__DUO_KILLER_TEST__.snapshot(),
  );
  expect(state.accounts[0].pending).toBe(false);
  expect(state.accounts[0].name).toBe("接口昵称");
  await expect(
    page.locator(".sidebar").getByRole("button", { name: /接口昵称/ }),
  ).toBeVisible();
});

test("credentials and leading-zero codes stay with the selected account", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "显示密码" }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByLabel("六位验证码")).toBeVisible();
  await page.getByRole("button", { name: /备用账号 seco/ }).click();
  await expect(page.getByLabel("六位验证码")).toHaveCount(0);
  await page.getByRole("button", { name: "检查登录", exact: true }).click();
  await expect(page.getByText("备用账号 · seco**@example.test")).toBeVisible();
  await page.getByRole("button", { name: /日常账号 fir/ }).click();
  await page.getByLabel("六位验证码").fill("012345");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    {
      accountId: "a",
      taskId: "task-3",
      requestId: "p-task-3",
      value: { password: "fixture-password", remember: false },
    },
    {
      accountId: "a",
      taskId: "task-3",
      requestId: "code-task-3",
      value: "012345",
    },
  ]);
});

test("OTP method buttons switch within the same account without submitting a code", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  const code = page.getByLabel("六位验证码", { exact: true });
  await expect(code).toHaveValue("");
  await expect(page.getByText(/输入 [sd] 改用/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "改用设备验证码" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "改用短信验证码" }).click();
  await expect(
    page.getByRole("heading", { name: "短信六位验证码：" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "改用短信验证码" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "改用设备验证码" }).click();
  await expect(
    page.getByRole("heading", { name: "设备六位验证码：" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "切换验证方式" })).toHaveCount(
    0,
  );
  await code.fill("012");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  expect(await page.evaluate(() => (window as any).sent)).toHaveLength(3);
  await code.fill("012345");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  const replies = await page.evaluate(() => (window as any).sent);
  expect(replies.slice(1).map((r: any) => r.value)).toEqual([
    "s",
    "d",
    "012345",
  ]);
  expect(
    replies.every((r: any) => r.accountId === "a" && r.taskId === "task-3"),
  ).toBe(true);
});

test("order confirmation is explicit and can be rejected", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("button", { name: "立即下单" }).click();
  await expect(
    page.getByRole("cell", { name: "测试商品 MK2U4CH" }),
  ).toBeVisible();
  await expect(page.getByText("总支付", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).sent)).toHaveLength(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await page.evaluate(() => (window as any).sent))[0].value).toBe(
    false,
  );
});

test("orders use a table and workspace fits minimum window width", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "订单", exact: true }).click();
  await page.getByRole("button", { name: "查询订单", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "我们正在等待你的付款" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 820, height: 620 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "artifacts/ui-orders.png", fullPage: true });
});

test("desktop workspace screenshot", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "检查登录", exact: true }).click();
  await expect(page.locator(".task-detail")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "artifacts/ui-workspace.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("sidebar clock syncs against the public time API and shows drift", async ({
  page,
}) => {
  await fixture(page);
  // 固定服务器时间：UTC 2026-10-16T00:00:00.000Z → 北京 08:00:00
  await page.route("https://timeapi.io/api/Time/current/zone**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        year: 2026,
        month: 10,
        day: 16,
        hour: 0,
        minute: 0,
        seconds: 0,
        milliSeconds: 0,
        timeZone: "UTC",
      }),
    }),
  );
  await page.goto("/");
  const clock = page.locator(".clock-sync");
  const time = clock.locator(".clock-time");
  await expect(clock).toBeVisible();
  await expect(time).toHaveText(/08:00:0[0-9]/);
  await expect(clock).toContainText("网络时间");
  await expect(clock).toContainText(/本机(快|慢)|与本机一致/);
  const first = await time.innerText();
  // 校时后的秒数应当自己往前走
  await expect(time).not.toHaveText(first, { timeout: 5000 });
});

test("concurrent ordering starts one purchase per enabled account", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("tab", { name: "工作台", exact: true }).click();
  const progress = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "各账号进度" }) });
  await expect(progress.getByRole("cell", { name: "日常账号" })).toBeVisible();
  await expect(progress.getByRole("cell", { name: "备用账号" })).toBeVisible();
  await expect(progress.getByRole("cell", { name: "空闲" })).toHaveCount(2);
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  const button = page.getByRole("button", { name: /并发下单（2 个账号）/ });
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("并发下单：2 个账号");
  await expect(
    dialog.getByRole("list", { name: "并发下单的账号" }),
  ).toContainText("日常账号");
  await expect(
    dialog.getByRole("list", { name: "并发下单的账号" }),
  ).toContainText("备用账号");
  await page.evaluate(() => {
    (window as any).started.length = 0;
  });
  await dialog.getByRole("button", { name: "开始下单" }).click();
  await expect(dialog).toHaveCount(0);
  const started = await page.evaluate(() => (window as any).started);
  expect(started.map((t: any) => `${t.accountId}:${t.action}`).sort()).toEqual([
    "a:purchase",
    "b:purchase",
  ]);
  await expect(
    page.getByRole("button", { name: "2 个任务进行中", exact: true }),
  ).toBeVisible();
  // 并发下单后自动进入付款码页：回到工作台看进度表。
  await expect(page.locator(".pay-view")).toBeVisible();
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "工作台", exact: true }).click();
  await expect(
    progress.getByRole("cell", { name: "购买商品（需要操作）" }),
  ).toHaveCount(2);
  expect(
    (await page.evaluate(() => (window as any).sent)).length,
  ).toBeGreaterThanOrEqual(0);
});

test("purchase preset is global and accounts on the old value follow", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "购买预设" }).click();
  await page.getByLabel("商品 SKU").fill("MLH74FE");
  await page.getByLabel("数量", { exact: true }).fill("3");
  await page.getByRole("button", { name: "保存购买预设", exact: true }).click();
  await expect(
    page.getByText("购买预设已保存（2 个账号跟随更新）", { exact: true }),
  ).toBeVisible();
  // 保存后两个账号都跟随全局值，批量下单表单也以全局预设为默认。
  const presets = await page.evaluate(() =>
    (window as any).__DUO_KILLER_TEST__
      .snapshot()
      .then((s: any) => [
        s.defaults.preset_sku + "×" + s.defaults.preset_quantity,
        ...s.accounts.map((a: any) => a.preset_sku + "×" + a.preset_quantity),
      ]),
  );
  expect(presets).toEqual(["MLH74FE×3", "MLH74FE×3", "MLH74FE×3"]);
  // 账号页不再有"购买预设"与"商品"页签。
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /日常账号 fir/ })
    .click();
  await expect(page.getByRole("tab")).toHaveText([
    "账号与登录",
    "送货方式",
    "购物袋",
    "订单",
  ]);
});

test("delivery choices keep the real option value and default", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "购物袋", exact: true }).click();
  await page.getByRole("button", { name: "结算购物袋" }).click();
  await expect(page.locator(".prompt-form .ant-select")).toHaveText("为我送货");
  await page.getByRole("combobox", { name: "选择一个选项" }).click();
  await page.getByRole("option", { name: "我要自提", exact: true }).click();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  expect((await page.evaluate(() => (window as any).sent))[0].value).toBe(
    "RETAIL",
  );
});

test("payment panel lists the AppleCare+ that was added to the bag", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    (window as any).applecareResult = [
      {
        sku: "sHHY3CH/A",
        title: "适用于 iPhone 18 Pro 的 AppleCare+ 服务计划",
        price: "RMB 1,799",
      },
    ];
  });
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("button", { name: "立即下单" }).click();
  await page.getByRole("button", { name: "确认创建订单", exact: true }).click();
  await gotoPayment(page);
  const list = page.locator(".pay-card .applecare-list");
  await expect(list).toHaveAttribute("aria-label", "已加入的 AppleCare+");
  await expect(list).toContainText("AppleCare+ 服务计划");
  await expect(list).toContainText("RMB 1,799");
});

test("payment result offers an order query without creating another order", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("button", { name: "立即下单" }).click();
  await page.screenshot({ path: "artifacts/ui-confirm.png", fullPage: true });
  await page.getByRole("button", { name: "确认创建订单", exact: true }).click();
  // 底部提示条只留提示与入口，二维码在「付款码」页。
  const footer = page.locator(".page-footer");
  await expect(footer).toContainText("付款二维码在「付款码」页");
  await expect(footer.locator("img")).toHaveCount(0);
  await gotoPayment(page);
  await expect(page.locator(".pay-card")).toHaveCount(1);
  await expect(page.locator(".pay-card .applecare-list")).toHaveCount(0);
  await page
    .locator(".pay-card")
    .getByRole("button", { name: "我已支付，查询订单" })
    .click();
  await expect(
    page.getByRole("cell", { name: "我们正在等待你的付款" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).sent)).toHaveLength(1);
});

test("startup enables every saved account and checks the unchecked ones once", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "切换账号" });
  // 侧边栏直接列出所有账号，不再需要"选择本次使用的账号"。
  await expect(nav.getByRole("button", { name: /日常账号 fir/ })).toBeVisible();
  await expect(
    nav.getByRole("button", { name: /备用账号 seco/ }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /立即下单（当前账号）/ }),
  ).toBeVisible();
  // 没有检查记录的账号各自自动检查一次（两个账号各一次 me）。
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).started.filter((t: any) => t.action === "me").length,
      ),
    )
    .toBe(2);
  await expect(page.locator(".sidebar .account .dot.ok")).toHaveCount(2);
  await page.screenshot({
    path: "artifacts/startup-selection.png",
    fullPage: true,
  });
});

test("sidebar lists every saved account and switching needs no selection step", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  const nav = page.getByRole("navigation", { name: "切换账号" });
  await expect(nav.getByRole("button")).toHaveCount(2);
  await nav.getByRole("button", { name: /备用账号 seco/ }).click();
  await expect(page.locator(".topbar-account")).toContainText("备用账号");
  await expect(page.locator(".topbar-account")).toContainText(
    "seco**@example.test",
  );
});

test("cancelled enrollment remains pending and can be retried", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/");
  await page.getByLabel("Apple 账号", { exact: true }).fill("new@example.test");
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("heading", { name: "未完成添加" })).toBeVisible();
  expect(
    (await page.evaluate(() => (window as any).__DUO_KILLER_TEST__.snapshot()))
      .accounts[0].pending,
  ).toBe(true);
  await expect(page.getByRole("button", { name: "立即下单" })).toHaveCount(0);
  await page.getByRole("button", { name: "继续登录 n**@example.test" }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
});

test("a login check waiting for input only affects that account", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    (window as any).waitForMe = true; // 账号 a 的检查需要输入密码
  });
  await page.goto("/");
  // 账号 a 的检查停在"需要操作"，但不会卡住账号 b 的检查。
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).started.map((t: any) => t.accountId)),
    )
    .toEqual(["a", "b"]);
  // 两个账号的检查都停在"需要操作"，说明顺序检查没有被第一个卡住。
  await expect(page.locator(".sidebar .account .dot.waiting")).toHaveCount(2);
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("AppleCare+ preset round-trips through the delivery method card", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    (window as any).addressConfig = {
      contact: {
        lastName: "周",
        firstName: "晓",
        emailAddress: "first@example.test",
        fullDaytimePhone: "18109038858",
      },
      delivery: { state: "四川", city: "成都", district: "锦江区" },
      address: { street: "测试路 8 号" },
      auto_checkout: true,
      applecare: true,
    };
  });
  await page.goto("/");
  await enterWorkspace(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /日常账号 fir/ })
    .click();
  await page.getByRole("tab", { name: "送货方式" }).click();
  await page.getByRole("button", { name: "快捷送货地址说明" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "下单时直接使用这份快捷地址，全程全自动",
  );
  // 下单方式就是全自动：界面不再提供开关。
  await expect(page.getByRole("checkbox", { name: /全自动下单/ })).toHaveCount(
    0,
  );
  const applecare = page.getByRole("checkbox", { name: /AppleCare\+/ });
  await expect(applecare).toBeChecked();
  // 取消 AppleCare+ 会立刻写进该账号的配置，地址表单不再携带这一项。
  await applecare.uncheck();
  await expect(page.locator(".task-footer")).toContainText("已关闭 AppleCare+");
  expect(
    await page.evaluate(() => (window as any).addressConfig?.applecare),
  ).toBe(false);
  await page.getByRole("button", { name: "保存地址预设" }).click();
  await expect(page.locator(".task-footer")).toContainText("快捷地址已保存");
  expect(
    await page.evaluate(() => (window as any).addressConfig?.applecare),
  ).toBe(false);
});

test("delivery method card can fill the account from the general preset", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "送货方式" }).click();
  await page.getByRole("button", { name: "填入通用预设" }).click();
  const starts = await page.evaluate(() =>
    (window as any).started.filter((t: any) => t.action === "preset_apply"),
  );
  expect(starts.map((t: any) => t.accountId)).toEqual(["a"]);
  // 通用预设自己的页面上没有这个按钮（它就是来源）。
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /通用预设/ })
    .click();
  await expect(page.getByRole("button", { name: "填入通用预设" })).toHaveCount(
    0,
  );
});

test("querying pickup stores keeps the pickup tab selected", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    (window as any).addressConfig = {
      contact: {
        lastName: "周",
        firstName: "晓",
        emailAddress: "first@example.test",
        fullDaytimePhone: "18109038858",
      },
      delivery: { state: "四川", city: "成都", district: "锦江区" },
      address: { street: "测试路 8 号" },
      delivery_method: "delivery",
    };
  });
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "送货方式" }).click();
  const method = (name: string) =>
    page.locator(".delivery-method label").filter({ hasText: name });
  const isChecked = async (name: string) =>
    (await method(name).getAttribute("class"))!.includes("checked");
  // 先保存一次快递地址，制造一条带 config 的历史任务。
  await page.getByRole("button", { name: "保存地址预设" }).click();
  await expect(page.locator(".task-footer")).toContainText("快捷地址已保存");
  await method("门店自提").click();
  await expect(method("门店自提")).toHaveClass(
    /ant-radio-button-wrapper-checked/,
  );
  for (const [label, value] of [
    ["取货省 / 直辖市", "四川"],
    ["取货城市", "成都"],
    ["取货区 / 县", "锦江区"],
  ] as const) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
  // 查询附近门店的结果里没有 config，不能因此把界面切回快递配送。
  await page.getByRole("button", { name: "查询附近门店" }).click();
  await expect(
    page.getByText("查到 2 家门店（其中 1 家当前可取货）"),
  ).toBeVisible();
  // 可用性按账号下单用的 SKU 查，不能交给后端退回内置默认 SKU。
  const query = (await page.evaluate(() => (window as any).started))
    .filter((t: any) => t.action === "stores")
    .at(-1);
  expect(query.params).toEqual({
    state: "四川",
    city: "成都",
    district: "锦江区",
    sku: "MK2U4CH",
  });
  expect(await isChecked("门店自提")).toBe(true);
  expect(await isChecked("快递配送")).toBe(false);
  await expect(
    page.getByRole("heading", { name: "自提门店", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "快捷送货地址" })).toHaveCount(
    0,
  );
});

test("filling the general preset also refreshes province and city", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    (window as any).addressConfig = {
      contact: {
        lastName: "周",
        firstName: "晓",
        emailAddress: "first@example.test",
        fullDaytimePhone: "18109038858",
      },
      delivery: { state: "四川", city: "成都", district: "锦江区" },
      address: { street: "测试路 8 号" },
      delivery_method: "delivery",
    };
  });
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "送货方式" }).click();
  // antd v6 把选中项渲染在 .ant-select-content 上，用 title 判断当前值。
  const region = (label: string) =>
    page
      .locator(".select-field")
      .filter({ has: page.locator(`label:text-is("${label}")`) })
      .locator(".ant-select-content");
  await expect(region("省 / 直辖市")).toHaveAttribute("title", "四川");
  await expect(region("城市")).toHaveAttribute("title", "成都");
  await page.getByRole("button", { name: "填入通用预设" }).click();
  // 填入后省 / 市 / 区都要跟着更新（之前只刷新了地址文本）。
  await expect(region("省 / 直辖市")).toHaveAttribute("title", "上海市");
  await expect(region("城市")).toHaveAttribute("title", "上海市");
  await expect(region("区 / 县")).toHaveAttribute("title", "浦东新区");
  await expect(page.getByLabel("详细地址")).toHaveValue("通用预设路 9 号");
});

test("address fields group into rows instead of one per line", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("tab", { name: "送货方式" }).click();
  const box = async (label: string) => {
    const found = (await page
      .getByLabel(label, { exact: true })
      .boundingBox())!;
    return found;
  };
  const sameRow = (a: { y: number; height: number }, b: { y: number }) =>
    Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
  // 姓名（姓氏 + 名字）一行、邮箱 + 手机号一行。
  expect(Math.abs((await box("姓氏")).y - (await box("名字")).y)).toBeLessThan(
    4,
  );
  expect(
    Math.abs((await box("通知邮箱")).y - (await box("手机号")).y),
  ).toBeLessThan(4);
  expect((await box("通知邮箱")).y).toBeGreaterThan((await box("姓氏")).y);
  // 省 / 市 / 区一行（在正文而非下拉里比较，避免下拉框未展开时没高度）。
  const state = (await page
    .getByRole("combobox", { name: "省 / 直辖市", exact: true })
    .boundingBox())!;
  const city = (await page
    .getByRole("combobox", { name: "城市", exact: true })
    .boundingBox())!;
  const district = (await page
    .getByRole("combobox", { name: "区 / 县", exact: true })
    .boundingBox())!;
  expect(sameRow(state, city)).toBeLessThan(4);
  expect(sameRow(state, district)).toBeLessThan(4);
  // 详细地址独占一行，宽度覆盖整行。
  const street = (await page.getByLabel("详细地址").boundingBox())!;
  expect(street.y).toBeGreaterThan(state.y);
  expect(street.width).toBeGreaterThan(state.width + city.width);
});

test("pickup keeps only a region and lets the site pick the nearest store", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /日常账号 fir/ })
    .click();
  await page.getByRole("tab", { name: "送货方式" }).click();
  // 默认不加 AppleCare+；全自动下单不再有开关。
  await expect(
    page.getByRole("checkbox", { name: /AppleCare\+/ }),
  ).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /全自动下单/ })).toHaveCount(
    0,
  );
  // 默认是快递配送：只显示快捷地址，没有门店配置。
  const method = (name: string) =>
    page.locator(".delivery-method label").filter({ hasText: name });
  await expect(method("快递配送")).toHaveClass(
    /ant-radio-button-wrapper-checked/,
  );
  await expect(
    page.getByRole("heading", { name: "自提门店", exact: true }),
  ).toHaveCount(0);
  await method("门店自提").click();
  await expect(page.getByRole("heading", { name: "快捷送货地址" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "自提门店", exact: true }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "保存取货地区" });
  const query = page.getByRole("button", { name: "查询附近门店" });
  // 保存需要完整的省 → 市 → 区；查询只要省 / 市（区 / 县 可选）。
  await expect(query).toBeDisabled();
  await expect(save).toBeDisabled();
  for (const [label, value] of [
    ["取货省 / 直辖市", "四川"],
    ["取货城市", "成都"],
  ] as const) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
  await expect(query).toBeEnabled();
  await expect(save).toBeDisabled();
  await page
    .getByRole("combobox", { name: "取货区 / 县", exact: true })
    .click();
  await page.getByRole("option", { name: "锦江区", exact: true }).click();
  await expect(query).toBeEnabled();
  await expect(save).toBeEnabled();
  // 查询只是预览：不再需要用户指定门店。
  await query.click();
  await expect(
    page.getByText("查到 2 家门店（其中 1 家当前可取货）"),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "取货门店" })).toHaveCount(0);
  const queried = (await page.evaluate(() => (window as any).started))
    .filter((t: any) => t.action === "stores")
    .at(-1);
  expect(queried.params).toEqual({
    state: "四川",
    city: "成都",
    district: "锦江区",
    sku: "MK2U4CH",
  });
  await save.click();
  const starts = await page.evaluate(() => (window as any).started);
  expect(starts.at(-1).action).toBe("store_save");
  expect(starts.at(-1).params).toEqual({
    store: { state: "四川", city: "成都", district: "锦江区" },
  });
  // 只保存地区，不锁定门店。
  expect(
    await page.evaluate(() => (window as any).addressConfig?.store),
  ).toEqual({ state: "四川", city: "成都", district: "锦江区" });
});

test("public DUO route needs no account and retains clearly dated results on failure", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/#/duo");
  await expect(page.locator(".topbar")).toContainText("DUO 状态");
  await expect(page.locator(".duo-page")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await expect(
    page.getByLabel("Apple 账号", { exact: true }),
  ).not.toBeVisible();
  // 说明收进图标，悬停才展开。
  await expect(page.locator(".duo-page p")).toHaveCount(0);
  await page.getByRole("button", { name: "DUO 状态说明" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("无需登录 Apple 账号");
  // 刷新与"打开官网"在同一行。
  const refreshBox = (await page
    .getByRole("button", { name: "刷新状态" })
    .boundingBox())!;
  const openBox = (await page
    .getByRole("button", { name: "打开官网" })
    .boundingBox())!;
  expect(Math.abs(refreshBox.y - openBox.y)).toBeLessThan(4);
  await page.getByRole("button", { name: "打开官网" }).click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual([
    "https://www.apple.com.cn/shop/buy-iphone/iphone-duo",
  ]);
  expect(await page.evaluate(() => (window as any).started.length)).toBe(0);
  await page.getByRole("button", { name: "刷新状态" }).click();
  const closed = page.locator("tr").filter({ hasText: "MK2Q4CH" });
  const unknown = page.locator("tr").filter({ hasText: "MK2U4CH" });
  await expect(closed).toContainText("未开放");
  await expect(unknown).toContainText("未知");
  await expect(unknown).toContainText("许可待确认");
  expect(
    await page.evaluate(() =>
      (window as any).started.every(
        (t: any) =>
          t.action === "catalog" &&
          t.accountId === "00000000-0000-0000-0000-000000000000",
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).catalogFails = true;
  });
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(page.getByRole("alert")).toContainText("541");
  await expect(
    page.getByText("刷新失败，下方保留上次成功结果，并非本次实时状态。"),
  ).toBeVisible();
  await expect(closed).toContainText("未开放");
});

test("one order can contain several products", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  // 默认一行（通用预设），再加一行商品。
  await expect(page.locator(".item-row")).toHaveCount(1);
  await page.getByRole("button", { name: /添加商品/ }).click();
  await expect(page.locator(".item-row")).toHaveCount(2);
  await page.getByRole("combobox", { name: "预制商品 2" }).click();
  await page.getByRole("option", { name: /MK2V4CH/ }).click();
  await expect(page.getByLabel("商品 SKU 2")).toHaveValue("MK2V4CH");
  await page.getByLabel("数量 2").fill("3");
  // 两种商品的移除按钮都可用（只有一行时才会禁用）。
  await expect(
    page.getByRole("button", { name: "移除商品", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "移除商品 2" })).toBeEnabled();
  // 加到三行再删掉一行，回到两种商品。
  await page.getByRole("button", { name: /添加商品/ }).click();
  await expect(page.locator(".item-row")).toHaveCount(3);
  await page.getByRole("button", { name: "移除商品 3", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(2);
  await page.getByRole("button", { name: /立即下单（当前账号）/ }).click();
  const purchases = await page.evaluate(() =>
    (window as any).started.filter((t: any) => t.action === "purchase"),
  );
  expect(purchases.at(-1).params).toEqual({
    items: [
      { sku: "MK2U4CH", quantity: 2 },
      { sku: "MK2V4CH", quantity: 3 },
    ],
  });
  // 确认弹窗列出两件商品。
  await expect(page.locator(".task-detail")).toContainText("测试商品");
  await expect(page.locator(".task-detail")).toContainText("商品 MK2V4CH");
});

test("scheduled purchase queues one warm-up task per account", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  const at = new Date(Date.now() + 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const text = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  // 抢购时间用日期选择器；提前预热默认 5 分钟。
  await page.getByLabel("抢购时间").fill(text);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /添加商品/ }).click();
  await page.getByLabel("商品 SKU 2").fill("MJTA4CH");
  await page.getByRole("button", { name: /定时抢购（2 个账号）/ }).click();
  // 等每个账号的任务都排上（倒计时出现即代表 setSchedule 完成）。
  await expect(page.locator(".schedule-countdown")).toContainText("距抢购");
  const timed = await page.evaluate(() => (window as any).timed);
  expect(timed).toHaveLength(2);
  expect(timed[0].params.items).toEqual([
    { sku: "MK2U4CH", quantity: 2 },
    { sku: "MJTA4CH", quantity: 1 },
  ]);
  expect(timed[0].params.warmup).toBe(300);
  // at 是"本机 epoch 秒"，已按网络校时偏移换算——容差要覆盖本机时钟偏差。
  expect(Math.abs(timed[0].params.at * 1000 - at.getTime())).toBeLessThan(6000);
  await expect(page.locator(".schedule-countdown")).toContainText("后开始预热");
  // 定时抢购后也自动进入付款码页：回到批量下单页看各账号的预热任务。
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  await expect(page.locator(".schedule-accounts li")).toHaveCount(2);
  await expect(page.locator(".schedule-accounts")).toContainText(
    "预热倒计时：还有 59 分 00 秒。",
  );
  // 取消会终止各账号的等待任务，并清掉本机记住的计划。
  await page.getByRole("button", { name: "取消定时抢购" }).click();
  await expect(page.locator(".schedule-countdown")).toHaveCount(0);
  await expect(page.getByText(/已安排：/)).toHaveCount(0);
  const cancelled = await page.evaluate(() =>
    window.__DUO_KILLER_TEST__
      .snapshot()
      .then((s: any) =>
        s.tasks
          .filter((t: any) => t.action === "timed_purchase")
          .map((t: any) => t.status),
      ),
  );
  expect(cancelled).toEqual(["cancelled", "cancelled"]);
  await page.reload();
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  await expect(page.getByText(/已安排：/)).toHaveCount(0);
});

test("purchase preset stores several products and seeds the order form", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page.getByRole("tab", { name: "购买预设" }).click();
  await page.getByRole("button", { name: /添加商品/ }).click();
  await page.getByLabel("商品 SKU 2").fill("MLH74FE");
  await page.getByLabel("数量 2").fill("4");
  await page.getByRole("button", { name: "保存购买预设", exact: true }).click();
  await expect(page.getByText(/购买预设已保存/)).toBeVisible();
  const presets = await page.evaluate(() =>
    (window as any).__DUO_KILLER_TEST__
      .snapshot()
      .then((s: any) => s.defaults.preset_items),
  );
  expect(presets).toEqual([
    { sku: "MK2U4CH", quantity: 2 },
    { sku: "MLH74FE", quantity: 4 },
  ]);
  // 批量下单表单以这份多商品预设为默认值。
  await page.getByRole("tab", { name: "批量下单", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(2);
  await expect(page.getByLabel("商品 SKU 2")).toHaveValue("MLH74FE");
  await expect(page.getByLabel("数量 2")).toHaveValue("4");
});

test("preset products fill purchase fields without submitting an order", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("combobox", { name: "预制商品" }).click();
  await page.getByRole("option", { name: /MK2V4CH/ }).click();
  await expect(page.getByLabel("商品 SKU")).toHaveValue("MK2V4CH");
  await page.getByRole("combobox", { name: "预制商品" }).click();
  await page.getByRole("option", { name: /抛光布/ }).click();
  await expect(page.getByLabel("商品 SKU")).toHaveValue("MLH74FE");
  const purchase = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "批量下单（所有启用账号）",
      exact: true,
    }),
  });
  // 批量下单页签里：默认一行商品 + 当前账号下单 + 多账号并发。
  await expect(purchase.locator(".item-row")).toHaveCount(1);
  await expect(
    purchase.getByRole("button", { name: /立即下单（当前账号）/ }),
  ).toBeVisible();
  await expect(
    purchase.getByRole("button", { name: /并发下单（2 个账号）/ }),
  ).toBeVisible();
  await expect(page.getByText("任务记录", { exact: true })).toHaveCount(0);
  await expect(page.getByText("查看过程记录", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).started.some(
        (t: any) => t.action === "purchase" || t.action === "add",
      ),
    ),
  ).toBe(false);
  await page.getByRole("link", { name: "DUO 状态", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await expect(
    page.getByRole("cell", { name: "抛光布", exact: true }),
  ).toHaveCount(0);
});

test("me refresh updates the nickname in the sidebar and configuration selector", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.getByLabel("备注名称")).toHaveCount(0);
  await enterWorkspace(page);
  await page.evaluate(() => {
    (window as any).meName = "最新昵称";
  });
  await page.getByRole("button", { name: "检查登录", exact: true }).click();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: /最新昵称 fir\*\*@example.test/ }),
  ).toBeVisible();
  await page.locator(".sidebar .account").first().click();
  await expect(page.locator(".topbar-account")).toContainText("最新昵称");
  await page.evaluate(() => {
    (window as any).meName = "";
  });
  await page.getByRole("button", { name: "检查登录", exact: true }).click();
  await expect(page.locator(".sidebar strong").first()).toHaveText(
    "fir**@example.test",
  );
});

test("startup check drops invalidated accounts and returns to the add form", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  for (const accountId of ["a", "b"]) {
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as any).started.some((t: any) => t.accountId === id),
          accountId,
        ),
      )
      .toBe(true);
    await page.evaluate((id) => {
      const root = window as any;
      const task = root.started.find((t: any) => t.accountId === id);
      root.finish(task.id, {
        status: "failed",
        prompt: null,
        stage: "当前用户已失效，请重新登录。账号已移除，可自行重新添加。",
        result: { account_removed: true },
      });
    }, accountId);
  }
  await expect(page.getByRole("alert")).toContainText("当前用户已失效");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Apple 账号" })).toBeVisible();
});

test("expired active account stays on the current route while other accounts remain usable", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("link", { name: "DUO 状态", exact: true }).click();
  await page.evaluate(() => {
    const root = window as any;
    const task = root.started.find((t: any) => t.accountId === "a");
    root.finish(task.id, {
      status: "failed",
      prompt: null,
      stage: "当前用户已失效，请重新登录。账号已移除。",
      result: { account_removed: true },
    });
  });
  await expect(page).toHaveURL(/#\/duo$/);
  await expect(page.getByRole("alert")).toContainText("账号已移除");
  await expect(
    page.locator(".sidebar").getByRole("button", { name: /日常账号/ }),
  ).toHaveCount(0);
  await expect(
    page.locator(".sidebar").getByRole("button", { name: /备用账号/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Apple 账号", { exact: true })).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /备用账号/ })
    .click();
  await expect(
    page.getByRole("button", { name: "检查登录", exact: true }),
  ).toBeVisible();
});

test("account identity is masked by default and reveals only until account switch or reload", async ({
  page,
}) => {
  await fixture(page, true, "sample17@example.test");
  await page.goto("/");
  await enterWorkspace(page);
  const identity = page.locator(".account-identity");
  await expect(identity).toContainText("sampl**@example.test");
  await expect(page.locator("body")).not.toContainText("sample17@example.test");
  await expect(page.locator(".sidebar .account").first()).toHaveAttribute(
    "title",
    "日常账号（sampl**@example.test）",
  );
  const reveal = page.getByRole("button", {
    name: "显示完整账号",
    exact: true,
  });
  await reveal.focus();
  await reveal.press("Enter");
  await expect(identity).toContainText("sample17@example.test");
  await expect(
    page.getByRole("button", { name: "隐藏完整账号" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "隐藏完整账号" }).click();
  await expect(identity).toContainText("sampl**@example.test");
  await page.getByRole("button", { name: "显示完整账号", exact: true }).click();
  await page.locator(".sidebar .account").nth(1).click();
  await expect(identity).toContainText("seco**@example.test");
  await expect(
    page.getByRole("button", { name: "显示完整账号", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".sidebar .account").first()).toHaveAttribute(
    "title",
    "日常账号（sampl**@example.test）",
  );
  const state = await page.evaluate(() =>
    (window as any).__DUO_KILLER_TEST__.snapshot(),
  );
  expect(state.accounts[0].email).toBe("sample17@example.test");
});

test("cancel remains at the operation's top right for prompts and running states on narrow screens", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const panel = page.getByRole("region", { name: "当前任务" });
  const bar = page.locator(".task-footer-bar");
  const cancel = panel.getByRole("button", { name: "取消", exact: true });
  for (const phase of ["waiting", "running"]) {
    await expect(cancel).toBeVisible();
    // 需要操作时取消按钮在提示表单里；纯执行中时就在底部提示条同一行靠右。
    if (phase === "running") {
      const box = (await bar.boundingBox())!;
      const button = (await cancel.boundingBox())!;
      expect(
        Math.abs(button.y + button.height / 2 - (box.y + box.height / 2)),
      ).toBeLessThanOrEqual(24);
      expect(box.x + box.width - button.x - button.width).toBeLessThanOrEqual(
        40,
      );
    }
    if (phase === "waiting")
      await page.evaluate(() => {
        const root = window as any;
        const login = root.started.find((t: any) => t.action === "login");
        root.finish(login.id, { status: "running", prompt: null });
      });
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/ui-cancel-mobile.png",
    fullPage: true,
  });
  await cancel.click();
  await expect(panel.getByText("已取消", { exact: true })).toBeVisible();
  await expect(cancel).toHaveCount(0);
});

test("interaction feedback respects reduced motion", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  const toggle = page.getByRole("button", {
    name: "显示完整账号",
    exact: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".task-detail")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator(".task-detail")).toHaveCSS("opacity", "1");
  await toggle.click();
  await expect(page.locator(".account-identity")).toContainText(
    "first@example.test",
  );
});

test("shared dropdown supports keyboard, dismissal and narrow viewport placement", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await expect(page).toHaveTitle("DUO Killer");
  const select = page.getByRole("combobox", { name: "预制商品" });
  await select.focus();
  await select.press("ArrowDown");
  await expect(select).toHaveAttribute("aria-expanded", "true");
  await select.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(select).toBeFocused();
  await select.fill("MLH74FE");
  await page.getByRole("option", { name: /抛光布/ }).click();
  await expect(page.getByLabel("商品 SKU")).toHaveValue("MLH74FE");
  await select.click();
  await expect(page.getByRole("option", { name: /抛光布/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await select.press("Tab");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 620 });
  await select.click();
  const box = (await page.getByRole("listbox").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  expect(box.y + box.height).toBeLessThanOrEqual(612);
  await page.screenshot({
    path: "artifacts/ui-dropdown-mobile.png",
    animations: "disabled",
  });
  await page.locator(".topbar").click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const colors = await page.evaluate(() =>
    [".app-shell", ".sidebar"].map(
      (selector) =>
        getComputedStyle(document.querySelector(selector)!).backgroundColor,
    ),
  );
  expect(colors[0]).toBe(colors[1]);
});

test("task navigation returns to one task from another page and hides when done", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  const trigger = page.getByRole("button", {
    name: "1 个任务进行中",
    exact: true,
  });
  await expect(trigger).toHaveCount(0);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(trigger).toBeVisible();
  await expect(page.locator(".sidebar-footer")).toContainText("网络时间");
  await page.getByRole("button", { name: /备用账号 seco/ }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /日常账号 fir/ })
    .click();
  await trigger.click();
  await expect(page).toHaveURL(/#\/account$/);
  await expect(page.locator(".task-detail")).toBeFocused();
  await expect(page.locator(".task-account")).toHaveText("fir**@example.test");
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(trigger).toHaveCount(0);
  expect(
    (await page.evaluate(() => (window as any).started)).filter(
      (t: any) => t.action === "login",
    ),
  ).toHaveLength(1);
});

test("task navigation selects among accounts with masked labels and keyboard dismissal", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /备用账号 seco/ }).click();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const trigger = page.getByRole("button", {
    name: "2 个任务进行中",
    exact: true,
  });
  const list = page.getByRole("list", { name: "进行中的任务" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  await expect(list).toContainText("fir**@example.test");
  await expect(list).not.toContainText("first@example.test");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 760 });
  await trigger.click();
  await expect(list).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/task-navigation-mobile.png",
    animations: "disabled",
  });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(page.locator(".task-detail")).toBeFocused();
  await expect(page.locator(".task-account")).toHaveText("fir**@example.test");
  await expect(trigger).toBeInViewport();
  await trigger.click();
  await list.getByRole("button", { name: /备用账号/ }).click();
  await expect(page.locator(".task-account")).toHaveText("seco**@example.test");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "1 个任务进行中", exact: true }),
  ).toBeVisible();
});

test("task navigation preserves account setup while visiting another active task", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page
    .getByLabel("Apple 账号", { exact: true })
    .fill("third@example.test");
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "2 个任务进行中",
    exact: true,
  });
  const list = page.getByRole("list", { name: "进行中的任务" });
  await trigger.click();
  await list.getByRole("button", { name: /日常账号/ }).click();
  await expect(page.locator(".task-detail")).toBeFocused();
  await trigger.click();
  await list.getByRole("button", { name: /添加并登录账号/ }).click();
  await expect(page.locator(".setup-progress")).toBeFocused();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  const starts = await page.evaluate(() => (window as any).started);
  expect(starts.filter((t: any) => t.action === "enroll")).toHaveLength(1);
  expect(starts.filter((t: any) => t.action === "login")).toHaveLength(1);
});

test("task navigation returns public tasks to their own page", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/duo");
  // 等启动自动检查跑完，避免与"1 个任务进行中"计数互相干扰
  await expect(page.locator(".active-task-trigger")).toHaveCount(0);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page.evaluate(() => {
    const root = window as any;
    root.finish(root.started.at(-1).id, { status: "running", result: null });
  });
  await page.getByRole("link", { name: "账号工作台", exact: true }).click();
  await page
    .getByRole("button", { name: "1 个任务进行中", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/duo$/);
  await expect(page.locator(".task-detail")).toBeFocused();
  // 只有 catalog 是本测试自己发起的（另有启动自动检查的 me）。
  expect(
    (await page.evaluate(() => (window as any).started)).filter(
      (t: any) => t.action === "catalog",
    ),
  ).toHaveLength(1);
});

test("removing an account requires confirmation and keeps the others", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移除本地账号" });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("first@example.test");
  await expect(dialog.getByRole("button", { name: "保留账号" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).removed)).toEqual([]);
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(
    page.getByRole("navigation", { name: "切换账号" }),
  ).not.toContainText("日常账号");
  await expect(page.locator(".topbar-account")).toContainText("备用账号");
  expect(await page.evaluate(() => (window as any).removed)).toEqual(["a"]);
});

test("removal failure keeps the account; removing the last one returns to the add form", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.evaluate(() => {
    (window as any).removeError = "无法清除系统保存的密码";
  });
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "无法清除系统保存的密码",
  );
  expect(await page.evaluate(() => (window as any).removed)).toEqual([]);
  await page.evaluate(() => {
    (window as any).removeError = "";
  });
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("navigation", { name: "切换账号" })
    .getByRole("button", { name: /备用账号 seco/ })
    .click();
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(page.getByRole("textbox", { name: "Apple 账号" })).toBeVisible();
});

test("workspace removal is blocked during tasks and switches to remaining account", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移除账号", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认移除" })
    .click();
  // 账号信息现在显示在顶栏，而不是内容区。
  await expect(page.locator(".topbar-account")).toContainText("备用账号");
  await expect(page.locator(".page-heading")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "切换账号" }),
  ).not.toContainText("日常账号");
  expect(await page.evaluate(() => (window as any).removed)).toEqual(["a"]);
  await page.getByRole("button", { name: "移除账号", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认移除" })
    .click();
  await expect(page.getByRole("textbox", { name: "Apple 账号" })).toBeVisible();
});

test("unfinished enrollment can be removed after cancelling login", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Apple 账号" })
    .fill("draft@example.test");
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /移除 draft|移除 dra/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认移除" })
    .click();
  await expect(page.getByRole("heading", { name: "未完成添加" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("textbox", { name: "Apple 账号" })).toBeVisible();
});

test("payment board shows one card per account and keeps the footer text only", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.evaluate(() => {
    (window as any).started.length = 0;
  });
  await page.getByRole("button", { name: /并发下单（2 个账号）/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "开始下单" })
    .click();
  // 并发下单后自动进入「付款码」页。
  await expect(page.locator(".pay-view")).toBeVisible();
  await expect(page).toHaveURL(/#\/pay$/);
  const cards = page.locator(".pay-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "日常账号" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "备用账号" })).toHaveCount(1);
  // 下单任务等待二次确认，卡片显示进度，底部提示条显示同一个任务。
  await expect(cards.first()).toContainText("需要操作");
  // 提示条会写明是哪个账号需要操作。
  await expect(page.locator(".task-footer-account")).toBeVisible();
  await expect(page.locator(".page-footer")).toContainText("购买商品");
});

test("payment board lists the QR for every account that finished ordering", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await enterBatch(page);
  await page.getByRole("button", { name: /并发下单（2 个账号）/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "开始下单" })
    .click();
  await expect(page.locator(".pay-view")).toBeVisible();
  // 二次确认在底部提示条里逐个账号回答（提示条会写明是哪个账号）。
  await expect(page.locator(".task-footer-account")).toContainText("fir");
  await page.getByRole("button", { name: "确认创建订单", exact: true }).click();
  await expect(page.locator(".task-footer-account")).toContainText("seco");
  await page.getByRole("button", { name: "确认创建订单", exact: true }).click();
  await expect(page.locator(".task-footer-account")).toHaveCount(0);
  // 两个账号的卡片各自显示订单号与付款二维码。
  for (const name of ["日常账号", "备用账号"]) {
    const card = page.locator(".pay-card").filter({ hasText: name });
    await expect(card).toContainText("待付款");
    await expect(card).toContainText("订单 TEST001");
    await expect(card.locator("img.pay-qr")).toBeVisible();
  }
  await expect(page.locator(".pay-view")).toContainText("有 2 个账号等待付款");
  // 侧边栏角标显示待付款账号数。
  await expect(page.locator(".route-nav .route-count")).toHaveText("2");
  // 重新获取二维码会为对应账号启动 qr 任务。
  await page.evaluate(() => {
    (window as any).started.length = 0;
  });
  await page
    .locator(".pay-card")
    .filter({ hasText: "备用账号" })
    .getByRole("button", { name: "换一张" })
    .click();
  // 付款后查过订单（官网不再显示等待付款）就不再算待付款。
  await page.evaluate(() => {
    (window as any).paidOrders = true;
  });
  await page
    .locator(".pay-card")
    .filter({ hasText: "日常账号" })
    .getByRole("button", { name: "我已支付，查询订单" })
    .click();
  await page.getByRole("link", { name: "付款码", exact: true }).click();
  await expect(
    page.locator(".pay-card").filter({ hasText: "日常账号" }),
  ).toContainText("已查订单");
  await expect(page.locator(".route-nav .route-count")).toHaveText("1");
  const restarted = await page.evaluate(() =>
    (window as any).started.filter((t: any) => t.action === "qr"),
  );
  expect(restarted).toHaveLength(1);
  expect(restarted[0].accountId).toBe("b");
  expect(restarted[0].params.source_task).toBeTruthy();
});
