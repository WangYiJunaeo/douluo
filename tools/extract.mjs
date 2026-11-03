// 从 src/data/game.ts 抽取纯数据（零依赖，不装 typescript）
// 做法：按顶层 const 名定位表达式文本 → 去掉 TS 修饰 → 在沙箱里 eval → 导出 JSON
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SRC = process.argv[2];
const OUT = process.argv[3];
const src = fs.readFileSync(SRC, "utf8");

// 跳过字符串/注释，找到从 i 开始、深度 0 处的第一个目标字符
function scanTo(text, from, stops) {
  let i = from, depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === q) break;
        i++;
      }
      i++; continue;
    }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 2; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && stops.includes(c)) return i;
    i++;
  }
  return -1;
}

function stripTs(expr) {
  return expr
    .replace(/\bas\s+const\b/g, "")
    .replace(/\bsatisfies\s+[A-Za-z_$][\w$.]*(<[^;=]*?>)?/g, "")
    .trim();
}

function extractConst(name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\b`, "g");
  const m = re.exec(src);
  if (!m) return null;
  const eq = scanTo(src, m.index + m[0].length, ["="]);
  if (eq < 0) return null;
  const end = scanTo(src, eq + 1, [";"]);
  if (end < 0) return null;
  return `const ${name} = ${stripTs(src.slice(eq + 1, end))};`;
}

// 项目里两个非字面量依赖，用等价实现补上（ageToLevel 的阈值就写在源码里）
const PRELUDE = `
// 原项目的占位头像是平台托管 URL，离开秒哒就失效；这里替换为空，前端改为本地生成头像
const PLACEHOLDER_MALE = { child: '', teen: '', adult: '', middle: '', old: '' };
const PLACEHOLDER_FEMALE = { child: '', teen: '', adult: '', middle: '', old: '' };
function ageToLevel(age){
  if (age >= 1000000) return { level: '百万年', color: '#ca8a04' };
  if (age >= 100000)  return { level: '十万年', color: '#dc2626' };
  if (age >= 10000)   return { level: '万年',   color: '#000000' };
  if (age >= 1000)    return { level: '千年',   color: '#a855f7' };
  if (age >= 100)     return { level: '百年',   color: '#facc15' };
  return { level: '十年', color: '#ffffff' };
}
function makeBone(partial){
  const { level, color } = ageToLevel(partial.age);
  return { ...partial, ageLevel: level, ageColor: color };
}
`;

// ALL_MARTIAL_SOULS 用了 TS 泛型（new Map<string, MartialSoul>），改为从分池数据推导
const WANT = [
  "ERA_LIST","RARITY_INFO","MARTIAL_SOULS_BY_ERA","BIRTHPLACES_BY_ERA",
  "TIMELINE_EVENTS","AVATAR_MAP","BACKGROUNDS","SOUL_RING_COLORS","FAVORABILITY_STAGES",
  "NPC_ALIAS_MAP","NPC_BIRTH_YEARS","NPC_GENDERS","RELATIONSHIP_STAGES",
  "SEXUAL_ORIENTATIONS","NPC_PERSONALITY_CONFIG","SOUL_BONE_PARTS","SOUL_BONES",
  "NPC_LEVEL_REFERENCE","MANDATORY_ENCOUNTERS","SOUL_BEAST_YEARS",
  "TRANSFORMED_SOUL_BEASTS","SOUL_RING_AGE_RULES","SYSTEM_PROMPT"
];

const parts = [PRELUDE];
for (const n of WANT) {
  const code = extractConst(n);
  if (code) parts.push(code);
  else console.error("MISS:", n);
}
parts.push("const ALL_MARTIAL_SOULS = Object.values(MARTIAL_SOULS_BY_ERA).flat();");

const keys = [...WANT, "ALL_MARTIAL_SOULS"];
const bundle =
  parts.join("\n") +
  `\n;(${JSON.stringify(keys)}).forEach(k=>{try{__out[k]=eval(k)}catch(e){console.error('EVALFAIL',k,e.message)}});`;

const __out = {};
const ctx = vm.createContext({ __out, console, JSON, Map, Set });
try {
  vm.runInContext(bundle, ctx, { timeout: 15000 });
} catch (e) {
  console.error("BUNDLE FAILED:", e.message);
  process.exit(1);
}

const got = Object.fromEntries(Object.entries(__out).filter(([, v]) => v !== undefined));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(got), "utf8");

for (const [k, v] of Object.entries(got)) {
  const n = Array.isArray(v) ? v.length : (typeof v === "object" && v ? Object.keys(v).length : String(v).length);
  console.log(`${k}: ${Array.isArray(v) ? "array" : typeof v}(${n})`);
}
// 缺口提示
const missing = keys.filter((k) => !(k in got));
if (missing.length) console.error("MISSING:", missing.join(", "));
console.log("bytes:", fs.statSync(OUT).size);
