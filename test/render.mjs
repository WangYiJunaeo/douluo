// 端到端渲染测试：用迷你 DOM 真正执行 app.js 的完整流程
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "./minidom.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "..", "public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const bodyHtml = indexHtml.slice(indexHtml.indexOf("<body>") + 6, indexHtml.indexOf("</body>"));

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "  → " + (extra || "")));
  if (!cond) fails++;
};

const { doc } = createDocument(bodyHtml);
const mem = new Map();

const REPLY = `雨点砸在铁砧上，溅起一线白气。

「小三，把那块料递过来。」男人没有回头，酒气从背后飘过来。

唐三把铁料推过去，手很稳。他比你矮半个头，眼神却不像六岁。

[状态栏]
年龄：6岁
魂力：10级
武魂：蓝银草
魂环：无
当前时间：第1年1月
当前章节目标：弄清武魂是什么
状态：存活
关系变化：唐三好感+3

选项1: 把铁料递过去，顺便问一句「爹，武魂是什么」
选项2: 假装没听见，蹲下看地上的铁屑
选项3: 转身跑去找老杰克`;

let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls++;
  const enc = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(REPLY.slice(0, 40)) + "}}]}\n\n",
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(REPLY.slice(40)) + "}}]}\n\n",
    "data: [DONE]\n\n",
  ];
  let i = 0;
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) },
  };
};

global.document = doc;
global.window = { addEventListener() {}, scrollTo() {} };
global.location = { reload() {} };
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
global.TextDecoder = TextDecoder;
global.AbortController = AbortController;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---- 按浏览器顺序加载脚本 ----
new Function(fs.readFileSync(path.join(pub, "data", "game.data.js"), "utf8"))();
new Function(fs.readFileSync(path.join(pub, "app.js"), "utf8"))();
await tick();

const app = doc.getElementById("app");
const has = (s) => (app.innerHTML + "").includes(s);
const bodyHas = (s) => doc.body.textContent.includes(s);

ok("未出现错误兜底页", !bodyHas("界面出错了"), doc.body.textContent.slice(0, 200));
ok("首屏是 Key 配置页", has("API Key") && has("保存并继续"), app.innerHTML.slice(0, 160));
ok("首屏有主题切换", has("赤金") && has("墨") && has("夜"));
ok("首屏有版本号", /build v\d+/.test(app.textContent), app.textContent.slice(-80));

// ---- 填 Key → 进入角色创建 ----
doc.getElementById("key").value = "sk-test-123";
doc.getElementById("go").click();
await tick();

ok("进入武魂觉醒页", has("武魂觉醒") && has("开始这一世"), app.innerHTML.slice(0, 200));
ok("时代列表已渲染", doc.querySelectorAll("[data-era]").length >= 5, "eras=" + doc.querySelectorAll("[data-era]").length);
ok("出身列表已渲染", doc.querySelectorAll("[data-bg]").length >= 3, "bgs=" + doc.querySelectorAll("[data-bg]").length);
ok("武魂已随机产生", /武魂/.test(app.textContent));

// ---- 起名 → 开始游戏 ----
doc.getElementById("name").value = "阿尘";
doc.getElementById("start").click();
await tick(120);

ok("进入游戏主界面", !!doc.getElementById("story") && !!doc.getElementById("choices"), app.innerHTML.slice(0, 200));
ok("顶栏显示角色名", (doc.getElementById("chTime") || {}).textContent?.includes("阿尘"), (doc.getElementById("chTime") || {}).textContent);
ok("请求已发出", fetchCalls === 1, "calls=" + fetchCalls);
ok("剧情已渲染", (doc.getElementById("story") || {}).textContent?.includes("雨点砸在铁砧上"), (doc.getElementById("story") || {}).textContent?.slice(0, 80));
ok("状态栏未泄漏进正文", !(doc.getElementById("story") || {}).textContent?.includes("状态栏"));
ok("生成 3 个选项", doc.querySelectorAll("[data-i]").length === 3, "n=" + doc.querySelectorAll("[data-i]").length);
ok("魂力已解析为 10", doc.body.textContent.includes("10 级"), "");
ok("关系已记录", doc.body.textContent.includes("唐三"));

// ---- 点选项 → 第二轮 ----
const opt = doc.querySelectorAll("[data-i]")[0];
opt.click();
await tick(120);
ok("第二轮请求已发出", fetchCalls === 2, "calls=" + fetchCalls);
ok("玩家选择已上屏", (doc.getElementById("story") || {}).textContent?.includes("把铁料递过去"), "");

// ---- 存档落地 ----
ok("存档已写入 localStorage", mem.has("dl_save_v1"), [...mem.keys()].join(","));
const snap = JSON.parse(mem.get("dl_save_v1"));
ok("存档含角色", snap.char && snap.char.name === "阿尘", JSON.stringify(snap.char && snap.char.name));
ok("存档含消息", Array.isArray(snap.entries) && snap.entries.length >= 3, "entries=" + (snap.entries || []).length);

// ---- 菜单 → 重新配置 Key → 返回 ----
doc.getElementById("btnSave").click();
await tick();
ok("菜单里有「重新填写 API Key」", !!doc.getElementById("rekey"));
doc.getElementById("rekey").click();
await tick();
ok("能回到 Key 配置页", !!doc.getElementById("key"), app.innerHTML.slice(0, 120));
ok("配置页有「返回游戏」", !!doc.getElementById("back2"));
doc.getElementById("back2").click();
await tick();
ok("能从配置页返回游戏", !!doc.getElementById("story"));

console.log(fails ? `\nFAIL (${fails})` : "\nPASS");
process.exit(fails ? 1 : 0);
