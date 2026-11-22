"""Shared Qwen-Image 2.1 sizing helpers and image-size restoration."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageColor, ImageOps, ImageSequence

import comfy.utils
import folder_paths
import node_helpers
from comfy_api.latest import io


BLOCK_SIZE = 32
MIN_RESOLUTION = 512
MAX_RESOLUTION = 2048
UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
RESIZE_MODE_OPTIONS = ["stretch", "crop", "pad"]
MASK_CHANNEL_OPTIONS = ["alpha", "red", "green", "blue"]
RESOLUTION_OPTIONS = ["default"] + [
    str(value) for value in range(MIN_RESOLUTION, MAX_RESOLUTION + 1, BLOCK_SIZE)
]

_STANDARD_RATIOS = (
    1.0,
    4.0 / 3.0,
    3.0 / 4.0,
    16.0 / 9.0,
    9.0 / 16.0,
    3.0 / 2.0,
    2.0 / 3.0,
)


@dataclass(frozen=True)
class FixedPoint:
    width: int
    height: int
    resolution: int


def _qwen_resized_size(width: int, height: int, resolution: int) -> tuple[int, int]:
    """Reproduce the resize performed by TextEncodeQwenImage21."""
    if resolution <= 0:
        return (
            max(BLOCK_SIZE, round(width / BLOCK_SIZE) * BLOCK_SIZE),
            max(BLOCK_SIZE, round(height / BLOCK_SIZE) * BLOCK_SIZE),
        )

    ratio = width / height
    resized_width = round(math.sqrt(resolution * resolution * ratio) / BLOCK_SIZE) * BLOCK_SIZE
    resized_height = round(math.sqrt(resolution * resolution / ratio) / BLOCK_SIZE) * BLOCK_SIZE
    return max(BLOCK_SIZE, resized_width), max(BLOCK_SIZE, resized_height)


def _auto_resolution(width: int, height: int) -> int:
    target = round(math.sqrt(width * height) / BLOCK_SIZE) * BLOCK_SIZE
    return max(MIN_RESOLUTION, min(MAX_RESOLUTION, target))


def _log_ratio_distance(a: float, b: float) -> float:
    return abs(math.log(a / b))


@lru_cache(maxsize=128)
def _candidate_sizes(
    resolution: int,
    tolerance: int,
    block_size: int = BLOCK_SIZE,
) -> tuple[tuple[int, int, float], ...]:
    """List Cut-style candidate sizes near the chosen area budget."""
    cells = resolution // BLOCK_SIZE
    target_area = resolution * resolution
    tolerance_area = tolerance * BLOCK_SIZE * BLOCK_SIZE
    candidates: set[tuple[int, int, float]] = set()

    # For every candidate width, only the nearest one or two aligned heights can
    # fall inside the Cut tolerance interval. This is equivalent to Cut's full
    # k x m scan for block_size=32, but also works for custom alignment factors.
    max_width_blocks = max(1, (resolution * 3) // block_size)
    for width_blocks in range(1, max_width_blocks + 1):
        width = width_blocks * block_size
        min_height = max(
            block_size,
            math.ceil(
                (target_area - tolerance_area)
                / width
                / block_size
            )
            * block_size,
        )
        max_height = min(
            resolution * 3,
            math.floor(
                (target_area + tolerance_area)
                / width
                / block_size
            )
            * block_size,
        )
        for height in range(min_height, max_height + 1, block_size):
            area_delta = width * height - target_area
            candidates.add(
                (
                    width,
                    height,
                    abs(area_delta) / target_area,
                )
            )

    return tuple(sorted(candidates))


def pick_qwen21_fixed_point(
    width: int,
    height: int,
    resolution: str | int | None = "default",
    tol_ratio: float = 0.8,
    block_size: int = BLOCK_SIZE,
) -> FixedPoint:
    """Choose a target size that the Qwen text encoder will not resize again."""
    if width < 1 or height < 1:
        raise ValueError("宽高必须大于 0")
    if not math.isfinite(tol_ratio) or tol_ratio <= 0:
        raise ValueError("tol_ratio 必须大于 0")
    block_size = max(1, int(block_size))
    resolved_resolution = (
        _auto_resolution(width, height)
        if resolution in (None, "", "default")
        else int(resolution)
    )
    if resolved_resolution < BLOCK_SIZE or resolved_resolution % BLOCK_SIZE:
        raise ValueError("resolution 必须是 32 的正整数倍数")

    cells = resolved_resolution // BLOCK_SIZE
    tolerance = max(1, int(cells * tol_ratio))
    candidates = _candidate_sizes(resolved_resolution, tolerance, block_size)
    if not candidates:
        raise ValueError(
            f"resolution={resolved_resolution}, tol_ratio={tol_ratio:g}, "
            f"alignment_factor={block_size} 找不到候选尺寸"
        )
    input_ratio = width / height

    def score(candidate: tuple[int, int, float]) -> tuple[float, int, int]:
        candidate_width, candidate_height, area_error = candidate
        candidate_ratio = candidate_width / candidate_height
        ratio_error = _log_ratio_distance(candidate_ratio, input_ratio)
        standard_error = min(
            _log_ratio_distance(candidate_ratio, standard_ratio)
            for standard_ratio in _STANDARD_RATIOS
        )
        total = ratio_error + standard_error * 0.6 + area_error * 0.4
        return total, candidate_width, candidate_height

    target_width, target_height, _ = min(candidates, key=score)
    if _qwen_resized_size(target_width, target_height, resolved_resolution) != (
        target_width,
        target_height,
    ):
        # V2 first picks by visual/area score, then falls back to the fixed-point
        # candidate whose aspect ratio is closest to the input.
        fixed_candidates = [
            candidate
            for candidate in candidates
            if _qwen_resized_size(
                candidate[0],
                candidate[1],
                resolved_resolution,
            )
            == candidate[:2]
        ]
        if not fixed_candidates:
            raise ValueError(f"resolution={resolved_resolution} 找不到不动点尺寸")
        target_width, target_height, _ = min(
            fixed_candidates,
            key=lambda candidate: _log_ratio_distance(
                candidate[0] / candidate[1],
                input_ratio,
            ),
        )

    return FixedPoint(target_width, target_height, resolved_resolution)


def _parse_background_color(value: str) -> tuple[int, int, int] | None:
    value = value.strip()
    if not value:
        return None

    try:
        components = [int(component.strip()) for component in value.split(",")]
        if len(components) in (3, 4) and all(0 <= component <= 255 for component in components):
            return tuple(components[:3])
    except ValueError:
        pass

    try:
        return ImageColor.getrgb(value)[:3]
    except ValueError as error:
        raise ValueError(f"无法识别背景色 {value!r}，请使用 #RRGGBB、颜色名或 R,G,B") from error


def _frame_mask(frame: Image.Image, mask_channel: str) -> torch.Tensor:
    channel = mask_channel.upper()[0]
    height, width = frame.height, frame.width
    if channel not in frame.getbands():
        return torch.zeros((height, width), dtype=torch.float32)

    mask = np.asarray(frame.getchannel(channel), dtype=np.float32) / 255.0
    if channel == "A":
        mask = 1.0 - mask
    return torch.from_numpy(mask)


def _load_image_file(
    image_file: str,
    mask_channel: str,
    background_color: str,
) -> tuple[torch.Tensor, torch.Tensor, str]:
    image_path = folder_paths.get_annotated_filepath(image_file)
    source = node_helpers.pillow(Image.open, image_path)
    background = _parse_background_color(background_color)
    images: list[torch.Tensor] = []
    masks: list[torch.Tensor] = []

    for frame in ImageSequence.Iterator(source):
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        mask = _frame_mask(frame, mask_channel)
        rgb = frame.convert("RGB")

        if background is not None and "A" in frame.getbands():
            canvas = Image.new("RGBA", rgb.size, background + (255,))
            rgb = Image.alpha_composite(canvas, frame.convert("RGBA")).convert("RGB")

        pixels = np.asarray(rgb, dtype=np.float32) / 255.0
        images.append(torch.from_numpy(pixels).unsqueeze(0))
        masks.append(mask.unsqueeze(0))

    if not images:
        raise ValueError(f"图片没有可读取的帧：{image_path}")

    image = torch.cat(images, dim=0)
    mask = torch.cat(masks, dim=0)
    return image, mask, image_path


def _prepare_connected_image(
    image: torch.Tensor,
    mask: torch.Tensor | None,
    background_color: str,
) -> tuple[torch.Tensor, torch.Tensor, str]:
    if image.ndim != 4:
        raise ValueError("IMAGE 必须是 [batch, height, width, channels] 张量")

    source_mask = mask
    if source_mask is None and image.shape[-1] >= 4:
        source_mask = 1.0 - image[..., 3]
    if source_mask is None:
        source_mask = torch.zeros(
            (image.shape[0], image.shape[1], image.shape[2]),
            dtype=image.dtype,
            device=image.device,
        )

    background = _parse_background_color(background_color)
    if background is not None and image.shape[-1] >= 4:
        color = torch.tensor(
            [component / 255.0 for component in background],
            dtype=image.dtype,
            device=image.device,
        )
        alpha = image[..., 3:4]
        image = image[..., :3] * alpha + color * (1.0 - alpha)

    return image, source_mask, "<connected image>"


def _resample_image(
    image: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
) -> torch.Tensor:
    resized = comfy.utils.common_upscale(
        image.movedim(-1, 1),
        width,
        height,
        upscale_method,
        "disabled",
    )
    return resized.movedim(1, -1)


def _resample_mask(
    mask: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
) -> torch.Tensor:
    return comfy.utils.common_upscale(
        mask.unsqueeze(1),
        width,
        height,
        upscale_method,
        "disabled",
    ).squeeze(1)


def _resize_image_to_grid(
    image: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
    resize_mode: str,
    pad_color: float,
) -> torch.Tensor:
    if resize_mode in ("stretch", "crop"):
        crop = "center" if resize_mode == "crop" else "disabled"
        resized = comfy.utils.common_upscale(
            image.movedim(-1, 1),
            width,
            height,
            upscale_method,
            crop,
        )
        return resized.movedim(1, -1)

    source_height, source_width = image.shape[1], image.shape[2]
    scale = min(width / source_width, height / source_height)
    resized_width = max(1, round(source_width * scale))
    resized_height = max(1, round(source_height * scale))
    resized = _resample_image(image, resized_width, resized_height, upscale_method)

    left = (width - resized_width) // 2
    right = width - resized_width - left
    top = (height - resized_height) // 2
    bottom = height - resized_height - top
    return F.pad(
        resized.movedim(-1, 1),
        (left, right, top, bottom),
        mode="constant",
        value=pad_color,
    ).movedim(1, -1)


def _resize_mask_to_grid(
    mask: torch.Tensor,
    width: int,
    height: int,
    upscale_method: str,
    resize_mode: str,
) -> torch.Tensor:
    if resize_mode in ("stretch", "crop"):
        crop = "center" if resize_mode == "crop" else "disabled"
        return comfy.utils.common_upscale(
            mask.unsqueeze(1),
            width,
            height,
            upscale_method,
            crop,
        ).squeeze(1)

    source_height, source_width = mask.shape[1], mask.shape[2]
    scale = min(width / source_width, height / source_height)
    resized_width = max(1, round(source_width * scale))
    resized_height = max(1, round(source_height * scale))
    resized = _resample_mask(mask, resized_width, resized_height, upscale_method)
    left = (width - resized_width) // 2
    right = width - resized_width - left
    top = (height - resized_height) // 2
    bottom = height - resized_height - top
    return F.pad(
        resized.unsqueeze(1),
        (left, right, top, bottom),
        mode="constant",
        value=0.0,
    ).squeeze(1)


class XMAstralQwen21LoadResize(io.ComfyNode):
    """Load an image and prepare it for Qwen-Image 2.1 zero-offset editing."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        input_dir = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        image_files = folder_paths.filter_files_content_types(os.listdir(input_dir), ["image"])
        image_files = sorted(name for name in image_files if os.path.isfile(os.path.join(input_dir, name)))

        return io.Schema(
            node_id="XMAstralQwen21LoadResize",
            display_name="Image Astral · Qwen 2.1 零偏移加载",
            category="Image Astral/Qwen",
            description="加载图片并对齐到 Qwen 2.1 的不动点尺寸；支持预放大、拉伸/裁切/补边和插值算法选择。作者：xm（ComfyUI-Astral-Image），禁止移除本署名。",
            search_aliases=["qwen zero offset", "qwen 2.1 load resize", "零偏移图像", "qwen fixed point"],
            inputs=[
                io.Combo.Input(
                    "image_file",
                    display_name="image",
                    options=image_files,
                    default=image_files[0] if image_files else None,
                    upload=io.UploadType.image,
                    image_folder=io.FolderType.input,
                    optional=True,
                    tooltip="从 ComfyUI input 目录选择或上传图片；连接下方 IMAGE 端口时优先使用端口。",
                ),
                io.Image.Input(
                    "image",
                    optional=True,
                    tooltip="可选 IMAGE 输入；连接后忽略 image_file。",
                ),
                io.Mask.Input(
                    "mask",
                    optional=True,
                    tooltip="可选 MASK 输入；未连接时从图片 Alpha 或所选通道读取。",
                ),
                io.Float.Input(
                    "input_scale",
                    display_name="input scale",
                    default=1.0,
                    min=0.01,
                    max=8.0,
                    step=0.01,
                    tooltip="固定网格处理前先按此倍率缩放，用于小图零变形放大。",
                ),
                io.Combo.Input(
                    "resolution",
                    options=RESOLUTION_OPTIONS,
                    default="default",
                    tooltip="default 根据输入面积自动选择；也可手动指定 512-2048。",
                ),
                io.Combo.Input(
                    "resize_mode",
                    options=RESIZE_MODE_OPTIONS,
                    default="stretch",
                    tooltip="stretch 可逆且适合 V2 流程；crop 居中裁切；pad 居中补边。",
                ),
                io.Combo.Input(
                    "upscale_method",
                    options=UPSCALE_METHODS,
                    default="lanczos",
                    tooltip="预放大和对齐固定网格时使用的插值算法。",
                ),
                io.Int.Input(
                    "repeat",
                    default=1,
                    min=1,
                    max=4096,
                    step=1,
                    tooltip="对对齐后的图像和遮罩做批次复制。",
                ),
                io.Combo.Input(
                    "mask_channel",
                    options=MASK_CHANNEL_OPTIONS,
                    default="alpha",
                    tooltip="从图片读取哪个通道作为遮罩。",
                ),
                io.String.Input(
                    "background_color",
                    default="",
                    tooltip="可填 #RRGGBB、颜色名或 R,G,B，用于 Alpha 合成；留空保持原样。",
                ),
                io.Float.Input(
                    "tol_ratio",
                    default=0.8,
                    min=0.2,
                    max=3.0,
                    step=0.1,
                    advanced=True,
                    tooltip="不动点尺寸搜索的面积容差。",
                ),
                io.Float.Input(
                    "pad_color",
                    default=0.0,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    advanced=True,
                    tooltip="resize_mode=pad 时的补边灰度值。",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Mask.Output(display_name="mask"),
                io.Int.Output(display_name="width", tooltip="送入 Qwen 的固定网格宽度。"),
                io.Int.Output(display_name="height", tooltip="送入 Qwen 的固定网格高度。"),
                io.Int.Output(display_name="resolution", tooltip="连接到 TextEncodeQwenImage21.resolution。"),
                io.Int.Output(display_name="restore_width", tooltip="生成后恢复到的宽度。"),
                io.Int.Output(display_name="restore_height", tooltip="生成后恢复到的高度。"),
                io.String.Output(display_name="image_path"),
            ],
        )

    @classmethod
    def execute(
        cls,
        image_file: str | None = None,
        image: torch.Tensor | None = None,
        mask: torch.Tensor | None = None,
        input_scale: float = 1.0,
        resolution: str | int = "default",
        resize_mode: str = "stretch",
        upscale_method: str = "lanczos",
        repeat: int = 1,
        mask_channel: str = "alpha",
        background_color: str = "",
        tol_ratio: float = 0.8,
        pad_color: float = 0.0,
    ) -> io.NodeOutput:
        if image is None:
            if not image_file:
                raise ValueError("请选择图片或连接 IMAGE 输入")
            image, mask, image_path = _load_image_file(
                image_file,
                mask_channel,
                background_color,
            )
        else:
            image, mask, image_path = _prepare_connected_image(
                image,
                mask,
                background_color,
            )

        if not 0.01 <= input_scale <= 8.0:
            raise ValueError("input_scale 必须在 0.01 到 8.0 之间")
        if resize_mode not in RESIZE_MODE_OPTIONS:
            raise ValueError(f"未知 resize_mode：{resize_mode}")
        if upscale_method not in UPSCALE_METHODS:
            raise ValueError(f"未知 upscale_method：{upscale_method}")

        source_height, source_width = image.shape[1], image.shape[2]
        restore_width = max(1, round(source_width * input_scale))
        restore_height = max(1, round(source_height * input_scale))
        if (restore_width, restore_height) != (source_width, source_height):
            image = _resample_image(image, restore_width, restore_height, upscale_method)
            mask = _resample_mask(mask, restore_width, restore_height, upscale_method)

        fixed = pick_qwen21_fixed_point(
            restore_width,
            restore_height,
            resolution=resolution,
            tol_ratio=tol_ratio,
        )
        image = _resize_image_to_grid(
            image,
            fixed.width,
            fixed.height,
            upscale_method,
            resize_mode,
            pad_color,
        )
        mask = _resize_mask_to_grid(
            mask,
            fixed.width,
            fixed.height,
            upscale_method,
            resize_mode,
        )

        if repeat > 1:
            image = image.repeat(repeat, 1, 1, 1)
            mask = mask.repeat(repeat, 1, 1)

        return io.NodeOutput(
            image,
            mask,
            fixed.width,
            fixed.height,
            fixed.resolution,
            restore_width,
            restore_height,
            image_path,
        )


class XMAstralRestoreImageSize(io.ComfyNode):
    """Restore a generated image to the requested dimensions."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="RestoreImageSize",
            display_name="Image Astral · 恢复图像尺寸",
            category="Image Astral/Qwen",
            description="把 Qwen 固定网格生成结果按指定宽高还原，默认使用 lanczos。作者：xm（ComfyUI-Astral-Image），禁止移除本署名。",
            search_aliases=["restore image size", "scale back", "恢复尺寸", "还原图像"],
            inputs=[
                io.Image.Input("image"),
                io.Int.Input("width", default=512, min=1, max=65536, step=1),
                io.Int.Input("height", default=512, min=1, max=65536, step=1),
                io.Combo.Input(
                    "upscale_method",
                    options=UPSCALE_METHODS,
                    default="lanczos",
                    tooltip="恢复原始宽高时使用的插值算法。",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="image"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
            ],
        )

    @classmethod
    def execute(
        cls,
        image: torch.Tensor,
        width: int,
        height: int,
        upscale_method: str = "lanczos",
    ) -> io.NodeOutput:
        if width < 1 or height < 1:
            raise ValueError("恢复尺寸必须大于 0")
        if upscale_method not in UPSCALE_METHODS:
            raise ValueError(f"未知 upscale_method：{upscale_method}")
        if image.shape[1] == height and image.shape[2] == width:
            restored = image
        else:
            restored = _resample_image(image, width, height, upscale_method)
        return io.NodeOutput(restored, width, height)


__all__ = [
    "XMAstralRestoreImageSize",
]
