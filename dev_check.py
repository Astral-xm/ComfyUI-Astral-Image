"""开发自检：不启动 ComfyUI，也能验证节点包能否正常加载与执行。

用法（用 ComfyUI 自带的 python 运行；可用 COMFYUI_DIR 指定 ComfyUI 根目录）：

    python dev_check.py

做的事：
  1. 把 ComfyUI 根目录和本节点包加入 import 路径
  2. 导入节点包，确认没有语法 / 导入错误
  3. 跑一遍 V3 入口，打印实际注册的节点
  4. 用一张假图片跑一遍 XMAstralImageInfo，确认 execute 逻辑正确
  5. 验证自定义图像尺寸选择器的预设比例、8:5、自定义宽高与 Latent
  6. 验证 Qwen 2.1 不动点、三种对齐模式、五种插值算法与尺寸恢复
  7. 验证图像加载编辑节点的缩放、裁剪、补边、遮罩与递归图片列表
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

PROBE_MODULE_NAME = "_image_astral_probe"
BLUEBOX_PROBE_MODULE_NAME = "_image_astral_bluebox_probe"


def load_node_pack(pack_root: Path):
    """按目录路径导入节点包（包名带连字符，不能直接 import）。"""
    init_file = pack_root / "__init__.py"
    if not init_file.is_file():
        raise SystemExit(f"找不到节点包入口：{init_file}")

    spec = importlib.util.spec_from_file_location(
        PROBE_MODULE_NAME,
        init_file,
        submodule_search_locations=[str(pack_root)],
    )
    if spec is None or spec.loader is None:
        raise SystemExit(f"无法为 {init_file} 创建模块 spec")

    module = importlib.util.module_from_spec(spec)
    sys.modules[PROBE_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def check_v3_entrypoint(pack) -> list[str]:
    """跑一遍 V3 入口，返回注册到的节点 ID 列表。"""
    if not hasattr(pack, "comfy_entrypoint"):
        raise SystemExit("节点包缺少 comfy_entrypoint，V3 入口不可用")

    extension = asyncio.run(pack.comfy_entrypoint())
    node_classes = asyncio.run(extension.get_node_list())

    node_ids = []
    for node_cls in node_classes:
        schema = node_cls.define_schema()
        node_ids.append(schema.node_id)
    return node_ids


def check_v2_mappings(pack) -> dict[str, str]:
    """检查旧版 ComfyUI 用的映射表。"""
    mappings = getattr(pack, "NODE_CLASS_MAPPINGS", {})
    display = getattr(pack, "NODE_DISPLAY_NAME_MAPPINGS", {})
    if not mappings:
        raise SystemExit("NODE_CLASS_MAPPINGS 为空，旧版 ComfyUI 会加载不到任何节点")

    missing = [node_id for node_id in mappings if node_id not in display]
    if missing:
        raise SystemExit(f"这些节点缺少显示名：{missing}")
    return display


def check_execute(pack) -> str:
    """用一张假图片跑一遍节点逻辑。"""
    import torch

    node_cls = pack.NODE_CLASS_MAPPINGS["XMAstralImageInfo"]
    image = torch.zeros(2, 64, 96, 3, dtype=torch.float32)

    result = node_cls.execute(image=image)
    outputs = list(result.args)
    width, height, batch_size, megapixels, info = outputs[1:]

    expected = (96, 64, 2)
    actual = (width, height, batch_size)
    if actual != expected:
        raise SystemExit(f"宽高 / 批次结果不对，期望 {expected}，实际 {actual}")

    if outputs[0] is not image:
        raise SystemExit("IMAGE 输出没有原样透传")

    return str(info)


def check_resolution_selector(pack) -> str:
    """验证融合后的尺寸选择器与空 Latent。"""
    import comfy.model_management as model_management

    node_cls = pack.NODE_CLASS_MAPPINGS["ResolutionSelectLatent"]
    schema = node_cls.define_schema()
    if schema.node_id != "ResolutionSelectLatent":
        raise SystemExit(f"尺寸选择器节点 ID 错误：{schema.node_id}")
    if pack.NODE_CLASS_MAPPINGS.get("ResolutionSelector") is node_cls:
        raise SystemExit("尺寸选择器不能覆盖 ComfyUI 内置 ResolutionSelector")
    if schema.display_name != "ResolutionSelectLatent":
        raise SystemExit(f"尺寸选择器名称错误：{schema.display_name}")
    inputs = {item.id: item for item in schema.inputs}
    outputs = [item.display_name for item in schema.outputs]
    if outputs != ["Latent", "Width", "Height"]:
        raise SystemExit(f"尺寸选择器输出错误：{outputs}")
    ratio_options = list(inputs["aspect_ratio"].options)
    if "8:5 (Widescreen)" not in ratio_options:
        raise SystemExit("宽高比缺少 8:5")
    if "Custom Size" not in ratio_options:
        raise SystemExit("宽高比缺少 Custom Size")

    standard = node_cls.execute(
        aspect_ratio="8:5 (Widescreen)",
        megapixels=2.0,
        multiple=32,
        width=1024,
        height=1024,
        batch_size=2,
    )
    latent, width, height = tuple(standard.args)
    if (width, height) != (1824, 1152):
        raise SystemExit(f"8:5 尺寸计算错误：实际 {width} x {height}")
    if tuple(latent["samples"].shape) != (2, 4, 144, 228):
        raise SystemExit(
            f"8:5 Latent 形状错误：{tuple(latent['samples'].shape)}"
        )
    if latent.get("downscale_ratio_spacial") != 8:
        raise SystemExit("空 Latent 缺少官方 8 倍空间缩放标记")
    expected_dtype = model_management.intermediate_dtype()
    if latent["samples"].dtype != expected_dtype:
        raise SystemExit(
            "空 Latent 未使用 ComfyUI 中间精度："
            f"期望 {expected_dtype}，实际 {latent['samples'].dtype}"
        )

    # 旧工作流保存的是中文选项值，生产代码仍将其识别为 Custom Size。
    for megapixels, multiple in ((0.1, 1), (16.0, 256)):
        custom = node_cls.execute(
            aspect_ratio="自定义宽高",
            megapixels=megapixels,
            multiple=multiple,
            width=1000,
            height=613,
            batch_size=1,
        )
        custom_latent, custom_width, custom_height = tuple(custom.args)
        if (custom_width, custom_height) != (1000, 613):
            raise SystemExit(
                "自定义宽高被百万像素或倍数修改："
                f"mp={megapixels}, multiple={multiple}，"
                f"实际 {custom_width} x {custom_height}"
            )
        if tuple(custom_latent["samples"].shape) != (1, 4, 76, 125):
            raise SystemExit(
                f"自定义 Latent 形状错误：{tuple(custom_latent['samples'].shape)}"
            )

    return "8:5、自定义 1000 x 613、批次与 Latent 通过"


def check_qwen21(pack) -> str:
    """验证 Qwen 2.1 固定网格加载器与尺寸恢复节点。"""
    import torch

    restore_cls = pack.NODE_CLASS_MAPPINGS["RestoreImageSize"]
    qwen_module = sys.modules[restore_cls.__module__]
    loader_cls = qwen_module.XMAstralQwen21LoadResize

    known_fixed_points = [
        ((1024, 1024), 1024),
        ((1184, 896), 1024),
        ((896, 1184), 1024),
        ((1376, 768), 1024),
        ((768, 1376), 1024),
        ((864, 1536), 1152),
    ]
    for expected, resolution in known_fixed_points:
        actual = qwen_module._qwen_resized_size(*expected, resolution)
        if actual != expected:
            raise SystemExit(
                f"Qwen 不动点校验失败：{expected} @ {resolution} 被缩放成 {actual}"
            )

    # V2 会先按画面/面积评分选尺寸，再回退到最接近输入比例的真正不动点。
    v2_boundary = qwen_module.pick_qwen21_fixed_point(
        512,
        1024,
        resolution="2048",
        tol_ratio=0.8,
    )
    if (v2_boundary.width, v2_boundary.height) != (1440, 2912):
        raise SystemExit(
            "V2 定尺寸顺序不一致："
            f"期望 1440 x 2912，实际 {v2_boundary.width} x {v2_boundary.height}"
        )

    source = torch.zeros((1, 64, 96, 3), dtype=torch.float32)
    tested = 0
    for method in qwen_module.UPSCALE_METHODS:
        for mode in qwen_module.RESIZE_MODE_OPTIONS:
            result = loader_cls.execute(
                image=source,
                image_file=None,
                input_scale=1.0,
                resolution="512",
                resize_mode=mode,
                upscale_method=method,
                repeat=1,
                mask_channel="alpha",
                background_color="",
                tol_ratio=0.8,
                pad_color=0.0,
            )
            image, mask, width, height, resolution, _, _, _ = tuple(result.args)

            if image.shape != (1, height, width, 3):
                raise SystemExit(
                    f"{method}/{mode} 图像尺寸不一致："
                    f"tensor={tuple(image.shape)}, 输出={width}x{height}"
                )
            if mask.shape != (1, height, width):
                raise SystemExit(
                    f"{method}/{mode} 遮罩尺寸不一致：{tuple(mask.shape)}"
                )
            if qwen_module._qwen_resized_size(width, height, resolution) != (
                width,
                height,
            ):
                raise SystemExit(
                    f"{method}/{mode} 没有落在不动点：{width}x{height} @ {resolution}"
                )
            tested += 1

    restore_result = restore_cls.execute(
        image=image,
        width=96,
        height=64,
        upscale_method="lanczos",
    )
    restored = tuple(restore_result.args)[0]
    if restored.shape != source.shape:
        raise SystemExit(
            f"恢复尺寸失败：期望 {tuple(source.shape)}，实际 {tuple(restored.shape)}"
        )

    return f"{tested} 种缩放组合通过，恢复为 {restored.shape[2]} x {restored.shape[1]}"


def check_image_editor(pack, pack_root: Path, comfy_root: Path) -> str:
    """验证图像加载与编辑节点的后端计算。"""
    import torch
    from PIL import Image

    node_cls = pack.NODE_CLASS_MAPPINGS["ImageLoadEditor"]
    image_module = sys.modules[node_cls.__module__]
    qwen_module = sys.modules[
        pack.NODE_CLASS_MAPPINGS["RestoreImageSize"].__module__
    ]

    schema = node_cls.define_schema()
    if schema.display_name != "Load Image & Edit":
        raise SystemExit(
            f"图像加载与编辑节点名称错误：{schema.display_name}"
        )
    schema_inputs = {item.id: item for item in schema.inputs}
    expected_outputs = [
        "image",
        "mask",
        "mask_image",
        "width",
        "height",
        "resolution",
    ]
    actual_outputs = [item.display_name for item in schema.outputs]
    if actual_outputs != expected_outputs:
        raise SystemExit(
            f"图像加载与编辑节点输出错误：期望 {expected_outputs}，实际 {actual_outputs}"
        )
    resolution_input = schema_inputs["target_resolution"]
    if resolution_input.default != 1024:
        raise SystemExit("按分辨率缩放默认值应为 1024")
    if (
        resolution_input.min != 512
        or resolution_input.max != 4096
        or resolution_input.step != 32
    ):
        raise SystemExit(
            "resolution 参数范围错误：应为 512–4096、步进 32，"
            f"实际为 {resolution_input.min}–{resolution_input.max}、"
            f"步进 {resolution_input.step}"
        )
    if "target_pixels" in schema_inputs:
        raise SystemExit("旧 target_pixels 参数仍然存在")
    scale_options = list(schema_inputs["scale_type"].options)
    if "By Resolution" not in scale_options or "By Pixel Count" in scale_options:
        raise SystemExit(f"缩放模式没有正确切换为按分辨率：{scale_options}")
    if schema_inputs["pad_color"].default != "0,0,0":
        raise SystemExit("填充颜色默认值应为 0,0,0")
    if schema_inputs["mask_color"].default != "0,0,0":
        raise SystemExit("遮罩颜色默认值应为 0,0,0")
    if schema_inputs["mask_grow"].default != 0:
        raise SystemExit("遮罩扩展生长默认值应为 0")
    if schema_inputs["tol_ratio"].default != 0.8:
        raise SystemExit("tol_ratio 默认值应为 0.8")

    expected_sizes = [
        (("无", 1_000_000, 4.0, 1024, 1024, 32), (96, 64)),
        (("按图像比例", 1_000_000, 1.5, 1024, 1024, 32), (160, 96)),
        (("按目标宽度", 1_000_000, 1.0, 128, 1024, 32), (128, 96)),
        (("按目标高度", 1_000_000, 1.0, 1024, 128, 32), (192, 128)),
    ]
    for arguments, expected in expected_sizes:
        actual = image_module._calculate_target_size(96, 64, *arguments)
        if actual != expected:
            raise SystemExit(
                f"图像编辑缩放计算错误：{arguments[0]} 期望 {expected}，实际 {actual}"
            )

    resolution_cases = [
        ((1024, 1024, 512, 0.8), (512, 512, 512)),
        ((1024, 1024, 1024, 0.8), (1024, 1024, 1024)),
        ((1536, 1024, 1088, 0.8), (1344, 896, 1088)),
        ((1024, 1536, 1088, 0.8), (896, 1344, 1088)),
        ((1920, 1080, 1024, 0.8), (1376, 768, 1024)),
        ((96, 64, 1024, 0.8), (1248, 832, 1024)),
        ((1536, 1024, 2048, 0.8), (2496, 1664, 2048)),
        ((1536, 1024, 4096, 0.8), (5024, 3360, 4096)),
    ]
    for arguments, expected in resolution_cases:
        source_width, source_height, resolution, tol_ratio = arguments
        actual = image_module._calculate_final_target_size(
            source_width,
            source_height,
            "按分辨率",
            resolution,
            1.0,
            1024,
            1024,
            32,
            tol_ratio,
        )
        if actual != expected:
            raise SystemExit(
                f"按分辨率缩放错误：{source_width}x{source_height} @ "
                f"resolution={resolution} 期望 {expected}，实际 {actual}"
            )

    bluebox_path = (
        comfy_root
        / "custom_nodes"
        / "ComfyUI-BlueBox"
        / "nodes"
        / "cut_qwen_image_21.py"
    )
    bluebox_parity_count = 0
    if bluebox_path.is_file():
        bluebox_spec = importlib.util.spec_from_file_location(
            BLUEBOX_PROBE_MODULE_NAME,
            bluebox_path,
        )
        if bluebox_spec is None or bluebox_spec.loader is None:
            raise SystemExit(f"无法加载 BlueBox 对照节点：{bluebox_path}")
        bluebox_module = importlib.util.module_from_spec(bluebox_spec)
        sys.modules[BLUEBOX_PROBE_MODULE_NAME] = bluebox_module
        bluebox_spec.loader.exec_module(bluebox_module)

        for source_width, source_height, resolution, tol_ratio in (
            arguments for arguments, _ in resolution_cases
        ):
            (target_width, target_height), _ = bluebox_module._pick_target_size(
                source_width,
                source_height,
                resolution,
                tol_ratio,
            )
            target_width, target_height = bluebox_module._snap_fixed_point(
                target_width,
                target_height,
                resolution,
                tol_ratio,
                source_width,
                source_height,
            )
            actual = image_module._calculate_final_target_size(
                source_width,
                source_height,
                "按分辨率",
                resolution,
                1.0,
                1024,
                1024,
                32,
                tol_ratio,
            )
            if actual != (target_width, target_height, resolution):
                raise SystemExit(
                    "按分辨率结果与 BlueBox Cut 不一致："
                    f"{source_width}x{source_height} @ {resolution}，"
                    f"BlueBox={target_width}x{target_height}，实际={actual}"
                )
            bluebox_parity_count += 1

    tight_target = image_module._calculate_final_target_size(
        96,
        64,
        "按分辨率",
        1024,
        1.0,
        1024,
        1024,
        32,
        0.2,
    )
    wide_target = image_module._calculate_final_target_size(
        96,
        64,
        "按分辨率",
        1024,
        1.0,
        1024,
        1024,
        32,
        0.8,
    )
    if tight_target == wide_target:
        raise SystemExit("tol_ratio 没有改变 Cut 候选尺寸")
    for target in (tight_target, wide_target):
        target_width, target_height, target_resolution = target
        if target_resolution % 32:
            raise SystemExit(f"resolution 不是 32 的倍数：{target_resolution}")
        if qwen_module._qwen_resized_size(
            target_width,
            target_height,
            target_resolution,
        ) != (target_width, target_height):
            raise SystemExit(
                "图像编辑节点缩放结果不是不动点："
                f"{target_width}x{target_height} @ {target_resolution}"
            )

    invalid_resolutions = (0, 480, 545, 1050, 4128)
    for invalid_resolution in invalid_resolutions:
        try:
            image_module._calculate_final_target_size(
                1024,
                1024,
                "按分辨率",
                invalid_resolution,
                1.0,
                1024,
                1024,
                32,
                0.8,
            )
        except ValueError:
            continue
        raise SystemExit(f"非法 resolution 没有报错：{invalid_resolution}")

    pad_color = (12, 34, 56)
    parsed_pad_color = image_module._parse_background_color("#0c2238")
    if parsed_pad_color != pad_color:
        raise SystemExit(f"填充色解析错误：期望 {pad_color}，实际 {parsed_pad_color}")
    if image_module._parse_background_color("0,0,0") != (0, 0, 0):
        raise SystemExit("RGB 填充色 0,0,0 解析失败")

    source = torch.zeros((1, 64, 96, 3), dtype=torch.float32)
    source_mask = torch.zeros((1, 64, 96), dtype=torch.float32)
    modes = {
        "拉伸": "stretch",
        "居中裁剪": "crop",
        "填充 / 边缘填充": "pad",
    }
    combinations = 0
    for method in image_module.UPSCALE_METHODS:
        for mode_label, mode in modes.items():
            image, mask = image_module._resize_to_target(
                source,
                source_mask,
                64,
                64,
                method,
                mode_label,
                pad_color,
            )
            if image.shape != (1, 64, 64, 3) or mask.shape != (1, 64, 64):
                raise SystemExit(
                    f"{method}/{mode} 输出尺寸错误："
                    f"image={tuple(image.shape)}, mask={tuple(mask.shape)}"
                )
            if mode == "pad":
                expected_corner = torch.tensor(
                    [component / 255.0 for component in pad_color],
                    dtype=image.dtype,
                )
                if not torch.allclose(image[0, 0, 0], expected_corner):
                    raise SystemExit(f"{method}/pad 左上角填充色错误")
                if not torch.allclose(mask[0, 0, 0], torch.tensor(0.0)):
                    raise SystemExit(f"{method}/pad 填充区 MASK 应为 0")
            combinations += 1

    with tempfile.TemporaryDirectory(
        prefix=".dev_check_",
        dir=pack_root,
    ) as temp_name:
        temp_dir = Path(temp_name)
        recursive_dir = temp_dir / "input"
        nested_dir = recursive_dir / "image_astral" / "edited"
        nested_dir.mkdir(parents=True)
        (recursive_dir / "top.png").write_bytes(b"probe")
        (nested_dir / "nested.png").write_bytes(b"probe")
        (nested_dir / "ignore.txt").write_text("probe", encoding="utf-8")

        listed = image_module._list_input_images(str(recursive_dir))
        expected_list = ["image_astral/edited/nested.png", "top.png"]
        if listed != expected_list:
            raise SystemExit(f"递归图片列表错误：期望 {expected_list}，实际 {listed}")

        rgba = Image.new("RGBA", (80, 50), (210, 40, 30, 255))
        for y in range(50):
            for x in range(20):
                rgba.putpixel((x, y), (0, 0, 0, 0))
        image_path = temp_dir / "rgba_probe.png"
        rgba.save(image_path)

        with patch.object(
            image_module.folder_paths,
            "get_annotated_filepath",
            return_value=str(image_path),
        ):
            result = node_cls.execute(image_file="rgba_probe.png", scale_type="无")
            resolution_result = node_cls.execute(
                image_file="rgba_probe.png",
                scale_type="按分辨率",
                target_resolution=1088,
                tol_ratio=0.8,
            )
            string_false_result = node_cls.execute(
                image_file="rgba_probe.png",
                scale_type="无",
                mask_color="255,0,0",
                invert_mask="false",
            )

        output_values = tuple(result.args)
        if len(output_values) != 6:
            raise SystemExit(
                f"图像加载与编辑节点应返回 6 个输出，实际返回 {len(output_values)} 个"
            )
        image, mask, mask_image, width, height, resolution = output_values
        if (width, height) != (80, 50):
            raise SystemExit(f"无缩放模式没有保持原尺寸：{width}x{height}")
        if resolution != 512:
            raise SystemExit(f"无缩放模式 resolution 输出错误：{resolution}")
        if image.shape != (1, 50, 80, 3) or mask.shape != (1, 50, 80):
            raise SystemExit(
                f"RGBA 加载尺寸错误：image={tuple(image.shape)}, mask={tuple(mask.shape)}"
            )
        if mask[0, 25, 5] < 0.99 or mask[0, 25, 40] > 0.01:
            raise SystemExit("透明 Alpha 没有正确转换为 MASK")
        if mask_image.shape != (1, 50, 80, 3):
            raise SystemExit(f"遮罩图像输出形状错误：{tuple(mask_image.shape)}")
        if not torch.allclose(
            mask_image[0, 25, 5],
            torch.zeros(3, dtype=mask_image.dtype),
        ):
            raise SystemExit("默认黑色遮罩区域没有输出为 RGB 0,0,0")
        if not torch.allclose(
            mask_image[0, 25, 40],
            torch.ones(3, dtype=mask_image.dtype),
        ):
            raise SystemExit("默认非遮罩区域没有输出为白色")

        resolution_values = tuple(resolution_result.args)
        resolution_image, _, _, resolution_width, resolution_height, bucket = (
            resolution_values
        )
        if (resolution_width, resolution_height, bucket) != (1376, 864, 1088):
            raise SystemExit(
                "按分辨率 execute 输出错误："
                f"期望 1376x864 @ 1088，实际 "
                f"{resolution_width}x{resolution_height} @ {bucket}"
            )
        if resolution_image.shape != (1, 864, 1376, 3):
            raise SystemExit(
                f"按分辨率 execute 图像形状错误：{tuple(resolution_image.shape)}"
            )

        string_false_mask = tuple(string_false_result.args)[1]
        if (
            string_false_mask[0, 25, 5].item() < 0.99
            or string_false_mask[0, 25, 40].item() > 0.01
        ):
            raise SystemExit(
                '旧工作流的 invert_mask="false" 被误当成 True，导致遮罩全反转'
            )

    if image_module._coerce_bool("false") or not image_module._coerce_bool("true"):
        raise SystemExit("字符串布尔值解析错误")
    if image_module._coerce_bool("") or image_module._coerce_bool(None):
        raise SystemExit("空值没有被解析为 False")

    ring = torch.zeros((1, 9, 9), dtype=torch.float32)
    ring[:, 2:7, 2:7] = 1.0
    ring[:, 4, 4] = 0.0
    filled = image_module._apply_mask_controls(
        ring,
        invert_mask=False,
        fill_mask_holes=True,
        bevel_mask=False,
        mask_grow=0,
    )
    if filled[0, 4, 4].item() < 0.99:
        raise SystemExit("填充遮罩漏洞没有填上内部空洞")
    if filled[0, 0, 0].item() > 0.01 or filled[0, 8, 8].item() > 0.01:
        raise SystemExit("填充遮罩漏洞错误地填满了连接到画面边缘的背景")

    center = torch.zeros((1, 9, 9), dtype=torch.float32)
    center[:, 4, 4] = 1.0
    grown = image_module._apply_mask_controls(
        center,
        invert_mask=False,
        fill_mask_holes=False,
        bevel_mask=False,
        mask_grow=1,
    )
    if grown[0, 3, 3].item() < 0.99 or grown[0, 0, 0].item() > 0.01:
        raise SystemExit("遮罩扩展生长结果错误")

    inverted = image_module._apply_mask_controls(
        center,
        invert_mask=True,
        fill_mask_holes=False,
        bevel_mask=False,
        mask_grow=0,
    )
    if inverted[0, 4, 4].item() > 0.01 or inverted[0, 0, 0].item() < 0.99:
        raise SystemExit("反转遮罩结果错误")

    beveled = image_module._apply_mask_controls(
        ring,
        invert_mask=False,
        fill_mask_holes=False,
        bevel_mask=True,
        mask_grow=0,
    )
    edge_value = beveled[0, 1, 2].item()
    if not 0.0 < edge_value < 1.0:
        raise SystemExit(f"遮罩倒角没有产生柔和边缘：{edge_value}")

    colored = image_module._mask_to_rgb_image(center, (12, 34, 56))
    expected_color = torch.tensor(
        [12 / 255.0, 34 / 255.0, 56 / 255.0],
        dtype=colored.dtype,
    )
    if not torch.allclose(colored[0, 4, 4], expected_color):
        raise SystemExit("遮罩图像没有使用设置的颜色")

    return (
        f"{combinations} 种插值与缩放模式组合、递归子目录、Alpha MASK、"
        f"按分辨率与 BlueBox {bluebox_parity_count} 组对照、tol_ratio 不动点、"
        "resolution 输出、遮罩图像及四种遮罩参数通过"
    )


def main() -> int:
    default_comfy = os.environ.get("COMFYUI_DIR", str(Path.cwd()))
    parser = argparse.ArgumentParser(description="ComfyUI-Astral-Image 加载自检")
    parser.add_argument(
        "--comfy-root",
        default=default_comfy,
        help=f"ComfyUI 根目录（默认 {default_comfy}）",
    )
    args = parser.parse_args()

    pack_root = Path(__file__).resolve().parent
    comfy_root = Path(args.comfy_root).resolve()

    if not (comfy_root / "comfy_api").is_dir():
        raise SystemExit(f"这个目录不像 ComfyUI 根目录：{comfy_root}")

    sys.path.insert(0, str(comfy_root))

    print(f"[1/5] 节点包目录：{pack_root}")
    print(f"      ComfyUI 目录：{comfy_root}")

    pack = load_node_pack(pack_root)
    print("[2/5] 导入成功，没有语法 / 导入错误")

    node_ids = check_v3_entrypoint(pack)
    print(f"[3/5] V3 入口注册节点 {len(node_ids)} 个：{', '.join(node_ids)}")

    display = check_v2_mappings(pack)
    print(f"      V2 映射表正常：{', '.join(display.values())}")

    resolution_info = check_resolution_selector(pack)
    print(f"[4/5] 自定义图像尺寸选择器自检通过：{resolution_info}")

    editor_info = check_image_editor(pack, pack_root, comfy_root)
    print(f"[5/5] 图像加载与编辑节点自检通过：{editor_info}")

    print("\n全部通过，可以正常加载。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
