# 实现细节

这份文档写给要改这个插件的人。README 讲用法，这里讲为什么这样写、哪里容易坏。

## 一次调用发生了什么

```
see_act(args)
  ├─ readStop()            旗标在就先拒绝（文件，不是进程信号）
  ├─ canAct(config)        mode=readonly 时只报错
  ├─ normalizeSteps()      动词别名、坐标解析、危险键、步数/时长上限
  ├─ overlayPid()          读 ~/.dsh/see-now-window.pid，进程活着才用
  ├─ makeOutDir()          ~/.dsh/see-act-frames/act-XXXXXX
  ├─ actOnScreen(plan)     ← 只有这一次进程 spawn
  │    powershell.exe -File run.ps1     （Add-Type 编译 C#，约 250ms）
  │      ├─ SetProcessDpiAwarenessContext(-4) + Screen.AllScreens
  │      ├─ Resolve-Region(foreground)              选屏
  │      ├─ Capture-Screen + Get-Signature             before 位图 + 64×40 指纹
  │      ├─ Save-Annotated(before)                    网格/准星/浮窗框
  │      ├─ 需要时 ShowWindow(float, 0)                遮挡避让
  │      ├─ 逐步 Invoke-Step + 每步截屏 + Compare-Signature
  │      ├─ Save-Annotated(after)                     准星 + 3× 插图
  │      └─ ShowWindow(float, 4|5) 恢复
  ├─ attachFrames()        PNG → attachments.saveImage（之后删掉临时目录）
  ├─ narrate()/say()       写 ~/.dsh/see-now/chat.jsonl 旁白
  └─ buildText()           文字结论（会活过压缩，图片不会）
```

关键取舍：**一次动作只 spawn 一次 PowerShell**。`real_*` 每个动作 spawn 一次，一次
"截图→点击→截图"就是三次 Add-Type 编译（每次约 250ms）加三次进程启动。这里把
before/点击/after 塞进同一个进程，代价是脚本更复杂——plan 以 base64 塞进 `__PLAN_B64__`，
脚本自己解码，结果是一整块 JSON 打到 stdout。

## 坐标模型

三层坐标，不要混：

| 层 | 单位 | 出现在 |
|---|---|---|
| 归一化 | 0..1，相对**捕获区域**（一块屏或整个虚拟桌面） | 工具的 `nx/ny`、`cell` |
| 物理像素 | 虚拟桌面坐标（多屏时第二块屏的 x 从 2560 开始） | 工具的 `x/y`、返回的 `done x=… y=…`、`steps[].x` |
| 图像像素 | 缩放后的 PNG 像素（800/1280/1600 宽） | 只有图上有，**不要用它算坐标** |

换算只有一处公式，JS 与 PowerShell 各实现一遍且必须一致：

```
x = round(region.left + nx * (region.width  - 1))
y = round(region.top  + ny * (region.height - 1))
```

`-1` 是为了让 `nx=1` 正好落在最后一个像素上，不是屏幕外面。

标注（准星、插图、浮窗框）画在**只覆盖 region 的位图**上，所以画之前要先 `To-Local`
减掉 `region.left/top`；`Save-Annotated` 内部再按 `CropW → outW` 的比例缩放到输出尺寸。

**踩过的坑**：`Invoke-Step` 曾经签名为 `($step)`，调用处却传了 `Invoke-Step $st $region`——
PowerShell 不报错（非 strict 模式多传的参数被忽略），于是 `Resolve-Point` 拿不到 region，
退回"整块主屏"，点 0.22 的结果变成主屏的 563 而不是第二块屏的 2982。表现是准星飞出画面、
插图裁到别处、点击落在错误的地方。现在签名是 `Invoke-Step($step, $region)`，`at`/`to` 都带 region。

## 多屏与 DPI

- 显示器列表来自 `[System.Windows.Forms.Screen]::AllScreens`，**必须在** `SetProcessDpiAwarenessContext(-4)`
  之后枚举，否则拿到的是 150% 缩放下的逻辑坐标（本机 1707×1067 而不是 2560×1600）。
- `screen` 解析顺序：显式序号 > `primary` > `cursor`（光标所在屏）> `foreground`
  （与前台上层窗口矩形**交集面积最大**的屏，找不到再退光标屏）> `all`/`virtual`（虚拟桌面一整块）。
- 未感知 DPI 的进程（包括我们调试时开的普通 PowerShell）枚举到的窗口坐标要 ×1.5 才是物理像素。
  这就是为什么早期把 1204,432 467×539 的浮窗误当成 1806,648 701×809。

