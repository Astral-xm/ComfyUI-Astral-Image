# ComfyUI-Astral-Image

## 使用教程

- （B 站）：https://space.bilibili.com/176339505
- （YouTube）：https://www.youtube.com/@Astral%E6%98%9F%E8%8A%92

作者：**xm** · 许可证：**AGPL-3.0** · 节点与界面中的原作者信息不得删除或替换

面向图像工作流的 ComfyUI 节点包：在节点内完成图片的加载、缩放、裁剪、旋转和遮罩编辑，并提供 Qwen-Image 2.1 的尺寸还原与分辨率选择。

## 功能一览

| 节点 ID | 显示名 | 说明 |
| --- | --- | --- |
| `ImageLoadEditor` | 加载图像与编辑 | 上传 / 预览图片，缩放、对齐、裁剪、旋转与遮罩编辑 |
| `RestoreImageSize` | Image Astral · 恢复图像尺寸 | 把固定网格生成结果按指定宽高还原 |
| `ResolutionSelectLatent` | Resolution Select Latent | 按宽高比 / MP / 倍数计算宽高，或使用自定义宽高、原图比例、原图宽高，并输出空 Latent |

`ResolutionSelector` 已被 ComfyUI 内置节点占用，因此这里使用 `ResolutionSelectLatent`，避免自定义节点覆盖核心节点。

## 安装

### 通过 ComfyUI-Manager（推荐）

在 ComfyUI-Manager 中搜索 **ComfyUI-Astral-Image**，即可安装或更新。

### 通过 Git URL 安装

在 ComfyUI-Manager 中选择“通过 Git URL 安装”，填入：

```text
https://github.com/Astral-xm/ComfyUI-Astral-Image
```

### 手动安装

将仓库克隆或解压到：

```text
ComfyUI/custom_nodes/ComfyUI-Astral-Image
```

重启 ComfyUI。本包不需要额外安装前端或 Python 依赖，图片编辑使用 ComfyUI 自带的图片上传接口和浏览器原生 Canvas。

### 兼容性

- ComfyUI 0.3.60 及以上：使用 V3 `comfy_entrypoint` 入口。
- 旧版本 ComfyUI：自动使用 V2 `NODE_CLASS_MAPPINGS` 入口。

## 依赖

不额外安装 pip 包，使用的都是 ComfyUI 自带组件：

| 依赖 | 用途 |
| --- | --- |
| `numpy`、`torch` | 图像缩放、遮罩与 Latent 计算 |
| `Pillow` | 图片解码、编码与编辑 |
| `comfy_api`、`comfy.utils`、`folder_paths`、`node_helpers` | ComfyUI 节点接口 |

仓库根目录的 `requirements.txt` 只包含说明，不会安装额外包。

