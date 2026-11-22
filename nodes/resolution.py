"""Resolution selection and empty latent creation for Image Astral."""

from __future__ import annotations

import math

import comfy.model_management
import torch
from comfy_api.latest import io


MAX_IMAGE_EDGE = 16384
VAE_SCALE = 8

ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "8:5 (Widescreen)": (8, 5),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}
CUSTOM_SIZE_MODE = "自定义宽高"
ASPECT_RATIO_OPTIONS = [*ASPECT_RATIOS, CUSTOM_SIZE_MODE]


class XMAstralResolutionSelector(io.ComfyNode):
    """Calculate image dimensions and return a matching empty latent."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ResolutionSelectLatent",
            display_name="ResolutionSelectLatent",
            category="Image Astral/尺寸",
            description=(
                "按宽高比和百万像素计算输出尺寸，并按倍数对齐；"
                "也可手动指定宽高并创建空 Latent。"
                "作者：xm（ComfyUI-Astral-Image），禁止移除本署名。"
            ),
            search_aliases=[
                "ResolutionSelectLatent",
                "resolution selector",
                "custom image size",
                "自定义图像尺寸",
                "空 Latent",
            ],
            inputs=[
                io.Combo.Input(
                    "aspect_ratio",
                    display_name="宽高比",
                    options=ASPECT_RATIO_OPTIONS,
                    default="16:9 (Widescreen)",
                    tooltip=(
                        "选择预设宽高比；选择“自定义宽高”后直接使用下方的宽度和高度，"
                        "不再应用百万像素与倍数。"
                    ),
                ),
                io.Float.Input(
                    "megapixels",
                    display_name="百万像素",
                    default=2.0,
                    min=0.1,
                    max=16.0,
                    step=0.1,
                    tooltip=(
                        "目标总像素，按 1024 × 1024 为 1.0 MP 计算。"
                        "自定义宽高模式下忽略此参数。"
                    ),
                ),
                io.Int.Input(
                    "multiple",
                    display_name="倍数",
                    default=32,
                    min=1,
                    max=256,
                    step=1,
                    tooltip=(
                        "预设宽高比计算完成后，把宽和高取为该值的整数倍。"
                        "自定义宽高模式下忽略此参数。"
                    ),
                ),
                io.Int.Input(
                    "width",
                    display_name="宽度",
                    default=1024,
                    min=VAE_SCALE,
                    max=MAX_IMAGE_EDGE,
                    step=1,
                    tooltip=(
                        "自定义输出宽度，单位 px。该值原样输出，不取整、不对齐。"
                        "仅在选择“自定义宽高”时显示和生效。"
                    ),
                ),
                io.Int.Input(
                    "height",
                    display_name="高度",
                    default=1024,
                    min=VAE_SCALE,
                    max=MAX_IMAGE_EDGE,
                    step=1,
                    tooltip=(
                        "自定义输出高度，单位 px。该值原样输出，不取整、不对齐。"
                        "仅在选择“自定义宽高”时显示和生效。"
                    ),
                ),
                io.Int.Input(
                    "batch_size",
                    display_name="批次大小",
                    default=1,
                    min=1,
                    max=4096,
                    step=1,
                    tooltip="Latent 批次大小。",
                ),
            ],
            outputs=[
                io.Latent.Output(
                    display_name="Latent",
                    tooltip="按最终宽高创建的空 Latent，可直接连接 KSampler。",
                ),
                io.Int.Output(
                    display_name="宽度",
                    tooltip="最终输出宽度。",
                ),
                io.Int.Output(
                    display_name="高度",
                    tooltip="最终输出高度。",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        aspect_ratio: str,
        megapixels: float,
        multiple: int,
        width: int,
        height: int,
        batch_size: int,
    ) -> io.NodeOutput:
        if batch_size < 1:
            raise ValueError("批次大小必须大于 0")

        if aspect_ratio == CUSTOM_SIZE_MODE:
            final_width = int(width)
            final_height = int(height)
            if final_width < 1 or final_height < 1:
                raise ValueError("宽度和高度必须大于 0")
        else:
            ratio = ASPECT_RATIOS.get(aspect_ratio)
            if ratio is None:
                raise ValueError(f"未知宽高比：{aspect_ratio}")
            if not math.isfinite(megapixels) or megapixels <= 0:
                raise ValueError("百万像素必须大于 0")
            if multiple < 1:
                raise ValueError("倍数必须大于 0")

            ratio_width, ratio_height = ratio
            total_pixels = float(megapixels) * 1024 * 1024
            scale = math.sqrt(total_pixels / (ratio_width * ratio_height))
            final_width = round(ratio_width * scale / multiple) * multiple
            final_height = round(ratio_height * scale / multiple) * multiple

        latent_width = max(1, final_width // VAE_SCALE)
        latent_height = max(1, final_height // VAE_SCALE)
        latent = torch.zeros(
            (batch_size, 4, latent_height, latent_width),
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        return io.NodeOutput(
            {"samples": latent, "downscale_ratio_spacial": VAE_SCALE},
            final_width,
            final_height,
        )


__all__ = [
    "ASPECT_RATIOS",
    "ASPECT_RATIO_OPTIONS",
    "CUSTOM_SIZE_MODE",
    "XMAstralResolutionSelector",
]
