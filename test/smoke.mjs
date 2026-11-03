// 无浏览器冒烟测试：解析器 + 状态合并 + 流式解析 + 提示词拼装
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) fails++;
}

/* ---------- 最小 DOM 桩：只要不真的渲染 ---------- */
const listeners = {};
const el = () => ({
  innerHTML: "", textContent: "", style: {}, dataset: {},
  appendChild() {}, remove() {}, querySelector: () => el(), querySelectorAll: () => [],
  addEventListener() {}, classList: { add() {}, remove() {} }, select() {},
});
global.document = {
  readyState: "loading",
  addEventListener: (t, fn) => { listeners[t] = fn; },   // 故意不触发，让 boot 不跑
  querySelector: () => el(),
  querySelectorAll: () => [],
  createElement: () => el(),
  body: el(),
};
const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
global.window = {};

// 加载数据与脚本（按浏览器里的顺序）
const dataSrc = fs.readFileSync(path.join(pub, "data", "game.data.js"), "utf8");
new Function(dataSrc)();
const appSrc = fs.readFileSync(path.join(pub, "app.js"), "utf8");
new Function(appSrc)();
const T = global.window.__DL_TEST__;

/* ---------- 1. 状态栏 + 选项解析 ---------- */
const SAMPLE = `雨点砸在铁砧上，溅起一线白气。

「小三，把那块料递过来。」男人没有回头，酒气从背后飘过来。

唐三把铁料推过去，手很稳。他比你矮半个头，眼神却不像六岁。

[状态栏]
年龄：6岁
魂力：10级
武魂：蓝银草
魂环：无
当前时间：第1年1月
当前章节目标：弄明白武魂是什么
状态：存活
关系变化：唐昊好感+2，唐三好感+3

选项1: 把铁料递过去，顺便问一句「爹，武魂是什么」
选项2: 假装没听见，蹲下看地上的铁屑
选项3: 转身跑去找老杰克，问村里谁觉醒过武魂`;

const p = T.parseReply(SAMPLE);
ok("正文剔除了状态栏", !p.body.includes("状态栏"), p.body.slice(-60));
ok("正文剔除了选项行", !/选项\s*1/.test(p.body));
ok("保留正文内容", p.body.includes("雨点砸在铁砧上"));
ok("状态字段全部解析", p.status && Object.keys(p.status).length >= 7, JSON.stringify(p.status));
ok("魂力=10级", p.status["魂力"] === "10级", p.status["魂力"]);
ok("选项 3 条", p.options.length === 3, p.options.length);

// 半角冒号 / 空格 / 无「状态」字样
const TOL = `正文。
[状态栏]
年龄: 7岁
魂力 : 12级
武魂: 兰花
魂环：白
状态：存活
选项1: 走
选项2: 留`;
const p2 = T.parseReply(TOL);
ok("半角冒号也能解析", p2.status && p2.status["魂力"] === "12级", JSON.stringify(p2.status));
ok("无选项1时选项为空也不崩", Array.isArray(p2.options));

// 完全没有状态栏时不崩
const p3 = T.parseReply("只有一段剧情，没有格式。");
ok("无状态栏不抛异常", p3.status === null && p3.body.length > 0);

/* ---------- 2. 关系变化 ---------- */
const rel = T.parseRelation("唐昊好感+2，唐三好感-3，小舞 +1");
ok("关系解析出 3 条", rel.length === 3, JSON.stringify(rel));
ok("负值正确", rel.some((r) => r.name === "唐三" && r.delta === -3));

/* ---------- 3. 状态合并 ---------- */
T.setChar({ name: "阿尘", sex: "male", age: 6, era: "douluo1", soul: { name: "白狐", type: "兽武魂" }, power: 7, origin: "孤儿", rings: [], dead: false });
T.applyStatus(p.status);
const st = T.state;
ok("魂力写回角色", st.char.power === 10, st.char.power);
ok("年龄写回角色", st.char.age === 6, st.char.age);
ok("关系写入 NPC 表", st.npcs["唐三"] && st.npcs["唐三"].fav === 3, JSON.stringify(st.npcs));

T.applyStatus({ 魂环: "白黄紫", 年龄: "9岁" });
ok("魂环颜色解析", JSON.stringify(st.char.rings) === '["白","黄","紫"]', JSON.stringify(st.char.rings));

T.applyStatus({ 状态: "死亡" });
ok("死亡状态被识别", st.char.dead === true);

/* ---------- 4. 提示词拼装 ---------- */
const sys = T.buildSystem();
ok("提示词包含原著规则", sys.includes("原著守护规则"), sys.length);
ok("提示词注入玩家状态", sys.includes("阿尘"));
ok("提示词含魂环等级提醒", /距离下一个魂环需要\s*\d+\s*级/.test(sys));
ok("提示词要求状态栏", sys.includes("[状态栏]"));

/* ---------- 5. 流式解析（mock fetch） ---------- */
const chunks = [
  'data: {"choices":[{"delta":{"content":"雨点"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"砸在"}}]}\n\ndata: {"cho',
  'ices":[{"delta":{"content":"铁砧上"}}]}\n\n',
  "data: [DONE]\n\n",
];
global.fetch = async () => {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
      }),
    },
  };
};
T.state.cfg = { key: "test", base: "https://api.deepseek.com", model: "deepseek-chat" };
let seen = 0;
const full = await T.chat(() => { seen++; });
ok("流式拼接完整", full === "雨点砸在铁砧上", JSON.stringify(full));
ok("流式回调被触发", seen === 3, seen);

/* ---------- 6. 请求失败时有可读错误 ---------- */
global.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid api key" });
let msg = "";
try { await T.chat(() => {}); } catch (e) { msg = e.message; }
ok("401 报错可读", msg.includes("401") && msg.includes("invalid api key"), msg);

console.log(fails ? `\nFAIL (${fails})` : "\nPASS");
process.exit(fails ? 1 : 0);