可选依赖：[`ComfyUI-Astral-Manage`](https://github.com/Astral-xm/ComfyUI-Astral-Manage)，用于图片预览上的中英文提示词反推按钮；未安装时不显示按钮，其他功能不受影响。

## ResolutionSelectLatent

搜索 `ResolutionSelectLatent`，或节点 ID `ResolutionSelectLatent`。节点输出 `Latent`、`宽度`、`高度`。

预设宽高比模式保留 ComfyUI `Resolution Selector` 的计算方式：

```text
总像素 = 百万像素 × 1024 × 1024
宽高按所选比例分配总像素
宽高再分别取“倍数”的整数倍
```

内置比例包括 `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`8:5`、`9:16`、`16:9` 和 `21:9`。默认 `16:9`、`2.0 MP`、`32` 倍数。

选择`自定义宽高`后，下方会显示`宽度`和`高度`，并隐藏`百万像素`与`倍数`。这两个手动尺寸原样输出，不参与比例计算，也不会被倍数取整。例如填写 `1000 × 613`，宽高输出仍是 `1000 × 613`。空 Latent 按 ComfyUI 的标准 VAE 8 倍网格创建，空间尺寸为 `高度 // 8 × 宽度 // 8`；因此非 8 倍数宽高在 Latent 解码时仍受 VAE 网格限制，但节点输出的宽高数值保持用户输入值。

节点新增可选的`图像`输入，`宽高比`下拉中增加两项：

- `原始比例`：使用接入图像的比例，再按`百万像素`和`倍数`计算宽高。
- `原始尺寸`：`宽度`和`高度`直接输出原图的精确宽高，`Latent` 也按该尺寸创建，忽略`百万像素`与`倍数`。

接入图像后，节点底部会实时显示计算出的输出尺寸（如 `Output: 1088 × 1920`）；原图尺寸尚未读取完成时会提示等待。没有接入图像却使用`原始比例`或`原始尺寸`时，执行会报错。

`批次大小`会直接作用于 Latent 的第一维。返回的空 Latent 使用 4 个通道，可直接连接到 `KSampler` 的 `latent_image`。

## 图像加载与编辑

搜索 `加载图像与编辑`，或节点 ID `ImageLoadEditor`。

节点使用 ComfyUI 自带图片上传接口和浏览器原生 Canvas，不需要额外安装前端或 Python 依赖。新节点按内容所需的最小尺寸创建；之后在画布上调整的节点尺寸会随工作流保存，并在切换或重新打开工作流时保留。

### 缩放

`缩放`的五种模式如下：

| 模式 | `缩放目标值`的含义 | 示例 |
| --- | --- | --- |
| `无` | 不缩放，保持原图尺寸 | 2048 × 1365 输出仍为 2048 × 1365 |
| `按分辨率` | Qwen-Image 2.1 的 `resolution` 面积档位，保持原比例搜索不动点尺寸 | `1088` 用于 3:2 原图时输出 1344 × 896，用于竖图时输出 896 × 1344 |
| `按图像比例` | 宽高共同乘的倍率 | `1.5` 表示放大到 150%，`0.5` 表示缩小一半 |
| `按目标宽度` | 输出宽度，高度按原比例计算 | 宽填 `1024`，原比例 3:2 时高约为 683 |
| `按目标高度` | 输出高度，宽度按原比例计算 | 高填 `1024`，原比例 3:2 时宽约为 1536 |

`resolution` 不是输出边长，而是 Qwen-Image 2.1 的面积档位，合法范围为 `512–4096`、步进 `32`。可直接填写 `1024`、`1088`、`1152`、`1280`、`1536`、`2048`、`4096` 等值。节点会结合原图比例、`tol_ratio` 和对齐因数搜索 Qwen 不会再次缩放的不动点宽高，计算方式与 BlueBox `Cut (Qwen-Image 2.1)` 一致。

打开旧工作流时，原来的`按像素数量`会自动迁移为`按分辨率`。旧 MP 目标会按面积换算为 resolution，例如 `1.0` 迁移为 `1024`、`1.5` 迁移为 `1248`；旧版直接保存的整数像素总数也会换算，例如 `1048576` 迁移为 `1024`。

节点会根据当前选择只显示对应的`缩放目标值`。把鼠标停在`缩放`或当前`缩放目标值`上，可查看该模式说明和计算后的预计输出尺寸。`缩放算法`支持 `nearest-exact`、`bilinear`、`area`、`bicubic`、`lanczos`。

`对齐因数`会把最终宽高取为该值的整数倍，便于适配分块模型。默认 `32`，填 `1` 表示不对齐。对齐过程产生的多余或残缺像素由`缩放模式`处理：

- `拉伸`：直接缩放到最终宽高，可能改变画面比例。
- `居中裁剪`：保持比例铺满目标尺寸，裁掉超出部分的边缘。
- `填充 / 边缘填充`：完整显示图片，剩余区域用`填充颜色`补齐。

启用任一缩放模式后，节点会参照 BlueBox `Cut (Qwen-Image 2.1)` 的逻辑选择候选尺寸。`按分辨率`会直接使用填写的 resolution；倍率、宽度和高度模式会先计算目标宽高，再自动得到最接近的 resolution。随后节点结合输入比例、Qwen 常用训练比例和面积误差选择候选尺寸，最后用 32 像素网格校验不动点。`tol_ratio` 位于`对齐因数`下方，默认 `0.8`，范围 `0.2–3.0`；值越大，允许参与比较的面积偏差越大。选择`无`时不会改动图像，也不会启用 `tol_ratio`。

`填充颜色`默认使用 `0,0,0` 的 RGB 写法，也支持颜色名和 `#RRGGBB`，例如 `12,34,56`、`black`、`#123456`。旧工作流中的十六进制颜色会在节点界面中自动转换为 RGB。

### 图片编辑器

上传或选择图片后只显示一张可编辑预览，不会额外显示 ComfyUI 的重复输出预览。节点内的图像下拉框、参数框和预览框统一使用直角矩形样式。图片加载成功后，预览右下角会显示方形剪刀图标；点击剪刀图标进入编辑器。节点预览不显示透明棋盘格，图片以外的留白和透明区域按官方节点的灰色背景显示；编辑器内部仍显示透明棋盘格，便于观察和编辑 Alpha 通道。

- 裁剪：支持自由框选、拖动八个控制点、移动裁剪框，以及 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`、`3:2`、`2:3` 常用比例；`自定义尺寸`会按填写的输出宽高裁切，源图区域不足时自动等比放大。拖动裁剪框或控制点时，显示框会始终保持所选宽高比。
- 旋转：支持角度输入、滑杆和 ±90° / 180°，预览时显示虚线九宫格，画布会扩展以保留边角。
- 遮罩编辑器：可直接打开 ComfyUI 官方遮罩编辑器。打开前会先保存当前裁剪和旋转修改，保存后回写到节点的`加载图像`参数。
- 遮罩参数：可设置遮罩颜色 RGB（默认 `0,0,0`）、填充遮罩漏洞、1 px 遮罩倒角、反转遮罩和遮罩扩展生长。扩展生长使用正数向外膨胀、负数向内收缩。
- 历史：支持撤销、重做，以及 `Ctrl+Z`、`Ctrl+Shift+Z`、`Ctrl+Y`。
- `恢复原图`：回到节点最初加载的原图，即使已经裁剪并保存、关闭后重新打开编辑器，仍可恢复最初尺寸；点击后直接恢复，不弹出确认框，恢复动作本身也可撤销。

点击`应用并上传`后，编辑结果会写成 PNG 到：

```text
ComfyUI/input/image_astral/edited
```

节点会自动回写新路径并刷新预览。输出中的 `mask` 来自 Alpha 通道：透明区域为 `1`，不透明区域为 `0`，并继续应用遮罩颜色之外的倒角、填充漏洞、反转和扩展参数。

节点输出：

- `image`：缩放和对齐后的图像。
- `mask`：缩放和对齐后的遮罩。
- `mask_image`：遮罩图像。非遮罩区域为白色，遮罩区域使用设置的 RGB 颜色。
- `resolution`：根据最终目标尺寸自动解析的 Qwen resolution 档位，可直接接到 `TextEncodeQwenImage21.resolution`。

旧版本的 `width` 和 `height` 输出已移除；需要最终宽高时，请使用 `ResolutionSelectLatent` 的 `宽度`、`高度` 输出。

### 图片右键菜单与提示词反推

右击节点中的图片预览，会调用 ComfyUI 官方的节点图片菜单，包含`打开图像`、`复制图像`和`保存图像`等与官方`加载图像`节点一致的操作。

安装并启用 [ComfyUI-Astral-Manage](https://github.com/Astral-xm/ComfyUI-Astral-Manage) 后，选中本节点时，Manage 会在画布浮动工具栏显示 `中` 和 `EN` 两个反推按钮：

- `中`：调用 Manage 的图像反推接口生成简体中文提示词。
- `EN`：生成英文提示词。

反推完成后结果会自动复制到剪贴板，并由 Manage 显示完成状态。请求会复用 Manage 的图像反推设置，包括 API / 本地模式、系统提示词规则和 Skill；请先在 Manage 的资产管理器中配置好图像 API，或配置本地 GGUF 模型。

本节点自身不再绘制反推按钮，因此不会出现重复的两组图标。未安装 Manage 时不显示反推工具栏，图片加载、编辑和其他功能不受影响。本项目不再依赖 `ComfyUI-Prompt-Assistant`。

## 恢复图像尺寸

搜索 `Image Astral · 恢复图像尺寸`，或节点 ID `RestoreImageSize`。

把 Qwen 固定网格生成结果按指定宽高还原，默认使用 `lanczos`。输入 `restore_width` / `restore_height` 通常来自工作流中记录的前处理尺寸，输出为还原后的图像以及最终宽高。

## Localization

Node display names, descriptions, input/output names, tooltips and errors use
English as the source language. When ComfyUI's language setting (`Comfy.Locale`)
starts with `zh`, the Chinese names, tooltips and combo option labels from
`locales/zh/nodeDefs.json` are shown instead. Combo option values stay English so
workflows remain portable; the Chinese labels are display-only.

## 开发

`dev_check.py` 用于在不启动 ComfyUI 的情况下加载节点包、注册节点并执行一次自检：

```powershell
python .\dev_check.py
```

如果 ComfyUI 不在默认位置，可设置环境变量 `COMFYUI_DIR` 指向 ComfyUI 根目录。

`qwen21.py` 中另含未注册的实验性 Qwen 2.1 前处理类，暂不作为节点提供。

## 发布新版本（维护者）

1. 修改 `pyproject.toml` 中的 `version`；确认 `PublisherId` 与 registry.comfy.org 上的发布者 ID 一致。
2. 在 registry.comfy.org 创建发布者并生成 API Key。
3. 安装 comfy-cli：`python -m pip install comfy-cli`
4. 在仓库根目录运行 `comfy node publish`，按提示输入 API Key。
5. 发布成功后，ComfyUI-Manager 会通过 Comfy Registry 检测新版本并提供更新。

## 许可与署名

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布。你可以在遵守许可证的前提下使用、修改和分发；通过网络提供服务时也必须提供完整源代码。

依据 AGPL-3.0 第 7(b) 条，作者附加要求：**不得删除、隐藏或替换节点、界面和源代码中的原作者署名“xm”及项目名称**。完整条款见 [NOTICE.md](NOTICE.md)，许可证全文见 [LICENSE](LICENSE)。
