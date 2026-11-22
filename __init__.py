"""ComfyUI-Astral-Image —— xm 的 ComfyUI 图像节点包。

同时提供两套入口：
  * V3：``comfy_entrypoint`` + ``ComfyExtension``（ComfyUI 0.3.60+ 推荐方式）
  * V2：``NODE_CLASS_MAPPINGS``（旧版本 ComfyUI 兼容）
"""

from comfy_api.latest import ComfyExtension, io

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .nodes.image_editor import XMAstralImageLoadEditor
from .nodes.qwen21 import XMAstralRestoreImageSize
from .nodes.resolution import XMAstralResolutionSelector

__version__ = "0.4.1"

# web/js 目录下的 .js 会被 ComfyUI 自动当作前端扩展加载
WEB_DIRECTORY = "./web/js"


class AstralImageExtension(ComfyExtension):
    """V3 入口：向 ComfyUI 注册本节点包的全部节点。"""

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            XMAstralImageLoadEditor,
            XMAstralRestoreImageSize,
            XMAstralResolutionSelector,
        ]


async def comfy_entrypoint() -> AstralImageExtension:
    """ComfyUI 启动时调用的 V3 异步入口。"""
    return AstralImageExtension()


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "AstralImageExtension",
    "comfy_entrypoint",
    "__version__",
]
