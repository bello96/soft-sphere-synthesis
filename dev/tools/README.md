# 开发验证工具

用无头 Chrome 驱动真实游戏页面做自动化检查。不需要安装依赖（Node 18+ 自带 WebSocket 与 fetch）。

## 1. 启动无头 Chrome（单独的配置目录，端口 9333）

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --remote-debugging-port=9333 \
  --user-data-dir="$TEMP/squish-chrome" --no-first-run --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required about:blank
```

（在 Claude Code 里用后台方式运行；用完记得停掉。）

## 2. 运行检查

在项目根目录执行，`NO_PROXY='*'` 避免本机请求走代理：

```bash
# 自动对局机器人：参数依次为 标签、对局秒数、视口宽、视口高、随机种子
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/bot.mjs bot 180 390 844 7

# 界面逐项点检（开始、发射、画布不越出舞台、微信式迟到的底部安全区、新一局重新适配水箱、静音、暂停、重开、结束、最高分保存）
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/ui-check.mjs final 390 844
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/ui-check.mjs se 375 603   # 小屏：水箱高度不顶格，能看出重新适配
```

截图默认存到系统临时目录下的 `squish-shots/`，可用环境变量 `SHOTS_DIR` 改。

## 3. 机器人输出怎么看

| 字段 | 含义 | 健康值 |
| --- | --- | --- |
| `deepFrames` | 有质点落进别的球里的帧数 | 0 |
| `squeezeMin` | 已稳定的球（出生 1 秒后、不在缩放动画中）被挤压到的最小面积比例 | 撞击/堆底瞬间可低到 0.4 左右 |
| `swellMax` | 同上，最大面积比例（气压会让自由球略大于 1） | ≲ 1.3 |
| `crushFrames` | 有球面积低于 45% 且持续超过 0.5 秒（被压瘪卡住）的帧数 | 0 |
| `tangles` | 质点环自相交、被物理层自动理顺的次数（球数×帧） | 0 或极少 |
| `foldFrames` | 有边相对质心反向（环局部翻折或月牙形）的帧数 | 越少越好，偶发可接受 |
| `avgStep` | 单帧物理耗时（毫秒） | ≈ 1 |
| `kinds` | 合成方式统计：`union` 并集轮廓 / `grow` 备用充气 | union 占绝大多数 |
| `overAt` | 第一次游戏结束的帧（机器人会自动重开） | 正常对局通常为 null |

机器人会接管 `Math.random`、屏蔽页面自身的主循环并静音（音效会消耗随机数，且受真实音频时钟节流），所以同一个种子的结果可复现。

## 4. 写自己的检查脚本

`cdp.mjs <steps.mjs> [参数...]` 会连接 9333 端口的第一个标签页（设置 `CDP_NEW=1` 则新开一个标签页），
调用 `steps.mjs` 默认导出的 `async (page, args) => {...}`。`page` 提供
`navigate`、`eval`、`waitFor`、`shot`、`drag`、`viewport`、`sleep` 和原始的 `send`（CDP 命令）。
页面上 `window.__game`、`window.__renderer` 可直接访问游戏对象。

## 5. 手感指标（不需要浏览器）

`lab.mjs` 用 Node 直接加载 `js/config.js` 和 `js/physics.js`，可以脚本化地做物理实验。
`feel.mjs` 输出与 `docs/ANALYSIS.md` 第 2.3 节对照表同口径的数字：各大小球的晃动周期与衰减、
拉长时的面积、撞墙压扁程度、静置时的扁度、被大球压住时的面积。

```bash
node dev/tools/feel.mjs                               # 当前参数
node dev/tools/feel.mjs '{"phys":{"pressure0":7}}'    # 临时覆盖参数，不改文件
```

## 6. 游戏胶片联系表

`film.mjs` 用真实游戏逻辑逐帧推进，把画面拼成一张图，适合看撞击、合成、发射的过程。参数是一个 JSON：
`setup`/`act` 是在页面里执行的代码（`g` 为游戏对象，`W` 为物理世界），`settle`/`pre` 是先空跑的帧数，
`frames`、`every`、`cols`、`cellW` 控制取帧和排版，`cropFromBottom` 只截水箱底部，`events` 在指定格执行代码。

```bash
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/film.mjs '{"out":"film.png","frames":12,"every":3,"cols":6,"cellW":200}'
```

## 7. 参考视频测量

`video/` 里的工具用来对 `ReferenceResources/` 的录屏做逐帧测量。先启动本地服务（页面要读视频像素，
`file://` 的视频会让 canvas 无法读取）：

```bash
node dev/tools/video/serve.mjs     # 后台运行，端口 8765

# 联系表：视频文件名、输出图、起止秒、间隔、列数、每格宽度、可选裁剪框（视频像素 x y w h）
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/video/sheet.mjs "微信视频2026-10-27_111101_759.mp4" sheet.png 6 9 0.15 7 220 380 0 520 592

# 跟踪一个球：每帧输出面积、宽高、长宽比、质心。seed 是球内一点（避开数字）
NO_PROXY='*' node dev/tools/cdp.mjs dev/tools/video/measure.mjs '{"video":"微信视频2026-10-27_111101_759.mp4","crop":[380,0,520,592],"t0":7.45,"t1":8.6,"dt":0.0333,"seed":[277,125]}'
```

横屏视频的水箱内宽约 462 像素，竖屏视频约 500 像素；乘以 600 / 内宽即换算成本项目的世界单位。
