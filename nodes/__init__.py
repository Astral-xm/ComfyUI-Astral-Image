"""V2 兼容导出：旧版 ComfyUI 通过 NODE_CLASS_MAPPINGS 加载节点。

新增节点时，除了在 ``get_node_list`` 里注册，也记得在这里补一行映射。
"""

from .image_editor import XMAstralImageLoadEditor
from .qwen21 import XMAstralRestoreImageSize
from .resolution import XMAstralResolutionSelector

NODE_CLASS_MAPPINGS = {
    "ImageLoadEditor": XMAstralImageLoadEditor,
    "RestoreImageSize": XMAstralRestoreImageSize,
    "ResolutionSelectLatent": XMAstralResolutionSelector,
    # Preserve old API ids while frontend workflows migrate to the new ids.
    "XMAstralImageLoadEditor": XMAstralImageLoadEditor,
    "XMAstralRestoreImageSize": XMAstralRestoreImageSize,
    "XMAstralResolutionSelector": XMAstralResolutionSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageLoadEditor": "Load Image & Edit",
    "RestoreImageSize": "Image Astral · Restore Image Size",
    "ResolutionSelectLatent": "ResolutionSelectLatent",
    "XMAstralImageLoadEditor": "Load Image & Edit",
    "XMAstralRestoreImageSize": "Image Astral · Restore Image Size",
    "XMAstralResolutionSelector": "ResolutionSelectLatent",
}