## 标注

- 网格：每 0.1 一条线，只在 0/0.5/1.0 处写 `x=`/`y=` 标签（白字黑底），避免满屏数字。
- 准星：白环 r21 + 红环 r20 + 四向刻度，旁边写 `intended x=… y=…`（before）、`done x=… y=…`（after）、
  `at x=… y=…`（look）。用文字而不是只画线，是因为模型读图不如读字可靠。
- 3× 插图：先定框宽 `min(0.28*outW, 340)`，再让裁切尺寸 `= box/factor`，这样放大倍数是真的
  （早期按固定 320px 裁切再塞进 380px 框，实际只有 1.19×，标签却写 3×）。
  插图放在**离准星最远**的那个角，避免盖住它要放大的东西。插图上再画一个红十字。
- 底部 22px 黑带写 `BEFORE 21:43:02.291  screen monitor 2 1920x1080 @ 2560,145` / `AFTER … changed=0`。

## 变化检测

`Get-Signature` 把位图用 HighQualityBilinear 缩到 64×40，取亮度 `0.299R+0.587G+0.114B`；
`Compare-Signature` 按 cell 差 ≥18 记为变化，返回变化比例和变化区域（归一化 box）。
步与步之间比，首帧与末帧也比。`changed == 0` 时文字里写 `no change` 并加一条 warning
（"nothing on screen changed since the first frame"）——这句话是给人看的信号：点了但界面没动，
通常意味着点空了或者目标本来就没反馈。

`blackScreen = 首帧签名最大亮度 < 12`：GDI 抓不到硬件叠层时是全黑，这时若
`captureFallback` 打开，就用 ffmpeg 的 `ddagrab` 重抓一张（只覆盖主屏、无标注，role 记为
`fallback`），并在文字里说明。

## 浮窗避让

- pid 来源：`dsh-see-now/window` 的 `pidPath()`（`~/.dsh/see-now-window.pid`），或用
  `process.kill(pid, 0)` 直接验证过的文件；拿不到就是 0（不避让）。
- 窗口矩形：C# 里 `FindWindowByPid`——EnumWindows + `IsWindowVisible` + 同 pid + 宽≥60 高≥40，
  **允许空标题**（tkinter `overrideredirect` 的窗口没有标题，靠标题会永远找不到）。
- 只有某一步的落点真的落在矩形内（pad 6px）才隐藏：每步都隐藏会让用户的画面抖。
- 恢复用 `ShowWindow(hwnd, 4)`，仍不可见再 `ShowWindow(hwnd, 5)`；恢复正常路径做完就恢复，
  `finally` 里再兜一次（抛异常也恢复）。
- **必须先把窗恢复、再拍 after 帧**。after 帧是模型决定下一步的依据，如果那一帧里浮窗还没回来，
  模型下一轮会以为自己点掉的窗口凭空消失了（早期版本就踩过：文字说 "restored"、图上却是空的）。
  恢复后重抓一帧、用它当 `after`，`changed` 也才是在比"同一个可见状态"，而不是把隐藏-恢复算成变化。
- **避让不依赖"拍得到浮窗"**。see-now 0.2 起浮窗设了 `WDA_EXCLUDEFROMCAPTURE`，截图/录屏里
  根本没有它（GDI、`BitBlt`、`PrintWindow`、ffmpeg/ddagrab 全都拍不到），矩形却照样拿得到。
  所以这个功能在"看不见浮窗像素"的环境里仍然是唯一能防误点的手段；要让浮窗出现在帧里，
  写 `~/.dsh/watch-window.json` 的 `{"capturable": true}`。

## 失败与降级

| 情况 | 行为 |
|---|---|
| 没有 see-now | 旁白静默跳过，`overlayPid=0`，两张图照出 |
| 没有 attachments 服务 | 图不返回，文字照写 |
| 配置 JSON 坏了 | 记一条日志，用默认值（一个手滑不能让人失去鼠标） |
| PowerShell 超时/报错 | 抛 `see-act <action> failed: …`，带最后 20 行 stderr |
| 旗标存在 | `see_act` 直接抛错，提示用 `see_stop({action:"clear"})` |
| 目标在浮窗里且 `dodge:"off"` | 照点，文字里写明"这一下会点到浮窗上" |

## 宿主校验：schema 写错，整个插件挂掉

工具形状（完整 JSON Schema 的 `parameters` + `output.schema`）是宿主要校验的，而且**一处不合法就是
整个 fiber `failed`**——不是那个工具不可用，是四个工具全都不存在。第一次装上时踩的就是这个：

