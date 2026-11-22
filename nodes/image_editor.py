"""Image loading, resizing, and editable preview support for Image Astral."""

from __future__ import annotations

import math
import os

import numpy as np
import torch
import torch.nn.functional as torch_functional
from PIL import Image, ImageDraw, ImageOps, ImageSequence

import comfy.utils
import folder_paths
import node_helpers
from comfy_api.latest import io

from .qwen21 import (
    BLOCK_SIZE,
    MIN_RESOLUTION,
    UPSCALE_METHODS,
    _parse_background_color,
    _resample_image,
    _resample_mask,
    _auto_resolution,
    pick_qwen21_fixed_point,
)


TARGET_RESOLUTION_MIN = MIN_RESOLUTION
TARGET_RESOLUTION_MAX = 4096
SCALE_TYPE_OPTIONS = [
    "无",
    "按分辨率",
    "按图像比例",
    "按目标宽度",
    "按目标高度",
]
EDGE_MODE_OPTIONS = ["拉伸", "居中裁剪", "填充 / 边缘填充"]

_SCALE_TYPE_ALIASES = {
    "无": "none",
    "none": "none",
    "按分辨率": "resolution",
    "分辨率": "resolution",
    "resolution": "resolution",
    "按图像比例": "scale",
    "图像比例": "scale",
    "比例": "scale",
    "scale": "scale",
    "按目标宽度": "width",
    "目标宽度": "width",
    "width": "width",
    "按目标高度": "height",
    "目标高度": "height",
    "height": "height",
}

_EDGE_MODE_ALIASES = {
    "拉伸": "stretch",
    "stretch": "stretch",
    "居中裁剪": "crop",
    "中心裁剪": "crop",
    "crop": "crop",
    "center_crop": "crop",
    "填充 / 边缘填充": "pad",
    "填充/边缘填充": "pad",
    "填充": "pad",
    "边缘填充": "pad",
    "pad": "pad",
}


def _normalize_choice(value: str, aliases: dict[str, str], kind: str) -> str:
    normalized = aliases.get(str(value).strip().lower())
    if normalized is None:
        raise ValueError(f"未知{kind}：{value}")
    return normalized


