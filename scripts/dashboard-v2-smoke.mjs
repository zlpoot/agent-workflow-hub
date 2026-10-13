import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { dashboardHeaders } from "../dist/dashboard/gateway.js";
const output = ".handoff/dashboard-v2-smoke";
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["scripts/dashboard-v2-preview.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture host timeout")),
      15000,
    );
    child.once("exit", () => reject(new Error("Fixture host stopped")));
    child.stdout.on("data", (data) => {
      const match = String(data).match(
        /http:\/\/127\.0\.0\.1:\d+\/dashboard\/v2/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
  });
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.AWH_DASHBOARD_TEST_BROWSER ??
      (existsSync(edge) ? edge : undefined),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    reducedMotion: "reduce",
  });
  const errors = [],
    requests = [],
    violations = [];
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__csp.push(event.violatedDirective),
    );
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(url).origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  context.on("request", (request) =>
    requests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      authenticated: !!request.headers().authorization,
    }),
  );
  const response = await page.goto(url);
  assert.equal(
    response.headers()["content-security-policy"],
    dashboardHeaders["Content-Security-Policy"],
  );
  await page.getByRole("heading", { name: "下一步，从这里开始" }).waitFor();
  await page.getByText("已连接", { exact: true }).waitFor();
  assert(
    await page.getByRole("note").getByText("示例预览 · 模拟数据").isVisible(),
  );
  const snapshot = await (
    await context.request.get(new URL("/dashboard/v1/snapshot", url).href)
  ).json();
  assert(snapshot.tasks.every((t) => t.fixture));
  await page
    .getByRole("combobox", { name: "GitHub 自动刷新", exact: true })
    .selectOption("0");
  await page.getByRole("button", { name: "刷新 GitHub", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  await page.screenshot({
    path: output + "/desktop-overview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^任务/ }).click();
  await page
    .getByRole("heading", { name: "任务工作台", exact: true })
    .waitFor();
  await page.screenshot({
    path: output + "/desktop-tasks.png",
    fullPage: true,
  });
  const search = page.getByRole("textbox", { name: "搜索任务" });
  await search.fill("does-not-exist");
  await page.getByRole("heading", { name: "没有匹配的任务" }).waitFor();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page
    .getByRole("combobox", { name: "阶段", exact: true })
    .selectOption("awaiting_review");
  assert.equal(await page.locator(".desktop-table tbody tr").count(), 1);
  await page
    .getByRole("combobox", { name: "阶段", exact: true })
    .selectOption("all");
  await page
    .getByRole("combobox", { name: "机器", exact: true })
    .selectOption("fixture-mac");
  assert((await page.locator(".desktop-table tbody tr").count()) > 0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page
    .getByRole("combobox", { name: "项目", exact: true })
    .selectOption("project-beta");
  assert((await page.locator(".desktop-table tbody tr").count()) > 0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  const trigger = page
    .locator(".desktop-table")
    .getByRole("button", { name: /#3 模拟/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor();
  await page.getByRole("heading", { name: "证据与 HEAD" }).waitFor();
  await page.getByText("正在重新核验任务…").waitFor({ state: "hidden" });
  assert(
    await page
      .getByRole("dialog")
      .getByText("等待独立 Review", { exact: true })
      .isVisible(),
  );
  await page.screenshot({ path: output + "/desktop-detail.png" });
  // Radix focus trap and return-to-trigger behavior, under the unchanged CSP.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page.evaluate(
        () => !!document.activeElement.closest('[role="dialog"]'),
      ),
    );
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert(await trigger.evaluate((el) => el === document.activeElement));
  const links = await page
    .locator('a[target="_blank"]')
    .evaluateAll((elements) =>
      elements.map((el) => ({ href: el.href, rel: el.rel })),
    );
  assert(
    links.every(
      (link) =>
        link.href.startsWith("https://github.com/example-org/") &&
        link.rel.includes("noopener") &&
        link.rel.includes("noreferrer"),
    ),
  );
  await context.setOffline(true);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page
      .locator(".desktop-table")
      .getByText("正在开发", { exact: true })
      .count(),
    0,
  );
  await page.screenshot({ path: output + "/outdated.png", fullPage: true });
  await context.setOffline(false);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^总览/ }).click();
  await page.screenshot({ path: output + "/mobile-overview.png" });
  await page.getByRole("button", { name: /^任务/ }).click();
  await page.screenshot({ path: output + "/mobile-tasks.png" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .locator(".mobile-tasks")
    .getByRole("button", { name: /#3 模拟/ })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("正在重新核验任务…").waitFor({ state: "hidden" });
  await page.screenshot({ path: output + "/mobile-detail.png" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  // Detail failure downgrades a retained list snapshot instead of showing current facts.
  await page.route("**/dashboard/v1/tasks/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page
    .locator(".mobile-tasks")
    .getByRole("button", { name: /#3 模拟/ })
    .click();
  await page.getByRole("alert").waitFor();
  assert(
    await page
      .getByRole("dialog")
      .getByText("状态未知", { exact: true })
      .isVisible(),
  );
  await page.keyboard.press("Escape");
  violations.push(...(await page.evaluate(() => window.__csp)));
  await context.setOffline(true);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").waitFor();
  violations.push(...(await page.evaluate(() => window.__csp)));
  // Initial error and loading states use isolated pages and mocked read responses only.
  const denied = await context.newPage();
  await context.setOffline(false);
  await denied.route("**/dashboard/v1/**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await denied.goto(url);
  await denied.getByRole("heading", { name: "面板暂不可用" }).waitFor();
  const empty = await context.newPage();
  await empty.route("**/dashboard/v1/snapshot*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...snapshot, tasks: [] }),
    }),
  );
  await empty.goto(url);
  await empty.getByRole("button", { name: /^任务/ }).click();
  await empty.getByRole("heading", { name: "没有匹配的任务" }).waitFor();
  const loading = await context.newPage();
  let releaseSnapshot;
  const gate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  await loading.route("**/dashboard/v1/snapshot*", async (route) => {
    await gate;
    await route.continue();
  });
  await loading.goto(url);
  await loading.getByRole("heading", { name: "正在加载活动记录…" }).waitFor();
  releaseSnapshot();
  await loading.getByRole("heading", { name: "下一步，从这里开始" }).waitFor();
  const offline = await context.newPage();
  await offline.route("**/dashboard/v1/events/stream*", (route) =>
    route.abort("failed"),
  );
  await offline.goto(url);
  await offline.getByText("离线", { exact: true }).waitFor();
  const timeline = await (
    await context.request.get(
      new URL(
        "/dashboard/v1/runs/" +
          encodeURIComponent(snapshot.runs[0].id) +
          "/timeline?after=0&limit=100",
        url,
      ).href,
    )
  ).json();
  const event = { ...timeline.items[0], cursor: snapshot.cursor + 1 };
  const partial = await context.newPage();
  // Test-only EventSource double emits a real validated DTO; no source/UI phase override.
  await partial.addInitScript((event) => {
    window.EventSource = class {
      readyState = 1;
      listeners = new Map();
      timers = [];
      constructor() {
        this.timers.push(
          setTimeout(() => this.listeners.get("open")?.({}), 30),
        );
        this.timers.push(
          setTimeout(
            () =>
              this.listeners.get("timeline-event")?.({
                data: JSON.stringify(event),
                lastEventId: String(event.cursor),
              }),
            100,
          ),
        );
      }
      addEventListener(name, fn) {
        this.listeners.set(name, fn);
      }
      close() {
        this.readyState = 2;
        this.timers.forEach(clearTimeout);
      }
    };
  }, event);
  await partial.goto(url);
  await partial.getByText("部分数据 · 同步中", { exact: true }).waitFor();
  for (const checkPage of [denied, empty, loading, offline, partial])
    violations.push(...(await checkPage.evaluate(() => window.__csp)));
  assert.deepEqual(
    await page.evaluate(() => ({
      cookie: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
    })),
    { cookie: "", local: 0, session: 0 },
  );
  assert(
    (await context.cookies()).every(
      (c) => c.httpOnly && c.sameSite === "Strict" && c.path === "/dashboard",
    ),
  );
  assert(
    requests.every(
      (r) => r.method === "GET" && !r.authenticated && !/^\/v1\//.test(r.path),
    ),
  );
  assert.equal(violations.length, 0, violations.join("\n"));
  // Expected network errors from injected offline/503 cases are retained separately.
  const unexpected = errors.filter(
    (e) =>
      !e.includes("net::ERR_INTERNET_DISCONNECTED") &&
      !e.includes("503") &&
      !e.includes("401"),
  );
  assert.equal(unexpected.length, 0, unexpected.join("\n"));
  assert(
    !readFileSync("dist/dashboard-v2/app.css", "utf8").includes("@import"),
  );
  const evidence = {
    browser: await browser.version(),
    dataset: "shared baseline taskFixtures; synthetic only",
    authority_verified: false,
    csp: dashboardHeaders["Content-Security-Policy"],
    csp_violations: violations,
    browser_errors: unexpected,
    expected_injected_errors: errors,
    requests: requests.length,
    checks: [
      "desktop + 390px Overview / Tasks / Drawer",
      "project / stage / machine filters + GitHub interval / manual refresh",
      "search empty + clear",
      "keyboard Enter / Tab trap / Escape / focus restore",
      "safe GitHub links",
      "detail failure downgrades facts",
      "offline refresh / outdated / reconnect",
      "initial 401 + empty snapshot + delayed loading + failed SSE offline",
      "partial validated DTO via test EventSource double",
      "HttpOnly cookie + no browser storage",
      "same-origin GET REST/SSE",
      "static CSS under unchanged Gateway CSP",
    ],
  };
  writeFileSync(
    output + "/evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  child.kill();
}
