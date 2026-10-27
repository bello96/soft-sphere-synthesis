# 噗叽水球

一款软体物理合成小游戏。每个球都是一只鼓鼓的软气球：被撞会压扁，被挤会填满缝隙，松开又鼓回来。拖动瞄准发射，相同数字的球碰在一起就会合成更大的一个。

## 怎么打开

在线试玩：<https://soft-synthesis.dengjiabei.cn/>

也可以直接双击 `index.html`，用浏览器打开就能玩。不需要安装、不需要联网、不需要本地服务器。
建议使用较新的 Chrome、Edge、Safari 或 Firefox；手机和电脑都可以。

改版前的泳池主题版本完整保留在 `versions/v1-pool/`，双击其中的 `index.html` 可以对比（线上地址为 `/versions/v1-pool/`）。

## 怎么玩

- **瞄准发射**：在水箱里按住并拖动，白色点线是预测轨迹。拖得越远力度越大，发射器里的球也会被压得越扁；松手发射。拖回发射器中心再松手可以取消。
- **合成**：两个数字相同的球接触就会合成，连续合成有连击加分。
- **换球**：点左上角的"下一个"或底部"换球"按钮，交换当前球和下一个球。
- **摇一摇**：把水箱里的球都抛起来重新排布，每局 3 次，每合成 12 次补 1 次。
- **结束条件**：有球停在虚线上方超过 3 秒，这局结束。倒计时期间虚线和水箱边框会变红。
- **透视**：显示软体的物理结构（质点、表皮、静止形状）。

键盘：空格换球，S 摇一摇，P 或 Esc 暂停，X 透视，M 静音，Enter 开始。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `index.html`、`css/` | 页面与界面 |
| `js/physics.js` | 自写的二维软体物理引擎（XPBD） |
| `js/game.js` | 游戏规则 |
| `js/render.js`、`js/fx.js` | Canvas 渲染与特效 |
| `js/audio.js` | WebAudio 实时合成音效 |
| `js/config.js` | 所有可调参数 |
| `dev/physics-lab.html` | 物理调试页：点击投球，查看质点与运行统计 |
| `dev/tools/` | 无头浏览器自动对局机器人、界面点检、手感指标、参考视频测量（见其中的 README） |
| `docs/ANALYSIS.md` | 参考视频逐帧分析、与原作的对照测量、实现原理 |
| `versions/v1-pool/` | 改版前的版本（泳池主题、不可压缩水球） |
| `wrangler.jsonc`、`.assetsignore` | Cloudflare 部署配置 |

分析用的参考录屏和截图（`ReferenceResources/`）是原作的游戏画面，只保留在本地，没有放进仓库。

## 部署

部署在 Cloudflare Workers 的静态资源上（没有服务端代码），自定义域名 `soft-synthesis.dengjiabei.cn` 写在 `wrangler.jsonc` 里。
上传哪些文件由 `.assetsignore` 控制：只发布 `index.html`、`css/`、`js/`、`assets/` 和 `versions/`。

```bash
npm install        # 安装 wrangler（只用于部署，游戏本身没有依赖）
npx wrangler login # 第一次使用时登录 Cloudflare
npm run deploy
```

## 原理一句话

每个球是一圈质点组成的"气球"：相邻质点之间是几乎不能伸长、并且预先绷紧的"皮"，环内是一团可以被压缩的"气"（越压越硬），皮的张力和气压在圆形时正好平衡。所以球平时是圆的、被撞会压扁、在球堆里会挤成多边形，松开后再鼓回来。碰撞在质点和其他球的边之间计算，整套用每帧 10 个子步的 XPBD 求解。详细推导、与原作的对照测量和调参记录见 [docs/ANALYSIS.md](docs/ANALYSIS.md)。

## 致谢

字体 Fredoka 采用 SIL Open Font License，许可文本见 `assets/fonts/OFL.txt`。
