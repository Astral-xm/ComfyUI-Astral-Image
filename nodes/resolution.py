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
CUSTOM_SIZE_MODE = "Custom Size"
# Older workflows saved the Chinese label as the combo value.
_LEGACY_CUSTOM_SIZE_MODES = {"custom size", "自定义宽高"}
ASPECT_RATIO_OPTIONS = [*ASPECT_RATIOS, CUSTOM_SIZE_MODE]


def _is_custom_size_mode(value: str) -> bool:
    return str(value).strip().lower() in _LEGACY_CUSTOM_SIZE_MODES


class XMAstralResolutionSelector(io.ComfyNode):
    """Calculate image dimensions and return a matching empty latent."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ResolutionSelectLatent",
            display_name="ResolutionSelectLatent",
            category="Image Astral/Size",
            description=(
                "Calculate output size from aspect ratio and megapixels, aligned "
                "to a multiple; or specify width and height manually and create "
                "an empty latent. "
                "Author: xm (ComfyUI-Astral-Image), do not remove this attribution."
            ),
            search_aliases=[
                "ResolutionSelectLatent",
                "resolution selector",
                "custom image size",
                "custom image dimensions",
                "empty latent",
            ],
            inputs=[
                io.Combo.Input(
                    "aspect_ratio",
                    display_name="Aspect Ratio",
                    options=ASPECT_RATIO_OPTIONS,
                    default="16:9 (Widescreen)",
                    tooltip=(
                        "Choose a preset aspect ratio; after selecting \"Custom Size\", "
                        "the width and height below are used directly and megapixels "
                        "and multiple are ignored."
                    ),
                ),
                io.Float.Input(
                    "megapixels",
                    display_name="Megapixels",
                    default=2.0,
                    min=0.1,
                    max=16.0,
                    step=0.1,
                    tooltip=(
                        "Target total pixels, where 1024 × 1024 equals 1.0 MP. "
                        "Ignored in Custom Size mode."
                    ),
                ),
                io.Int.Input(
                    "multiple",
                    display_name="Multiple",
                    default=32,
                    min=1,
                    max=256,
                    step=1,
                    tooltip=(
                        "After preset aspect-ratio calculation, round width and height "
                        "to a multiple of this value. Ignored in Custom Size mode."
                    ),
                ),
                io.Int.Input(
                    "width",
                    display_name="Width",
                    default=1024,
                    min=VAE_SCALE,
                    max=MAX_IMAGE_EDGE,
                    step=1,
                    tooltip=(
                        "Custom output width in px. Used as-is, without rounding or "
                        "alignment. Only shown and applied when Custom Size is selected."
                    ),
                ),
                io.Int.Input(
                    "height",
                    display_name="Height",
                    default=1024,
                    min=VAE_SCALE,
                    max=MAX_IMAGE_EDGE,
                    step=1,
                    tooltip=(
                        "Custom output height in px. Used as-is, without rounding or "
                        "alignment. Only shown and applied when Custom Size is selected."
                    ),
                ),
                io.Int.Input(
                    "batch_size",
                    display_name="Batch Size",
                    default=1,
                    min=1,
                    max=4096,
                    step=1,
                    tooltip="Latent batch size.",
                ),
            ],
            outputs=[
                io.Latent.Output(
                    display_name="Latent",
                    tooltip="Empty latent created at the final width and height, ready to connect to KSampler.",
                ),
                io.Int.Output(
                    display_name="Width",
                    tooltip="Final output width.",
                ),
                io.Int.Output(
                    display_name="Height",
                    tooltip="Final output height.",
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
            raise ValueError("Batch size must be greater than 0")

        if _is_custom_size_mode(aspect_ratio):
            final_width = int(width)
            final_height = int(height)
            if final_width < 1 or final_height < 1:
                raise ValueError("Width and height must be greater than 0")
        else:
            ratio = ASPECT_RATIOS.get(aspect_ratio)
            if ratio is None:
                raise ValueError(f"Unknown aspect ratio: {aspect_ratio}")
            if not math.isfinite(megapixels) or megapixels <= 0:
                raise ValueError("Megapixels must be greater than 0")
            if multiple < 1:
                raise ValueError("Multiple must be greater than 0")

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