def _coerce_bool(value: object) -> bool:
    """Parse booleans from old workflows that serialized widgets as strings."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"", "0", "false", "no", "off", "none", "null"}:
            return False
    return bool(value)


def _list_input_images(input_dir: str | None = None) -> list[str]:
    """List images in input recursively and return ComfyUI-style paths."""
    directory = input_dir or folder_paths.get_input_directory()
    if not os.path.isdir(directory):
        return []

    files, _ = folder_paths.recursive_search(directory)
    image_files = folder_paths.filter_files_content_types(files, ["image"])
    return sorted(path.replace("\\", "/") for path in image_files)


def _round_to_multiple(value: float, factor: int) -> int:
    if factor <= 1:
        return max(1, int(round(value)))
    return max(factor, int(math.floor(value / factor + 0.5)) * factor)


def _calculate_target_size(
    width: int,
    height: int,
    scale_type: str,
    target_resolution: int,
    target_scale: float,
    target_width: int,
    target_height: int,
    alignment_factor: int,
) -> tuple[int, int]:
    """Calculate the aligned target size without touching image data."""
    kind = _normalize_choice(scale_type, _SCALE_TYPE_ALIASES, "缩放类型")
    if kind == "none":
        return width, height

    ratio = width / height
    if kind == "resolution":
        return width, height
    if kind == "scale":
        if target_scale <= 0:
            raise ValueError("缩放倍率必须大于 0")
        ideal_width = width * target_scale
        ideal_height = height * target_scale
    elif kind == "width":
        if target_width < 1:
            raise ValueError("目标宽度必须大于 0")
        ideal_width = float(target_width)
        ideal_height = target_width / ratio
    else:
        if target_height < 1:
            raise ValueError("目标高度必须大于 0")
        ideal_height = float(target_height)
        ideal_width = target_height * ratio

    factor = max(1, int(alignment_factor))
    return (
        _round_to_multiple(ideal_width, factor),
        _round_to_multiple(ideal_height, factor),
    )


def _calculate_final_target_size(
    width: int,
    height: int,
    scale_type: str,
    target_resolution: int,
    target_scale: float,
    target_width: int,
    target_height: int,
    alignment_factor: int,
    tol_ratio: float,
) -> tuple[int, int, int]:
    """Resolve the displayed dimensions and the Qwen resolution bucket."""
    kind = _normalize_choice(scale_type, _SCALE_TYPE_ALIASES, "缩放类型")
    if kind == "none":
        return width, height, _auto_resolution(width, height)
    if kind == "resolution":
        resolution = int(target_resolution)
        if (
            resolution < TARGET_RESOLUTION_MIN
            or resolution > TARGET_RESOLUTION_MAX
            or resolution % BLOCK_SIZE
        ):
            raise ValueError(
                f"resolution 必须是 {TARGET_RESOLUTION_MIN}–"
                f"{TARGET_RESOLUTION_MAX} 之间、"
                f"{BLOCK_SIZE} 的正整数倍"
            )
        fixed = pick_qwen21_fixed_point(
            width,
            height,
            resolution=resolution,
            tol_ratio=tol_ratio,
            block_size=alignment_factor,
        )
        return fixed.width, fixed.height, fixed.resolution

    requested_width, requested_height = _calculate_target_size(
        width,
        height,
        scale_type,
        target_resolution,
        target_scale,
        target_width,
        target_height,
        alignment_factor,
    )
    fixed = pick_qwen21_fixed_point(
        requested_width,
        requested_height,
        resolution=_auto_resolution(requested_width, requested_height),
        tol_ratio=tol_ratio,
        block_size=alignment_factor,
    )
    return fixed.width, fixed.height, fixed.resolution


def _frame_mask(frame: Image.Image) -> torch.Tensor:
    if "A" not in frame.getbands():
        return torch.zeros((frame.height, frame.width), dtype=torch.float32)
    alpha = np.asarray(frame.getchannel("A"), dtype=np.float32) / 255.0
    return torch.from_numpy(1.0 - alpha)


def _load_image_file(image_file: str) -> tuple[torch.Tensor, torch.Tensor, str]:
    image_path = folder_paths.get_annotated_filepath(image_file)
    source = node_helpers.pillow(Image.open, image_path)
    images: list[torch.Tensor] = []
    masks: list[torch.Tensor] = []
    expected_size: tuple[int, int] | None = None

    try:
        for frame in ImageSequence.Iterator(source):
            frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
            size = frame.size
            if expected_size is None:
                expected_size = size
            elif size != expected_size:
                # Match ComfyUI's LoadImage behavior for multi-frame files whose
                # later frames have a different size.
                continue

            rgb = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255.0
            images.append(torch.from_numpy(rgb).unsqueeze(0))
            masks.append(_frame_mask(frame).unsqueeze(0))
    finally:
        source.close()

    if not images:
        raise ValueError(f"图片没有可读取的帧：{image_path}")

    return torch.cat(images, dim=0), torch.cat(masks, dim=0), image_path


def _resize_rgb_pad(
    image: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
    pad_color: tuple[int, int, int],
) -> torch.Tensor:
    """Fit an RGB image inside the target and fill the remaining area."""
    source_height, source_width = image.shape[1], image.shape[2]
    scale = min(width / source_width, height / source_height)
    resized_width = max(1, min(width, int(round(source_width * scale))))
    resized_height = max(1, min(height, int(round(source_height * scale))))
    resized = _resample_image(image, resized_width, resized_height, upscale_method)

    canvas = torch.empty(
        (image.shape[0], height, width, image.shape[-1]),
        dtype=image.dtype,
        device=image.device,
    )
    color = torch.tensor(
        [component / 255.0 for component in pad_color],
        dtype=image.dtype,
        device=image.device,
    )
    canvas[..., :3] = color
    if image.shape[-1] > 3:
        canvas[..., 3:] = 0.0

    left = (width - resized_width) // 2
    top = (height - resized_height) // 2
    canvas[
        :,
        top : top + resized_height,
        left : left + resized_width,
        :,
    ] = resized
    return canvas


def _resize_mask_pad(
    mask: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
) -> torch.Tensor:
    source_height, source_width = mask.shape[1], mask.shape[2]
    scale = min(width / source_width, height / source_height)
    resized_width = max(1, min(width, int(round(source_width * scale))))
    resized_height = max(1, min(height, int(round(source_height * scale))))
    resized = _resample_mask(mask, resized_width, resized_height, upscale_method)

    canvas = torch.zeros(
        (mask.shape[0], height, width),
        dtype=mask.dtype,
        device=mask.device,
    )
    left = (width - resized_width) // 2
    top = (height - resized_height) // 2
    canvas[
        :,
        top : top + resized_height,
        left : left + resized_width,
    ] = resized
    return canvas


def _resize_to_target(
    image: torch.Tensor,
    mask: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
    edge_mode: str,
    pad_color: tuple[int, int, int],
) -> tuple[torch.Tensor, torch.Tensor]:
    kind = _normalize_choice(edge_mode, _EDGE_MODE_ALIASES, "缩放模式")
    if kind in ("stretch", "crop"):
        crop = "center" if kind == "crop" else "disabled"
        image = comfy.utils.common_upscale(
            image.movedim(-1, 1),
            width,
            height,
            upscale_method,
            crop,
        ).movedim(1, -1)
        mask = comfy.utils.common_upscale(
            mask.unsqueeze(1),
            width,
            height,
            upscale_method,
            crop,
        ).squeeze(1)
        return image, mask

    return (
        _resize_rgb_pad(image, width, height, upscale_method, pad_color),
        _resize_mask_pad(mask, width, height, upscale_method),
    )


def _fill_mask_holes(mask: torch.Tensor) -> torch.Tensor:
    """Fill zero-valued islands that do not touch the image border."""
    filled_frames: list[np.ndarray] = []
    for frame in mask.detach().to(device="cpu").numpy():
        binary = frame >= 0.5
        # White is mask, black is background. Flood-fill black regions connected
        # to the border with grey; any black pixels left afterwards are holes.
        # Image.fromarray() can return a read-only image. ImageDraw.floodfill()
        # then fails silently without changing any pixels, which makes every
        # background pixel look like an enclosed hole. Keep a writable copy.
        flood = Image.fromarray(
            np.where(binary, 255, 0).astype(np.uint8),
        ).copy()
        width, height = flood.size
        border_points = (
            [(x, 0) for x in range(width)]
            + [(x, height - 1) for x in range(width)]
            + [(0, y) for y in range(1, height - 1)]
            + [(width - 1, y) for y in range(1, height - 1)]
        )
        pixels = flood.load()
        for point in border_points:
            if pixels[point] != 0:
                continue
            ImageDraw.floodfill(flood, point, 128, thresh=0)

        flooded = np.asarray(flood, dtype=np.uint8)
        holes = flooded == 0
        filled_frames.append(np.logical_or(binary, holes))

    result = torch.from_numpy(np.stack(filled_frames)).to(
        dtype=mask.dtype,
        device=mask.device,
    )
    return result


def _grow_mask(mask: torch.Tensor, amount: int) -> torch.Tensor:
    """Dilate a positive mask; negative values perform erosion."""
    strength = abs(int(amount))
    if strength == 0:
        return mask
    kernel_size = strength * 2 + 1
    values = mask.unsqueeze(1).to(dtype=torch.float32)
    if amount > 0:
        values = torch_functional.max_pool2d(
            values,
            kernel_size=kernel_size,
            stride=1,
            padding=strength,
        )
    else:
        values = -torch_functional.max_pool2d(
            -values,
            kernel_size=kernel_size,
            stride=1,
            padding=strength,
        )
    return values.squeeze(1).to(dtype=mask.dtype).clamp_(0.0, 1.0)


def _bevel_mask(mask: torch.Tensor) -> torch.Tensor:
    """Soften mask edges by one pixel while preserving border coverage."""
    values = mask.unsqueeze(1).to(dtype=torch.float32)
    values = torch_functional.pad(values, (1, 1, 1, 1), mode="replicate")
    values = torch_functional.avg_pool2d(values, kernel_size=3, stride=1)
    return values.squeeze(1).to(dtype=mask.dtype).clamp_(0.0, 1.0)


def _apply_mask_controls(
    mask: torch.Tensor,
    *,
    invert_mask: bool,
    fill_mask_holes: bool,
    bevel_mask: bool,
    mask_grow: int,
) -> torch.Tensor:
    result = mask
    if invert_mask:
        result = 1.0 - result
    if fill_mask_holes:
        result = _fill_mask_holes(result)
    if mask_grow:
        result = _grow_mask(result, mask_grow)
    if bevel_mask:
        result = _bevel_mask(result)
    return result.clamp_(0.0, 1.0)


def _mask_to_rgb_image(
    mask: torch.Tensor,
    color: tuple[int, int, int],
) -> torch.Tensor:
    """Render mask pixels in the selected RGB color on a white background."""
    rgb = torch.tensor(
        [component / 255.0 for component in color],
        dtype=mask.dtype,
        device=mask.device,
    )
    mask_values = mask.unsqueeze(-1)
    return (1.0 + mask_values * (rgb - 1.0)).clamp_(0.0, 1.0)


class XMAstralImageLoadEditor(io.ComfyNode):
    """Load an image, optionally resize it, and provide an editable preview."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        input_dir = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        image_files = _list_input_images(input_dir)

        return io.Schema(
            node_id="ImageLoadEditor",
            display_name="加载图像与编辑",
            category="Image Astral",
            description=(
                "上传并预览图片，可裁剪和旋转；支持按分辨率、倍率、"
                "宽度或高度缩放，以及对齐、裁切和补边。"
                "作者：xm（ComfyUI-Astral-Image），禁止移除本署名。"
            ),
            search_aliases=[
                "image load edit",
                "image editor",
                "crop rotate",
                "图像编辑",
                "图像加载",
                "裁剪旋转",
            ],
            inputs=[
                io.Combo.Input(
                    "image_file",
                    display_name="加载图像",
                    options=image_files,
                    default=image_files[0] if image_files else None,
                    upload=io.UploadType.image,
                    image_folder=io.FolderType.input,
                    tooltip="从 ComfyUI input 目录选择或上传图片。",
                ),
                io.Combo.Input(
                    "scale_type",
                    display_name="缩放",
                    options=SCALE_TYPE_OPTIONS,
                    default="无",
                    tooltip="选择缩放依据；下方只显示当前类型对应的目标值。",
                ),
                io.Int.Input(
                    "target_resolution",
                    display_name="分辨率",
                    default=1024,
                    min=TARGET_RESOLUTION_MIN,
                    max=TARGET_RESOLUTION_MAX,
                    step=BLOCK_SIZE,
                    tooltip=(
                        "直接输入 Qwen-Image 2.1 的 resolution 档位，"
                        f"范围 {TARGET_RESOLUTION_MIN}–{TARGET_RESOLUTION_MAX}，"
                        f"步进 {BLOCK_SIZE}。"
                    ),
                ),
                io.Float.Input(
                    "target_scale",
                    display_name="缩放目标值",
                    default=1.0,
                    min=0.01,
                    max=16.0,
                    step=0.01,
                    tooltip="宽高同时缩放的倍率，例如 1.5 表示放大到 150%。",
                ),
                io.Int.Input(
                    "target_width",
                    display_name="缩放目标值",
                    default=1024,
                    min=1,
                    max=65_536,
                    step=1,
                    tooltip="目标宽度，高度按原图宽高比自动计算。",
                ),
                io.Int.Input(
                    "target_height",
                    display_name="缩放目标值",
                    default=1024,
                    min=1,
                    max=65_536,
                    step=1,
                    tooltip="目标高度，宽度按原图宽高比自动计算。",
                ),
                io.Combo.Input(
                    "upscale_method",
                    display_name="缩放算法",
                    options=UPSCALE_METHODS,
                    default="lanczos",
                    tooltip="nearest-exact / bilinear / area / bicubic / lanczos。",
                ),
                io.Int.Input(
                    "alignment_factor",
                    display_name="对齐因数",
                    default=32,
                    min=1,
                    max=256,
                    step=1,
                    tooltip="最终宽高取该值的整数倍；1 表示不对齐。",
                ),
                io.Float.Input(
                    "tol_ratio",
                    display_name="tol_ratio",
                    default=0.8,
                    min=0.2,
                    max=3.0,
                    step=0.1,
                    tooltip=(
                        "仅缩放时生效。在 resolution 面积桶附近搜索候选尺寸；"
                        "值越大允许的面积偏差越大，默认 0.8。"
                    ),
                ),
                io.Combo.Input(
                    "edge_mode",
                    display_name="缩放模式",
                    options=EDGE_MODE_OPTIONS,
                    default="拉伸",
                    tooltip="处理对齐后产生的多余或残缺像素。",
                ),
                io.String.Input(
                    "pad_color",
                    display_name="填充颜色",
                    default="0,0,0",
                    tooltip="仅填充模式使用；默认 0,0,0，也支持 #RRGGBB 和颜色名。",
                ),
                io.String.Input(
                    "mask_color",
                    display_name="遮罩颜色",
                    default="0,0,0",
                    tooltip="遮罩图像输出中遮罩区域使用的 RGB 颜色。",
                ),
                io.Boolean.Input(
                    "fill_mask_holes",
                    display_name="填充遮罩漏洞",
                    default=False,
                    tooltip="填充没有连接到画面边缘的遮罩内部空洞。",
                ),
                io.Boolean.Input(
                    "bevel_mask",
                    display_name="遮罩倒角",
                    default=False,
                    tooltip="对遮罩边缘做 1 像素柔和过渡。",
                ),
                io.Boolean.Input(
                    "invert_mask",
                    display_name="反转遮罩",
                    default=False,
                    tooltip="交换遮罩的选中和未选中区域。",
                ),
                io.Int.Input(
                    "mask_grow",
                    display_name="遮罩扩展生长",
                    default=0,
                    min=-256,
                    max=256,
                    step=1,
                    tooltip="正数扩展遮罩，负数收缩遮罩，0 表示不改变。",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Mask.Output(display_name="mask"),
                io.Image.Output(display_name="mask_image"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(
                    display_name="resolution",
                    tooltip="按最终尺寸自动解析的 Qwen resolution 档位。",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        image_file: str,
        scale_type: str = "无",
        target_resolution: int = 1024,
        target_scale: float = 1.0,
        target_width: int = 1024,
        target_height: int = 1024,
        upscale_method: str = "lanczos",
        alignment_factor: int = 32,
        tol_ratio: float = 0.8,
        edge_mode: str = "拉伸",
        pad_color: str = "0,0,0",
        mask_color: str = "0,0,0",
        fill_mask_holes: bool = False,
        bevel_mask: bool = False,
        invert_mask: bool = False,
        mask_grow: int = 0,
    ) -> io.NodeOutput:
        if not image_file:
            raise ValueError("请先选择或上传图片")
        if upscale_method not in UPSCALE_METHODS:
            raise ValueError(f"未知缩放算法：{upscale_method}")
        if alignment_factor < 1:
            raise ValueError("对齐因数必须大于等于 1")
        if not math.isfinite(tol_ratio) or tol_ratio <= 0:
            raise ValueError("tol_ratio 必须大于 0")

        image, mask, _ = _load_image_file(image_file)
        original_height, original_width = image.shape[1], image.shape[2]
        width, height, resolution = _calculate_final_target_size(
            original_width,
            original_height,
            scale_type,
            target_resolution,
            target_scale,
            target_width,
            target_height,
            alignment_factor,
            tol_ratio,
        )

        normalized_scale_type = _normalize_choice(
            scale_type,
            _SCALE_TYPE_ALIASES,
            "缩放类型",
        )
        if normalized_scale_type != "none":
            parsed_pad_color = _parse_background_color(pad_color) or (0, 0, 0)
            image, mask = _resize_to_target(
                image,
                mask,
                width,
                height,
                upscale_method,
                edge_mode,
                parsed_pad_color,
            )

        parsed_mask_color = _parse_background_color(mask_color) or (0, 0, 0)
        mask = _apply_mask_controls(
            mask,
            invert_mask=_coerce_bool(invert_mask),
            fill_mask_holes=_coerce_bool(fill_mask_holes),
            bevel_mask=_coerce_bool(bevel_mask),
            mask_grow=int(mask_grow),
        )
        mask_image = _mask_to_rgb_image(mask, parsed_mask_color)
        return io.NodeOutput(image, mask, mask_image, width, height, resolution)

    @classmethod
    def validate_inputs(cls, image_file=None, **kwargs) -> bool | str:
        if not image_file:
            return "请先选择或上传图片"
        if not folder_paths.exists_annotated_filepath(image_file):
            return f"找不到图片文件：{image_file}"
        return True

    @classmethod
    def fingerprint_inputs(
        cls,
        image_file=None,
        scale_type="无",
        target_resolution=1024,
        target_scale=1.0,
        target_width=1024,
        target_height=1024,
        upscale_method="lanczos",
        alignment_factor=32,
        tol_ratio=0.8,
        edge_mode="拉伸",
        pad_color="0,0,0",
        mask_color="0,0,0",
        fill_mask_holes=False,
        bevel_mask=False,
        invert_mask=False,
        mask_grow=0,
        **kwargs,
    ):
        if not image_file:
            return (image_file,)
        image_path = folder_paths.get_annotated_filepath(image_file)
        stat = os.stat(image_path)
        return (
            image_path,
            stat.st_mtime_ns,
            stat.st_size,
            scale_type,
            target_resolution,
            target_scale,
            target_width,
            target_height,
            upscale_method,
            alignment_factor,
            tol_ratio,
            edge_mode,
            pad_color,
            mask_color,
            fill_mask_holes,
            bevel_mask,
            invert_mask,
            mask_grow,
        )


__all__ = ["XMAstralImageLoadEditor"]