```
include:dsh-see-act  enabled:true  fiberPhase:"failed"
diagnostic: unsupported JSON schema: schema.properties.images.items.type must be one of
            object/array/string/number/integer/boolean/null;
            schema.properties.meta.type must be one of ...
```

原因：`output.schema` 里写了 `{ type: 'json' }`。`type:'json'` 是 see-now 在 `defineTool`
的属性映射形状里的简写，宿主在那种形状下会自己展开；直接注册完整 JSON Schema 时它被当成未知类型
拒掉。所以 `images.items` 用 `{ type: 'object' }`、`meta` 用 `{ type: 'object' }`，
`test/tools.test.mjs` 里有一条测试走遍所有 schema，任何 `type` 不是
object/array/string/number/integer/boolean/null 就失败。

排查手法：`plugin_manager` 的 `list_plugins` 里每条都有自己的 `fiberPhase` 和 `diagnostic`；
`fiberPhase: "failed"` 就是用它定位的（工具看不到时先看这里，不要先怀疑路径或 apply）。

改完要让它生效：`set_plugin`（target 用**完整 entryId**，如 `include:dsh-see-act`，用包名会
回 `unknown-plugin`）。改文件本身不会热重载失败的 fiber，但 `set_plugin` 成功会重新 apply，
工具 schema 会作为增量推给正在进行的会话。

## 性能（本机实测，双屏）

| 动作 | 时间 |
|---|---|
| `probe`（选屏 + 光标 + 前台窗口） | ~1.0s |
| `look` 1280 宽（抓图 + 网格 + 准星 + 插图） | ~1.7s |
| `zoom` 3× / 320 | ~1.3s |
| `act` 单步 wait + before/after + 插图 | ~2.3s |
| `act` 单步 move + before/after | ~2.0s |

构成大致是：Add-Type 编译 ~250ms、整屏拷贝 ~60–90ms、签名 ~40ms、每次标注 ~150–250ms、
PNG 编码与临时文件 ~100ms。想更快：`shots:"after"` 省掉一次标注；把 `quality` 降到 `fast`；
把 `settleMs` 调小（代价是 after 帧可能拍到动画中间）。

## 调试

`runSeePlan` 只回 stderr 最后 20 行。要拿到完整报错和行号：

```js
const src = fs.readFileSync('lib/win32ps.mjs', 'utf8')
const start = src.indexOf('String.raw`')
const ps = src.slice(start + 'String.raw`'.length, src.lastIndexOf('`'))
fs.writeFileSync('run.ps1', '\uFEFF' + ps.replace('__PLAN_B64__', b64), 'utf8')
// powershell.exe -NoProfile -ExecutionPolicy Bypass -File run.ps1
```

三个必须记住的坑：

1. **PowerShell 5.1 里 `数字 + '字符串'` 会抛** `无法将值"x"转换为类型"System.Int32"`。
   拼字符串必须让字面量在左：`'x=' + $w`，或者 `"$w x"`。
2. **续行反引号 `` ` `` 不能出现在 JS 模板字符串里**（会直接终止模板）。多行参数调用改成
   哈希表 splatting：`$opts = @{…}` 然后 `Save-Annotated @opts`。
3. **别用 Windows PowerShell 的 `Get-Content`/`Set-Content -Encoding UTF8` 改这些文件**：
   5.1 读无 BOM 的 UTF-8 会按 ANSI(GBK) 解释，`—`、`→`、中文会被写坏成 `鈥?`。要改文本用
   `edit` 工具或 Node 的 `fs`。

## 测试

- `test/geometry.test.mjs`：`parsePoint` 三种形式、`pixelOf` 与 PS 同式、`scaleText`、`changedText`。
- `test/act.test.mjs`：动词别名、钳位、危险键 + `force`、步数/时长上限、时长估算、旗标读写。
- `test/config.test.mjs`：默认值、文件覆盖、坏 JSON、单字段坏掉不影响其它、env 优先级、`canAct`。
- `test/tools.test.mjs`：四个工具的形状（完整 JSON Schema、output.render 的 content 顺序、超时）。
- `test/e2e-tools.mjs`（手动）：真的截图、真的移动鼠标、arm/clear 刹车、危险键与坏坐标被拒。
- `test/smoke.mjs`（手动）：直接打 PowerShell 层的四个动作，打印 JSON，图片写到 `%TEMP%\see-act-smoke`。
