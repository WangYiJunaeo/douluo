# 斗罗大陆 · 文字冒险

零依赖的单页文字冒险：浏览器直接调用 DeepSeek 的 Chat Completions 接口，把大模型当作剧情引擎，前端负责状态解析与呈现。

## 特点

- **零构建、零依赖**：没有 `npm install`，三份文件 + 一份数据，双击 `public/index.html` 也能跑
- **流式输出**：字是一个一个出来的，不用等整段生成
- **原著规则内置**：魂环整十级铁则、NPC 等级参考、好感度曲线、必遇 NPC、大事件时间线
- **状态栏容错解析**：半角冒号、漏字段都不会让数值静默丢失
- **进度存本机**：localStorage，可导出/导入文本在设备间迁移
- **移动端优先**：适配刘海屏与安全区，可"添加到主屏幕"全屏运行

## 本地运行

```bash
node serve.mjs          # 默认 http://localhost:8787
node serve.mjs 9000     # 指定端口
```

启动后会打印局域网地址，同一 WiFi 下手机可直接打开。

也可以直接双击 `public/index.html`（`file://` 方式，无需服务器）。

## 使用

1. 首次打开填写 DeepSeek API Key（存在本机浏览器，不上传）
2. 选择时代、姓名、性别，抽取武魂与先天魂力，选择出身
3. 开始游戏，跟着选项走

## 目录

```
public/
  index.html              入口
  app.js                  全部逻辑（解析 / 请求 / 渲染 / 存档）
  style.css               深蓝紫 + 魂环配色
  data/game.data.js       武魂池、事件表、NPC 表、系统提示词
  manifest.webmanifest    PWA 清单
  icon.svg                图标
serve.mjs                 零依赖静态服务器
tools/extract.mjs         从上游 TS 项目抽取数据（开发用）
test/smoke.mjs            无浏览器冒烟测试
```

## 测试

```bash
node test/smoke.mjs
```

覆盖：状态栏/选项解析（含容错格式）、关系增减、魂环解析、提示词拼装、SSE 流式拼接、API 错误提示。

## 说明

非商业同人作品，仅供个人游玩。设定与角色归属原作者及版权方。API Key 由使用者自行提供。
