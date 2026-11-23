import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EDITOR_NODE_ID = "ImageLoadEditor";
const RESOLUTION_SELECTOR_NODE_ID = "ResolutionSelectLatent";
const LEGACY_NODE_TYPES = Object.freeze({
  XMAstralImageLoadEditor: EDITOR_NODE_ID,
  XMAstralRestoreImageSize: "RestoreImageSize",
  XMAstralResolutionSelector: RESOLUTION_SELECTOR_NODE_ID,
});
const CUSTOM_SIZE_MODE = "Custom Size";
const LEGACY_CUSTOM_SIZE_MODE = "自定义宽高";
const TARGET_WIDGETS = [
  "target_resolution",
  "target_scale",
  "target_width",
  "target_height",
];
const NATIVE_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";
const MASK_EDITOR_IMAGE_WIDGET = "image";
const PASTE_IMAGE_SUBFOLDER = "image_astral/pasted";
const EDITOR_OUTPUT_COUNT = 6;
const NODE_SIZE_VERSION = 2;
const NODE_SIZE_VERSION_PROPERTY = "xmAstralNodeSizeVersion";
const EDITOR_OUTPUTS = [
  { name: "image", type: "IMAGE" },
  { name: "mask", type: "MASK" },
  { name: "mask_image", type: "IMAGE" },
  { name: "width", type: "INT" },
  { name: "height", type: "INT" },
  { name: "resolution", type: "INT" },
];
const ORIGINAL_IMAGE_PROPERTY = "xmAstralOriginalImage";
const QWEN_BLOCK_SIZE = 32;
const MIN_QWEN_RESOLUTION = 512;
const MAX_QWEN_RESOLUTION = 2048;
const MAX_TARGET_RESOLUTION = 4096;
const QWEN_STANDARD_RATIOS = [
  1,
  4 / 3,
  3 / 4,
  16 / 9,
  9 / 16,
  3 / 2,
  2 / 3,
];
const MASK_PARAM_WIDGETS = [
  "mask_color",
  "fill_mask_holes",
  "bevel_mask",
  "invert_mask",
  "mask_grow",
];
const MASK_WIDGET_DEFAULTS = {
  mask_color: "0,0,0",
  fill_mask_holes: false,
  bevel_mask: false,
  invert_mask: false,
  mask_grow: 0,
};
const TOL_RATIO_TOOLTIP =
  "Only applies when scaling. Searches for candidate sizes near the resolution area bucket; larger values allow a bigger area deviation, default 0.8.";

const LEGACY_SCALE_TYPE_VALUES = {
  "无": "None",
  "按分辨率": "By Resolution",
  "按图像比例": "By Image Scale",
  "按目标宽度": "By Target Width",
  "按目标高度": "By Target Height",
  "按像素数量": "By Resolution",
};
const LEGACY_EDGE_MODE_VALUES = {
  "拉伸": "Stretch",
  "居中裁剪": "Center Crop",
  "填充 / 边缘填充": "Pad / Edge Fill",
  "stretch": "Stretch",
  "crop": "Center Crop",
  "pad": "Pad / Edge Fill",
};

function normalizeScaleTypeValue(value) {
  const text = String(value ?? "");
  return LEGACY_SCALE_TYPE_VALUES[text] || text;
}

function normalizeEdgeModeValue(value) {
  const text = String(value ?? "");
  return LEGACY_EDGE_MODE_VALUES[text] || text;
}

function isCustomSizeMode(value) {
  const text = String(value || "").trim();
  return text === CUSTOM_SIZE_MODE || text === LEGACY_CUSTOM_SIZE_MODE;
}

function migrateLegacyNodeTypes(graphData) {
  if (!graphData || typeof graphData !== "object") return;

  for (const node of graphData.nodes || []) {
    if (node?.type && LEGACY_NODE_TYPES[node.type]) {
      node.type = LEGACY_NODE_TYPES[node.type];
    }
  }

  for (const subgraph of graphData.definitions?.subgraphs || []) {
    migrateLegacyNodeTypes(subgraph);
  }
}

function hideDuplicateLegacyNodeDefs(nodeDefs) {
  const targetNodeIds = new Set(Object.values(LEGACY_NODE_TYPES));
  const seenNodeIds = new Set();
  for (let index = 0; index < nodeDefs.length;) {
    const nodeId = nodeDefs[index]?.name;
    if (LEGACY_NODE_TYPES[nodeId]) {
      nodeDefs.splice(index, 1);
      continue;
    }
    if (!targetNodeIds.has(nodeId)) {
      index += 1;
      continue;
    }
    if (seenNodeIds.has(nodeId)) {
      nodeDefs.splice(index, 1);
      continue;
    }
    seenNodeIds.add(nodeId);
    index += 1;
  }
}

const SCALE_META = {
  "None": {
    widget: null,
    label: "Target Value",
    help: "Keep the source size. Target value, alignment factor, and resize mode are not used.",
  },
  "By Resolution": {
    widget: "target_resolution",
    label: "Resolution",
    help: "Range 512–4096, step 32. The node searches for a matching fixed-point size from the source ratio and tol_ratio.",
  },
  "By Image Scale": {
    widget: "target_scale",
    label: "Target Value (Scale)",
    help: "Multiply width and height by this factor. Example: 1.5 turns 1000 × 500 into 1500 × 750; 0.5 halves it.",
  },
  "By Target Width": {
    widget: "target_width",
    label: "Target Value (Width px)",
    help: "Enter the target width; height is calculated from the source ratio. Example: with 1024 and a 3:2 source, height is about 683.",
  },
  "By Target Height": {
    widget: "target_height",
    label: "Target Value (Height px)",
    help: "Enter the target height; width is calculated from the source ratio. Example: with 1024 and a 3:2 source, width is about 1536.",
  },
};

const MAX_CROP_EDGE = 16384;
const MAX_CROP_PIXELS = 64 * 1024 * 1024;

function ensureNodeStyles() {
  if (document.getElementById("xm-astral-node-styles")) return;
  const style = document.createElement("style");
  style.id = "xm-astral-node-styles";
  style.textContent = `
    .xm-astral-node-ui {
      box-sizing: border-box;
      width: 100%;
      height: calc(100% + 3px);
      min-height: 258px;
      padding: 0 6px 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transform: translateY(-3px);
      color: var(--input-text, #e8e8e8);
      font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .xm-astral-preview {
      position: relative;
      flex: 1 1 auto;
      min-height: 180px;
      border: 0;
      border-radius: 0;
      overflow: hidden;
      background: transparent;
    }
    .xm-astral-preview img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: default;
      outline: none;
      display: none;
    }
    .xm-astral-preview img.loaded { display: block; }
    .xm-astral-preview img:focus-visible {
      outline: 2px solid #5ea6ff;
      outline-offset: -3px;
    }
    .xm-astral-edit-fab {
      box-sizing: border-box;
      position: absolute;
      right: 6px;
      bottom: 6px;
      z-index: 3;
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      padding: 0;
      appearance: none;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: #f4f4f5;
      opacity: .82;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .85));
      cursor: pointer;
    }
    .xm-astral-edit-fab:hover {
      background: transparent;
      opacity: 1;
    }
    .xm-astral-edit-fab:focus-visible {
      outline: 2px solid #5ea6ff;
      outline-offset: 2px;
    }
    .xm-astral-edit-fab[hidden] { display: none; }
    .xm-astral-edit-fab svg {
      width: 17px;
      height: 17px;
      pointer-events: none;
    }
    .xm-astral-empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 16px;
      text-align: center;
      color: var(--descrip-text, #9ea4af);
    }
    .xm-astral-empty.hidden { display: none; }
    .xm-astral-meta {
      flex: 0 0 auto;
      min-height: 17px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--descrip-text, #aeb4c0);
      font-size: 11px;
      text-align: center;
    }
    .xm-astral-meta.error { color: #ff8d8d; }
    .xm-astral-load-control {
      width: 100% !important;
    }
    .xm-astral-load-control button,
    .xm-astral-load-control [role="combobox"] {
      min-height: 30px !important;
    }
  `;
  document.head.appendChild(style);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberValue(widget, fallback) {
  const value = Number(widget?.value);
  return Number.isFinite(value) ? value : fallback;
}

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name) || null;
}

function isLegacyNodeSize(size) {
  return (
    Math.abs(Number(size?.[0]) - 460) < 0.5 &&
    Math.abs(Number(size?.[1]) - 760) < 0.5
  );
}

function getCompactNodeSize(node) {
  const computed = node.computeSize?.();
  const fallbackWidth = Number(node.size?.[0]) || 200;
  const fallbackHeight = Number(node.size?.[1]) || 420;
  const width = Number(computed?.[0]);
  const height = Number(computed?.[1]);
  return [
    Math.max(1, Math.round(Number.isFinite(width) ? width : fallbackWidth)),
    Math.max(1, Math.round(Number.isFinite(height) ? height : fallbackHeight)),
  ];
}

function initializeImageNodeSize(node) {
  if (!node._astralSetup) return;
  const sizeVersion = Number(node.properties?.[NODE_SIZE_VERSION_PROPERTY]);
  if (sizeVersion >= NODE_SIZE_VERSION) return;

  // Version 1 always forced nodes to at least 460 x 760. Migrate that exact
  // legacy size once, while preserving every size the user chose themselves.
  if (!node._astralHadSavedSize || isLegacyNodeSize(node.size)) {
    node.setSize?.(getCompactNodeSize(node));
  }
  node.properties ||= {};
  node.properties[NODE_SIZE_VERSION_PROPERTY] = NODE_SIZE_VERSION;
}

function setWidgetHidden(widget, hidden) {
  if (!widget) return;
  widget.hidden = hidden;
  if (!widget.options) widget.options = {};
  widget.options.hidden = hidden;
  if (widget.element?.parentElement) {
    widget.element.parentElement.style.display = hidden ? "none" : "";
  }
}

function syncResolutionSelectorWidgets(node) {
  const modeWidget = findWidget(node, "aspect_ratio");
  if (modeWidget && modeWidget.value === LEGACY_CUSTOM_SIZE_MODE) {
    setWidgetValue(modeWidget, CUSTOM_SIZE_MODE);
  }
  const customSize = isCustomSizeMode(modeWidget?.value);
  setWidgetHidden(findWidget(node, "megapixels"), customSize);
  setWidgetHidden(findWidget(node, "multiple"), customSize);
  setWidgetHidden(findWidget(node, "width"), !customSize);
  setWidgetHidden(findWidget(node, "height"), !customSize);
  node.graph?.setDirtyCanvas?.(true, true);
}

function hookResolutionSelectorWidgets(node) {
  if (node._astralResolutionSelectorHooked) return;
  const modeWidget = findWidget(node, "aspect_ratio");
  if (!modeWidget) return;
  node._astralResolutionSelectorHooked = true;
  const originalCallback = modeWidget.callback;
  modeWidget.callback = function (...args) {
    const result = originalCallback?.apply(this, args);
    const refresh = () => syncResolutionSelectorWidgets(node);
    if (result && typeof result.then === "function") {
      result.then(refresh, refresh);
    } else {
      refresh();
    }
    return result;
  };
  syncResolutionSelectorWidgets(node);
}

function setWidgetTooltip(widget, text) {
  if (!widget) return;
  const tooltip = String(text || "").trim();
  if (!tooltip) return;
  // Current ComfyUI frontends render tooltips from the widget field.
  widget.tooltip = tooltip;
  if (!widget.options) widget.options = {};
  widget.options.tooltip = tooltip;
  for (const element of [widget.element, widget.inputEl, widget.element?.parentElement]) {
    if (element) element.title = tooltip;
  }
}

function setWidgetValue(widget, value) {
  if (!widget) return;
  widget.value = value;
  if ("value" in (widget.element || {})) widget.element.value = String(value);
  if ("value" in (widget.inputEl || {})) widget.inputEl.value = String(value);
}

function widgetBooleanValue(widget, fallback = false) {
  if (!widget) return fallback;
  if (typeof widget.value === "boolean") return widget.value;
  const text = String(widget.value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off", ""].includes(text)) return false;
  return fallback;
}

function rememberOriginalImagePath(node, value) {
  const path = String(value || "").trim();
  node._astralOriginalImagePath = path;
  node.properties ||= {};
  if (path) {
    node.properties[ORIGINAL_IMAGE_PROPERTY] = path;
  } else {
    delete node.properties[ORIGINAL_IMAGE_PROPERTY];
  }
}

function originalImagePath(node) {
  const remembered = String(
    node?._astralOriginalImagePath ||
      node?.properties?.[ORIGINAL_IMAGE_PROPERTY] ||
      "",
  ).trim();
  return remembered || String(findWidget(node, "image_file")?.value || "");
}

function setNodeWidgetValue(node, name, value) {
  const widget = findWidget(node, name);
  if (!widget) return false;
  const previous = widget.value;
  setWidgetValue(widget, value);
  node.onWidgetChanged?.(name, value, previous, widget);
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function normalizeResolutionValue(value, fallback = 1024) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : fallback;
  const snapped =
    Math.round(safeValue / QWEN_BLOCK_SIZE) * QWEN_BLOCK_SIZE;
  return clamp(snapped, MIN_QWEN_RESOLUTION, MAX_TARGET_RESOLUTION);
}

function legacyTargetToResolution(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1024;
  if (
    numeric >= MIN_QWEN_RESOLUTION &&
    numeric <= MAX_TARGET_RESOLUTION &&
    numeric % QWEN_BLOCK_SIZE === 0
  ) {
    return numeric;
  }

  const pixelCount =
    numeric <= 256
      ? numeric * 1024 * 1024
      : numeric;
  return normalizeResolutionValue(Math.sqrt(pixelCount));
}

function normalizeResolutionWidget(widget) {
  if (!widget) return;
  if (!widget.options) widget.options = {};
  widget.options.min = MIN_QWEN_RESOLUTION;
  widget.options.max = MAX_TARGET_RESOLUTION;
  widget.options.step = QWEN_BLOCK_SIZE;
  for (const element of [widget.element, widget.inputEl]) {
    if (!element) continue;
    element.min = String(MIN_QWEN_RESOLUTION);
    element.max = String(MAX_TARGET_RESOLUTION);
    element.step = String(QWEN_BLOCK_SIZE);
  }
}

function migrateSerializedWidgetValues(node, info) {
  const values = info?.widgets_values;
  if (!values || typeof values !== "object") return info;

  const isArray = Array.isArray(values);
  let migratedValues = values;
  if (isArray) {
    const detectedTolIndex = node.widgets?.findIndex(
      (widget) => widget.name === "tol_ratio",
    ) ?? -1;
    const tolIndex = detectedTolIndex >= 0 ? detectedTolIndex : 8;
    const oldEdgeValue = String(values[tolIndex] ?? "");
    if (
      [
        "拉伸",
        "居中裁剪",
        "填充 / 边缘填充",
        "Stretch",
        "Center Crop",
        "Pad / Edge Fill",
        "stretch",
        "crop",
        "pad",
      ].includes(oldEdgeValue)
    ) {
      // Older workflows stored edge_mode at this index. Insert a default before
      // ComfyUI maps the array back onto the newly inserted tol_ratio widget.
      migratedValues = [...values];
      migratedValues.splice(tolIndex, 0, 0.8);
    }
  }

  const scaleIndex = isArray
    ? node.widgets?.findIndex((widget) => widget.name === "scale_type") ?? -1
    : -1;
  const resolutionIndex = isArray
    ? node.widgets?.findIndex((widget) => widget.name === "target_resolution") ?? -1
    : -1;
  const edgeIndex = isArray
    ? node.widgets?.findIndex((widget) => widget.name === "edge_mode") ?? -1
    : -1;
  if (isArray) {
    const oldScaleType = String(
      migratedValues[scaleIndex >= 0 ? scaleIndex : 1] ?? "",
    );
    const normalizedScaleType = normalizeScaleTypeValue(oldScaleType);
    const hasLegacyScale = oldScaleType === "按像素数量";
    const shouldMigrateScale = normalizedScaleType !== oldScaleType;
    const oldTargetValue =
      resolutionIndex >= 0 ? migratedValues[resolutionIndex] : undefined;
    const shouldMigrateTarget =
      hasLegacyScale ||
      (oldTargetValue !== undefined &&
        (Number(oldTargetValue) < MIN_QWEN_RESOLUTION ||
          Number(oldTargetValue) > MAX_TARGET_RESOLUTION));
    const oldEdgeValue =
      edgeIndex >= 0 ? String(migratedValues[edgeIndex] ?? "") : "";
    const normalizedEdgeValue = normalizeEdgeModeValue(oldEdgeValue);
    const shouldMigrateEdge = normalizedEdgeValue !== oldEdgeValue;
    if (!shouldMigrateScale && !shouldMigrateTarget && !shouldMigrateEdge) {
      return migratedValues === values
        ? info
        : { ...info, widgets_values: migratedValues };
    }

    const converted = [...migratedValues];
    if (shouldMigrateScale) {
      converted[scaleIndex >= 0 ? scaleIndex : 1] = normalizedScaleType;
    }
    if (resolutionIndex >= 0 && shouldMigrateTarget) {
      converted[resolutionIndex] = legacyTargetToResolution(oldTargetValue);
    }
    if (edgeIndex >= 0 && shouldMigrateEdge) {
      converted[edgeIndex] = normalizedEdgeValue;
    }
    return { ...info, widgets_values: converted };
  }

  const oldScaleType = String(values.scale_type ?? "");
  const normalizedScaleType = normalizeScaleTypeValue(oldScaleType);
  const shouldMigrateScale = normalizedScaleType !== oldScaleType;
  const oldEdgeValue = String(values.edge_mode ?? "");
  const normalizedEdgeValue = normalizeEdgeModeValue(oldEdgeValue);
  const shouldMigrateEdge = normalizedEdgeValue !== oldEdgeValue;
  const hasLegacyTarget = Object.prototype.hasOwnProperty.call(
    values,
    "target_pixels",
  );
  if (!shouldMigrateScale && !shouldMigrateEdge && !hasLegacyTarget) {
    return info;
  }

  const converted = { ...values };
  if (shouldMigrateScale) {
    converted.scale_type = normalizedScaleType;
  }
  if (shouldMigrateEdge) {
    converted.edge_mode = normalizedEdgeValue;
  }
  if (hasLegacyTarget) {
    converted.target_resolution = legacyTargetToResolution(
      values.target_pixels,
    );
    delete converted.target_pixels;
  } else if (converted.target_resolution === undefined) {
    converted.target_resolution = 1024;
  }
  return { ...info, widgets_values: converted };
}

function normalizeHexColor(value) {
  const match = String(value || "").trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  return [0, 2, 4]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .join(",");
}

function normalizeRgbColor(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return normalizeHexColor(text);
  }
  const match = text.match(
    /^(\d{1,3})\s*[,，]\s*(\d{1,3})\s*[,，]\s*(\d{1,3})$/,
  );
  if (!match) return null;
  const components = match.slice(1).map(Number);
  if (components.some((component) => component < 0 || component > 255)) {
    return null;
  }
  return components.join(",");
}

function migrateAdvancedWidgets(node) {
  const resolutionWidget = findWidget(node, "target_resolution");
  normalizeResolutionWidget(resolutionWidget);
  if (resolutionWidget) {
    const rawResolution = Number(resolutionWidget.value);
    const resolution = !Number.isFinite(rawResolution)
      ? 1024
      : rawResolution < MIN_QWEN_RESOLUTION ||
          rawResolution > MAX_TARGET_RESOLUTION
        ? legacyTargetToResolution(rawResolution)
        : normalizeResolutionValue(rawResolution);
    if (resolution !== rawResolution) {
      setWidgetValue(resolutionWidget, resolution);
    }
  }

  for (const name of ["fill_mask_holes", "bevel_mask", "invert_mask"]) {
    const widget = findWidget(node, name);
    if (!widget) continue;
    const booleanValue = widgetBooleanValue(widget, MASK_WIDGET_DEFAULTS[name]);
    if (widget.value !== booleanValue) {
      setWidgetValue(widget, booleanValue);
    }
  }

  const padWidget = findWidget(node, "pad_color");
  const rgbValue = normalizeHexColor(padWidget?.value);
  if (rgbValue && rgbValue !== String(padWidget.value)) {
    setWidgetValue(padWidget, rgbValue);
  }

  const maskColorWidget = findWidget(node, "mask_color");
  const maskRgb =
    normalizeRgbColor(maskColorWidget?.value) ||
    MASK_WIDGET_DEFAULTS.mask_color;
  if (maskRgb !== String(maskColorWidget?.value || "")) {
    setWidgetValue(maskColorWidget, maskRgb);
  }

  const maskGrowWidget = findWidget(node, "mask_grow");
  if (maskGrowWidget) {
    const grow = clamp(
      Math.round(numberValue(maskGrowWidget, 0)),
      -256,
      256,
    );
    if (grow !== Number(maskGrowWidget.value)) {
      setWidgetValue(maskGrowWidget, grow);
    }
  }
}

function removeNativeImagePreview(node) {
  if (!Array.isArray(node.widgets)) return;
  let removed = false;
  for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
    const widget = node.widgets[index];
    if (widget?.name !== NATIVE_IMAGE_PREVIEW_WIDGET) continue;
    widget.onRemove?.();
    node.widgets.splice(index, 1);
    removed = true;
  }
  if (removed) {
    syncNodePreviewImage(node);
    node.onResize?.(node.size);
  }
}

function trimImageEditorOutputs(node) {
  if (!Array.isArray(node.outputs)) return;

  const byName = new Map();
  for (const output of node.outputs) {
    for (const key of ["name", "localized_name", "label"]) {
      if (output?.[key] && !byName.has(output[key])) {
        byName.set(output[key], output);
      }
    }
  }

  let changed =
    node.outputs.length !== EDITOR_OUTPUT_COUNT;
  const nextOutputs = EDITOR_OUTPUTS.map((expected) => {
    let output = byName.get(expected.name);
    if (!output) {
      const created = node.addOutput?.(expected.name, expected.type);
      output =
        created && typeof created === "object"
          ? created
          : node.outputs[node.outputs.length - 1];
      if (!output) {
        output = { name: expected.name, type: expected.type, links: [] };
      }
      byName.set(expected.name, output);
    }
    for (const key of ["name", "localized_name", "label"]) {
      if (key in output && output[key] !== expected.name) {
        output[key] = expected.name;
        changed = true;
      }
    }
    if (output.type !== expected.type) {
      output.type = expected.type;
      changed = true;
    }
    return output;
  });
  if (
    nextOutputs.some(
      (output, index) => node.outputs[index] !== output,
    )
  ) {
    changed = true;
  }
  const nextOutputSet = new Set(nextOutputs);

  for (let index = node.outputs.length - 1; index >= 0; index -= 1) {
    if (nextOutputSet.has(node.outputs[index])) continue;
    changed = true;
    if (typeof node.removeOutput === "function") {
      node.removeOutput(index);
    } else {
      node.outputs.splice(index, 1);
    }
  }

  node.outputs = nextOutputs;

  // Existing workflows may have saved an older output order. Rebuild by output
  // name, then repoint their links to the matching reordered slots.
  const slotOf = new Map();
  node.outputs.forEach((output, index) => {
    for (const linkId of output.links || []) {
      slotOf.set(linkId, index);
    }
  });
  const links = node.graph?.links;
  if (links) {
    const values =
      typeof links.values === "function" ? links.values() : Object.values(links);
    for (const link of values) {
      const linkId = Array.isArray(link) ? link[0] : link?.id;
      if (!slotOf.has(linkId)) continue;
      if (Array.isArray(link)) {
        link[2] = slotOf.get(linkId);
      } else {
        link.origin_slot = slotOf.get(linkId);
      }
    }
  }

  if (changed) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  }
}

function syncNodePreviewImage(node) {
  const image = node?._astralPreviewImg;
  const imageWidget = findWidget(node, "image_file");
  const imageRef = splitImageValue(imageWidget?.value);
  const valid =
    Boolean(image?.src) &&
    image.complete &&
    image.naturalWidth > 0 &&
    image.classList.contains("loaded") &&
    Boolean(imageRef.filename);
  if (!valid) {
    node.imgs = [];
    node.images = [];
    node.imageIndex = 0;
    delete node.previewMediaType;
    return false;
  }
  node.imgs = [image];
  node.images = [imageRef];
  node.imageIndex = 0;
  node.previewMediaType = "image";
  return true;
}

function syncMaskEditorImageAlias(node) {
  const alias = node?._astralMaskImageAlias;
  if (!alias || node._astralSyncingMaskAlias) return;
  const value = String(findWidget(node, "image_file")?.value || "");
  node._astralSyncingMaskAlias = true;
  alias.value = value;
  node._astralSyncingMaskAlias = false;
}

function commitImageFileValue(node, value, options = {}) {
  const imageWidget = findWidget(node, "image_file");
  const path = String(value || "").trim();
  if (!imageWidget || !path) return false;
  if (!options.preserveOriginal) rememberOriginalImagePath(node, path);

  const previousValue = imageWidget.value;
  node._astralProgrammaticImageCommit = true;
  try {
    setWidgetValue(imageWidget, path);
    const values = imageWidget.options?.values;
    if (Array.isArray(values) && !values.includes(path)) values.push(path);

    syncMaskEditorImageAlias(node);
    node.onWidgetChanged?.(
      imageWidget.name,
      path,
      previousValue,
      imageWidget,
    );
  } finally {
    node._astralProgrammaticImageCommit = false;
  }
  void refreshNodePreview(node, true);
  app.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function syncImageControlFrame(node) {
  const imageWidget = findWidget(node, "image_file");
  if (!imageWidget) return;

  const element = imageWidget.element;
  let frameStyle = null;
  if (element) {
    element.classList.add("xm-astral-load-control");
    const inner =
      element.matches?.('button, [role="combobox"]')
        ? element
        : element.querySelector?.('button, [role="combobox"]');
    const frame = inner || element;
    frameStyle = getComputedStyle(frame);
  }

  const borderColor =
    frameStyle?.borderColor ||
    (typeof imageWidget.getOutlineColor === "function"
      ? imageWidget.getOutlineColor()
      : "");
  if (node._astralPreview && borderColor) {
    node._astralPreview.style.borderColor = borderColor;
  }
}

function installMaskEditorImageAlias(node) {
  const imageWidget = findWidget(node, "image_file");
  if (!imageWidget) return null;

  let alias = findWidget(node, MASK_EDITOR_IMAGE_WIDGET);
  if (!alias) {
    alias = {
      type: "text",
      name: MASK_EDITOR_IMAGE_WIDGET,
      value: String(imageWidget.value || ""),
      options: { hidden: true },
      hidden: true,
      serialize: false,
      y: 0,
      computeSize: () => [0, -4],
      callback: (value) => {
        if (node._astralSyncingMaskAlias) return;
        const path = String(value || "");
        if (!path || path === String(imageWidget.value || "")) return;
        commitImageFileValue(node, path, { preserveOriginal: true });
      },
    };
    node.widgets ||= [];
    node.widgets.push(alias);
  }

  node._astralMaskImageAlias = alias;
  syncMaskEditorImageAlias(node);
  return alias;
}


function openImageContextMenu(node, event) {
  event.preventDefault();
  event.stopPropagation();
  if (!syncNodePreviewImage(node)) return;
  syncMaskEditorImageAlias(node);

  const canvas = app.canvas;
  if (typeof canvas?.processContextMenu === "function") {
    canvas.processContextMenu(node, event);
    return;
  }

  const options = canvas?.getNodeMenuOptions?.(node);
  if (Array.isArray(options) && options.length && globalThis.LiteGraph?.ContextMenu) {
    new globalThis.LiteGraph.ContextMenu(options, {
      event,
      title: node.title,
      className: "litecontextmenu",
      callback: null,
    });
  }
}

async function prepareNodeForMaskEditor(node) {
  await refreshNodePreview(node, true);
  syncMaskEditorImageAlias(node);
  const canvas = app.canvas;
  canvas?.deselectAllNodes?.();
  if (typeof canvas?.selectNode === "function") {
    canvas.selectNode(node, false);
  } else {
    node.selected = true;
  }
  canvas?.setDirty?.(true, true);
  if (!syncNodePreviewImage(node)) {
    throw new Error("The node image has not finished loading; cannot open the mask editor.");
  }
  syncMaskEditorImageAlias(node);
}

async function openComfyMaskEditorForNode(node) {
  await prepareNodeForMaskEditor(node);
  const command = app.extensionManager?.command;
  if (typeof command?.execute !== "function") {
    throw new Error("This ComfyUI frontend does not support opening the official mask editor.");
  }
  await command.execute("Comfy.MaskEditor.OpenMaskEditor");
}

function chainWidgetCallback(widget, callback) {
  if (!widget || widget._xmAstralCallbackHooked) return;
  widget._xmAstralCallbackHooked = true;
  const original = widget.callback;
  widget.callback = function (...args) {
    const result = original?.apply(this, args);
    callback.apply(this, args);
    return result;
  };
}

function chainNodeMethod(node, method, callback) {
  const original = node[method];
  node[method] = function (...args) {
    const result = original?.apply(this, args);
    callback.apply(this, args);
    return result;
  };
}

function splitImageValue(value) {
  let path = String(value || "").trim().replaceAll("\\", "/");
  let type = "input";
  const annotation = path.match(/^(.*?)\s+\[(input|output|temp)\]$/i);
  if (annotation) {
    path = annotation[1];
    type = annotation[2].toLowerCase();
  }
  const slash = path.lastIndexOf("/");
  return {
    filename: slash >= 0 ? path.slice(slash + 1) : path,
    subfolder: slash >= 0 ? path.slice(0, slash) : "",
    type,
  };
}

function makeImageUrl(value, version = Date.now()) {
  if (!value) return "";
  const parts = splitImageValue(value);
  const params = new URLSearchParams({
    filename: parts.filename,
    subfolder: parts.subfolder,
    type: parts.type,
    t: String(version),
  });
  return api.apiURL(`/view?${params.toString()}`);
}

function roundToMultiple(value, factor) {
  const safeFactor = Math.max(1, Math.round(factor || 1));
  if (safeFactor === 1) return Math.max(1, Math.round(value));
  return Math.max(safeFactor, Math.round(value / safeFactor) * safeFactor);
}

function pythonRound(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function autoQwenResolution(width, height) {
  const target =
    pythonRound(
      Math.sqrt(Math.max(1, width) * Math.max(1, height)) / QWEN_BLOCK_SIZE,
    ) * QWEN_BLOCK_SIZE;
  return clamp(target, MIN_QWEN_RESOLUTION, MAX_QWEN_RESOLUTION);
}

function qwenResizedSize(width, height, resolution) {
  if (resolution <= 0) {
    return [
      Math.max(
        QWEN_BLOCK_SIZE,
        pythonRound(width / QWEN_BLOCK_SIZE) * QWEN_BLOCK_SIZE,
      ),
      Math.max(
        QWEN_BLOCK_SIZE,
        pythonRound(height / QWEN_BLOCK_SIZE) * QWEN_BLOCK_SIZE,
      ),
    ];
  }
  const ratio = width / height;
  return [
    Math.max(
      QWEN_BLOCK_SIZE,
      pythonRound(
        Math.sqrt(resolution * resolution * ratio) / QWEN_BLOCK_SIZE,
      ) * QWEN_BLOCK_SIZE,
    ),
    Math.max(
      QWEN_BLOCK_SIZE,
      pythonRound(
        Math.sqrt(resolution * resolution / ratio) / QWEN_BLOCK_SIZE,
      ) * QWEN_BLOCK_SIZE,
    ),
  ];
}

function fixedPointCandidates(resolution, tolerance, blockSize) {
  const targetArea = resolution * resolution;
  const toleranceArea =
    tolerance * QWEN_BLOCK_SIZE * QWEN_BLOCK_SIZE;
  const maxWidthBlocks = Math.max(
    1,
    Math.floor((resolution * 3) / blockSize),
  );
  const candidates = new Map();

  for (let widthBlocks = 1; widthBlocks <= maxWidthBlocks; widthBlocks += 1) {
    const width = widthBlocks * blockSize;
    const minHeight = Math.max(
      blockSize,
      Math.ceil(
        (targetArea - toleranceArea) / width / blockSize,
      ) * blockSize,
    );
    const maxHeight = Math.min(
      resolution * 3,
      Math.floor(
        (targetArea + toleranceArea) / width / blockSize,
      ) * blockSize,
    );
    for (
      let height = minHeight;
      height <= maxHeight;
      height += blockSize
    ) {
      const areaDelta = width * height - targetArea;
      const key = `${width}:${height}`;
      candidates.set(key, {
        width,
        height,
        areaError: Math.abs(areaDelta) / targetArea,
      });
    }
  }
  return [...candidates.values()];
}

function pickQwenFixedPoint(
  width,
  height,
  resolution,
  tolRatio,
  blockSize,
) {
  const safeBlockSize = Math.max(1, Math.round(blockSize || 32));
  const cells = Math.floor(resolution / QWEN_BLOCK_SIZE);
  const tolerance = Math.max(1, Math.floor(cells * tolRatio));
  const candidates = fixedPointCandidates(
    resolution,
    tolerance,
    safeBlockSize,
  );
  if (!candidates.length) {
    throw new Error(
      `resolution=${resolution}, tol_ratio=${tolRatio}, alignment_factor=${safeBlockSize}: no candidate sizes found`,
    );
  }

  const inputRatio = width / height;
  const score = (candidate) => {
    const candidateRatio = candidate.width / candidate.height;
    const ratioError = Math.abs(Math.log(candidateRatio / inputRatio));
    const standardError = Math.min(
      ...QWEN_STANDARD_RATIOS.map((standardRatio) =>
        Math.abs(Math.log(candidateRatio / standardRatio)),
      ),
    );
    return ratioError + standardError * 0.6 + candidate.areaError * 0.4;
  };
  const compare = (left, right) =>
    score(left) - score(right) ||
    left.width - right.width ||
    left.height - right.height;
  candidates.sort(compare);

  let selected = candidates[0];
  const [fixedWidth, fixedHeight] = qwenResizedSize(
    selected.width,
    selected.height,
    resolution,
  );
  if (fixedWidth !== selected.width || fixedHeight !== selected.height) {
    const fixedCandidates = candidates.filter((candidate) => {
      const [widthAfter, heightAfter] = qwenResizedSize(
        candidate.width,
        candidate.height,
        resolution,
      );
      return widthAfter === candidate.width && heightAfter === candidate.height;
    });
    if (!fixedCandidates.length) {
      throw new Error(`resolution=${resolution}: no fixed-point size found`);
    }
    selected = fixedCandidates.sort(
      (left, right) =>
        Math.abs(Math.log(left.width / left.height / inputRatio)) -
        Math.abs(Math.log(right.width / right.height / inputRatio)) ||
        left.width - right.width ||
        left.height - right.height,
    )[0];
  }

  return {
    width: selected.width,
    height: selected.height,
    resolution,
  };
}

function calculateTargetDimensions(node, sourceWidth, sourceHeight) {
  if (!sourceWidth || !sourceHeight) return null;
  const scaleWidget = findWidget(node, "scale_type");
  const scaleType = normalizeScaleTypeValue(scaleWidget?.value || "None");
  if (scaleType === "None") {
    return {
      width: sourceWidth,
      height: sourceHeight,
      resolution: autoQwenResolution(sourceWidth, sourceHeight),
    };
  }

  const factor = Math.max(
    1,
    Math.round(numberValue(findWidget(node, "alignment_factor"), 32)),
  );
  const tolRatio = Math.max(
    0.2,
    numberValue(findWidget(node, "tol_ratio"), 0.8),
  );
  if (scaleType === "By Resolution") {
    const resolution = normalizeResolutionValue(
      numberValue(findWidget(node, "target_resolution"), 1024),
    );
    return pickQwenFixedPoint(
      sourceWidth,
      sourceHeight,
      resolution,
      tolRatio,
      factor,
    );
  }

  const ratio = sourceWidth / sourceHeight;
  let idealWidth;
  let idealHeight;
  if (scaleType === "By Image Scale") {
    const scale = Math.max(0.01, numberValue(findWidget(node, "target_scale"), 1));
    idealWidth = sourceWidth * scale;
    idealHeight = sourceHeight * scale;
  } else if (scaleType === "By Target Width") {
    idealWidth = Math.max(1, numberValue(findWidget(node, "target_width"), 1024));
    idealHeight = idealWidth / ratio;
  } else {
    idealHeight = Math.max(1, numberValue(findWidget(node, "target_height"), 1024));
    idealWidth = idealHeight * ratio;
  }

  const requestedWidth = roundToMultiple(idealWidth, factor);
  const requestedHeight = roundToMultiple(idealHeight, factor);
  const resolution = autoQwenResolution(requestedWidth, requestedHeight);
  return pickQwenFixedPoint(
    requestedWidth,
    requestedHeight,
    resolution,
    tolRatio,
    factor,
  );
}

function setNodeStatus(node, text, isError = false) {
  if (!node._astralMeta) return;
  node._astralMeta.textContent = text;
  node._astralMeta.classList.toggle("error", isError);
}

function syncNodeControls(node) {
  if (!node._astralSetup) return;
  migrateAdvancedWidgets(node);
  removeNativeImagePreview(node);
  const scaleWidget = findWidget(node, "scale_type");
  const edgeWidget = findWidget(node, "edge_mode");
  const scaleType = normalizeScaleTypeValue(scaleWidget?.value || "None");
  const meta = SCALE_META[scaleType] || SCALE_META["None"];
  const scalingEnabled = scaleType !== "None";

  for (const name of TARGET_WIDGETS) {
    const widget = findWidget(node, name);
    const active = name === meta.widget;
    setWidgetHidden(widget, !active);
    if (widget) widget.label = active ? meta.label : "Target Value";
  }

  for (const name of [
    "upscale_method",
    "alignment_factor",
    "tol_ratio",
    "edge_mode",
  ]) {
    setWidgetHidden(findWidget(node, name), !scalingEnabled);
  }
  setWidgetHidden(
    findWidget(node, "pad_color"),
    !scalingEnabled || normalizeEdgeModeValue(edgeWidget?.value || "Stretch") !== "Pad / Edge Fill",
  );
  for (const name of MASK_PARAM_WIDGETS) {
    setWidgetHidden(findWidget(node, name), true);
  }

  const dimensions = node._astralImageDimensions;
  let estimateText = "Upload an image to preview the estimated output size.";
  if (dimensions && !scalingEnabled) {
    const resolution = autoQwenResolution(
      dimensions.width,
      dimensions.height,
    );
    estimateText =
      `Keep source size: ${dimensions.width} × ${dimensions.height}` +
      ` · resolution ${resolution}`;
  } else if (dimensions) {
    try {
      const target = calculateTargetDimensions(
        node,
        dimensions.width,
        dimensions.height,
      );
      const alignment = Math.max(
        1,
        Math.round(numberValue(findWidget(node, "alignment_factor"), 32)),
      );
      const edgeMode = normalizeEdgeModeValue(edgeWidget?.value || "Stretch");
      const padText =
        edgeMode === "Pad / Edge Fill"
          ? ` · pad ${String(findWidget(node, "pad_color")?.value || "0,0,0")}`
          : "";
      estimateText =
        `Estimated output: ${target.width} × ${target.height}` +
        ` · resolution ${target.resolution}` +
        ` · align ${alignment}${padText}`;
    } catch (error) {
      estimateText = error?.message || "Unable to calculate the estimated output size.";
    }
  }

  const targetHelp = `${meta.help}\n${estimateText}`;
  setWidgetTooltip(scaleWidget, `Choose the resize basis.\n${targetHelp}`);
  setWidgetTooltip(findWidget(node, meta.widget), targetHelp);

  node.graph?.setDirtyCanvas?.(true, true);
}

async function refreshNodePreview(node, force = false) {
  if (!node._astralSetup) return;
  const imageWidget = findWidget(node, "image_file");
  const value = String(imageWidget?.value || "");
  if (!value) {
    rememberOriginalImagePath(node, "");
    node._astralImageDimensions = null;
    node._astralSourceUrl = "";
    node._astralPreviewImg.classList.remove("loaded");
    node._astralEmpty.classList.remove("hidden");
    node._astralEditButton.hidden = true;
    syncNodePreviewImage(node);
    setNodeStatus(node, "Uploaded images appear here.");
    syncNodeControls(node);
    return;
  }

  const requestId = (node._astralPreviewRequest || 0) + 1;
  node._astralPreviewRequest = requestId;
  node._astralCacheVersion = force
    ? Date.now()
    : node._astralCacheVersion || Date.now();
  const url = makeImageUrl(value, node._astralCacheVersion);
  setNodeStatus(node, "Loading preview…");

  await new Promise((resolve) => {
    const image = node._astralPreviewImg;
    image.onload = () => {
      if (requestId !== node._astralPreviewRequest) return resolve();
      node._astralImageDimensions = {
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      node._astralSourceUrl = url;
      image.classList.add("loaded");
      node._astralEmpty.classList.add("hidden");
      node._astralEditButton.hidden = false;
      syncNodePreviewImage(node);
      setNodeStatus(node, `${image.naturalWidth} × ${image.naturalHeight} px`);
      syncNodeControls(node);
      resolve();
    };
    image.onerror = () => {
      if (requestId !== node._astralPreviewRequest) return resolve();
      node._astralImageDimensions = null;
      node._astralSourceUrl = "";
      image.classList.remove("loaded");
      node._astralEmpty.classList.remove("hidden");
      node._astralEditButton.hidden = true;
      syncNodePreviewImage(node);
      setNodeStatus(node, "Image preview failed; upload again or check the file.", true);
      syncNodeControls(node);
      resolve();
    };
    image.src = url;
  });
}

function isEditablePasteTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function clipboardImageExtension(mimeType) {
  const extensions = {
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/tiff": "tiff",
    "image/webp": "webp",
  };
  return extensions[String(mimeType || "").toLowerCase()] || "png";
}

function createPastedImageName(mimeType) {
  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 17);
  const random = Math.random().toString(36).slice(2, 8);
  return `image-astral-paste-${timestamp}-${random}.${clipboardImageExtension(mimeType)}`;
}

async function pasteImageFromClipboard(node, clipboardData) {
  if (node._astralPasting) return false;
  const item = Array.from(clipboardData?.items || []).find(
    (candidate) =>
      candidate.kind === "file" &&
      String(candidate.type || "").startsWith("image/"),
  );
  const file = item?.getAsFile?.();
  if (!file) return false;

  node._astralPasting = true;
  node._astralPasteArmed = false;
  setNodeStatus(node, "Uploading image from clipboard…");

  try {
    const form = new FormData();
    form.append("image", file, createPastedImageName(file.type));
    form.append("subfolder", PASTE_IMAGE_SUBFOLDER);
    form.append("type", "input");

    const response = await api.fetchApi("/upload/image", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Image upload failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    const result = await response.json();
    if (!result?.name) throw new Error("The image upload API did not return a file name.");
    const uploadedPath = result.subfolder
      ? `${result.subfolder}/${result.name}`
      : result.name;
    const type = String(result.type || "input").toLowerCase();
    const path = type === "input" ? uploadedPath : `${uploadedPath} [${type}]`;
    if (!commitImageFileValue(node, path)) {
      throw new Error("Unable to update the node image parameter.");
    }
    return true;
  } catch (error) {
    console.error("[Image Astral] Failed to paste image", error);
    setNodeStatus(node, error?.message || "Paste image failed", true);
    return false;
  } finally {
    node._astralPasting = false;
  }
}

function activateImageNode(node) {
  if (node._astralSetup) return;
  node._astralSetup = true;
  ensureNodeStyles();

  const root = document.createElement("div");
  root.className = "xm-astral-node-ui";
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  root.addEventListener("wheel", (event) => {
    const canvas = node.graph?.canvas ?? app.canvas;
    if (typeof canvas?.processMouseWheel === "function") {
      canvas.processMouseWheel(event);
    }
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  const editButton = document.createElement("button");
  editButton.className = "xm-astral-edit-fab";
  editButton.type = "button";
  editButton.title = "Open editor";
  editButton.setAttribute("aria-label", "Open image editor");
  editButton.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      <circle cx="6" cy="6" r="3"></circle>
      <path d="M8.12 8.12 12 12"></path>
      <path d="M20 4 8.12 15.88"></path>
      <circle cx="6" cy="18" r="3"></circle>
      <path d="M14.8 14.8 20 20"></path>
    </svg>`;
  editButton.hidden = true;

  const preview = document.createElement("div");
  preview.className = "xm-astral-preview";
  const previewImage = document.createElement("img");
  previewImage.alt = "Image Astral image preview";
  previewImage.tabIndex = 0;
  previewImage.title =
    "Right-click to open the image menu; click, then press Ctrl+V to paste an image";
  const empty = document.createElement("div");
  empty.className = "xm-astral-empty";
  empty.textContent = "Upload or choose an image with the \"Load Image\" control above";
  preview.append(previewImage, editButton, empty);

  const meta = document.createElement("div");
  meta.className = "xm-astral-meta";
  meta.textContent = "Uploaded images appear here.";
  root.append(preview, meta);

  Object.assign(node, {
    _astralEditButton: editButton,
    _astralPreview: preview,
    _astralPreviewImg: previewImage,
    _astralEmpty: empty,
    _astralMeta: meta,
    _astralImageDimensions: null,
    _astralSourceUrl: "",
    _astralCacheVersion: Date.now(),
    _astralPreviewRequest: 0,
  });
  if (!node._astralOriginalImagePath && node.properties?.[ORIGINAL_IMAGE_PROPERTY]) {
    node._astralOriginalImagePath =
      node.properties[ORIGINAL_IMAGE_PROPERTY];
  }

  node.addDOMWidget("xm_astral_image_editor_ui", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 258,
    getMaxHeight: () => undefined,
  });

  const imageWidget = findWidget(node, "image_file");
  installMaskEditorImageAlias(node);
  for (const widget of node.widgets || []) {
    setWidgetTooltip(widget, widget.options?.tooltip);
  }
  setWidgetTooltip(findWidget(node, "tol_ratio"), TOL_RATIO_TOOLTIP);
  chainWidgetCallback(imageWidget, (value) => {
    const path = String(value || "").trim();
    if (
      path &&
      !node._astralProgrammaticImageCommit &&
      !node._astralRestoring
    ) {
      rememberOriginalImagePath(node, path);
    }
    syncMaskEditorImageAlias(node);
    window.setTimeout(() => refreshNodePreview(node, true), 0);
  });

  for (const name of [
    "scale_type",
    "target_resolution",
    "target_scale",
    "target_width",
    "target_height",
    "alignment_factor",
    "tol_ratio",
    "edge_mode",
    "pad_color",
  ]) {
    chainWidgetCallback(findWidget(node, name), () => syncNodeControls(node));
  }
  for (const name of MASK_PARAM_WIDGETS) {
    chainWidgetCallback(findWidget(node, name), () => {
      node._astralModal?.syncMaskSettings?.();
    });
  }

  const openEditor = () => {
    if (node._astralModal || !node._astralSourceUrl) return;
    const currentValue = String(findWidget(node, "image_file")?.value || "");
    const sourcePath = originalImagePath(node) || currentValue;
    const modal = new ImageEditorModal({
      node,
      imageUrl: node._astralSourceUrl,
      originalImageUrl: makeImageUrl(sourcePath, node._astralCacheVersion),
      onApplied: (path) => {
        return commitImageFileValue(node, path, { preserveOriginal: true });
      },
      onClosed: () => {
        node._astralModal = null;
      },
    });
    node._astralModal = modal;
    modal.open().catch((error) => {
      console.error("[Image Astral] Unable to open editor", error);
      node._astralModal = null;
      setNodeStatus(node, error?.message || "Unable to open the image editor", true);
    });
  };

  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openEditor();
  });
  previewImage.addEventListener("click", () => {
    if (!previewImage.classList.contains("loaded")) return;
    node._astralPasteArmed = true;
    previewImage.focus({ preventScroll: true });
  });
  previewImage.addEventListener("contextmenu", (event) => {
    openImageContextMenu(node, event);
  });

  const handleDocumentPointerDown = (event) => {
    if (!root.contains(event.target)) node._astralPasteArmed = false;
  };
  const handleDocumentPaste = (event) => {
    if (!node._astralPasteArmed || node._astralPasting) return;
    if (isEditablePasteTarget(event.target)) return;
    const hasImage = Array.from(event.clipboardData?.items || []).some(
      (item) =>
        item.kind === "file" &&
        String(item.type || "").startsWith("image/"),
    );
    if (!hasImage) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteImageFromClipboard(node, event.clipboardData);
  };
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("paste", handleDocumentPaste, true);
  node._astralDocumentPointerDown = handleDocumentPointerDown;
  node._astralDocumentPaste = handleDocumentPaste;

  chainNodeMethod(node, "onConfigure", () => {
    window.setTimeout(() => {
      if (node.properties?.[ORIGINAL_IMAGE_PROPERTY]) {
        node._astralOriginalImagePath =
          node.properties[ORIGINAL_IMAGE_PROPERTY];
      } else {
        rememberOriginalImagePath(
          node,
          findWidget(node, "image_file")?.value,
        );
      }
      syncNodeControls(node);
      refreshNodePreview(node);
      syncImageControlFrame(node);
    }, 0);
    window.setTimeout(() => refreshNodePreview(node), 120);
  });
  chainNodeMethod(node, "onExecuted", () => {
    window.setTimeout(() => {
      removeNativeImagePreview(node);
      node.graph?.setDirtyCanvas?.(true, true);
    }, 0);
  });
  chainNodeMethod(node, "onDrawBackground", () => {
    removeNativeImagePreview(node);
  });
  chainNodeMethod(node, "onRemoved", () => {
    document.removeEventListener(
      "pointerdown",
      node._astralDocumentPointerDown,
      true,
    );
    document.removeEventListener("paste", node._astralDocumentPaste, true);
    node._astralModal?.close();
    node._astralModal = null;
  });

  requestAnimationFrame(() => {
    trimImageEditorOutputs(node);
    syncNodeControls(node);
    initializeImageNodeSize(node);
    refreshNodePreview(node);
    syncImageControlFrame(node);
    window.setTimeout(() => syncImageControlFrame(node), 80);
    window.setTimeout(() => removeNativeImagePreview(node), 120);
  });
}

class ImageEditorModal {
  constructor({ node, imageUrl, originalImageUrl, onApplied, onClosed }) {
    this.node = node;
    this.imageUrl = imageUrl;
    this.originalImageUrl = originalImageUrl || imageUrl;
    this.onApplied = onApplied;
    this.onClosed = onClosed;
    this.tool = "crop";
    this.angle = 0;
    this.ratio = 0;
    this.cropRect = { x: 0, y: 0, width: 1, height: 1 };
    this.customCropSize = null;
    this.cropDirty = false;
    this.history = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.cropDrag = null;
    this.busy = false;
    this.disposed = false;
    this._keyHandler = (event) => this.handleKey(event);
    this.build();
  }

  build() {
    this.host = document.createElement("div");
    this.host.className = "xm-astral-modal-host";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 100000;
          pointer-events: none;
        }
        * { box-sizing: border-box; }
        button, input, select { font: inherit; }
        .backdrop {
          position: fixed;
          inset: 0;
          padding: 18px;
          display: grid;
          place-items: center;
          background: transparent;
          color: #e9edf4;
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
          pointer-events: none;
        }
        .window {
          position: relative;
          width: min(1220px, calc(100vw - 80px));
          height: min(850px, calc(100vh - 80px));
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid #454b58;
          border-radius: 14px;
          background: #171a20;
          box-shadow: 0 28px 90px rgba(0, 0, 0, .62);
          pointer-events: auto;
        }
        header, footer {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 14px;
          background: #20242c;
          border-color: #353b47;
        }
        header { border-bottom: 1px solid #353b47; }
        footer { border-top: 1px solid #353b47; }
        header {
          cursor: move;
          touch-action: none;
          user-select: none;
        }
        header.dragging { cursor: grabbing; }
        header button {
          cursor: pointer;
          touch-action: auto;
          user-select: auto;
        }
        header h2 {
          margin: 0;
          font-size: 16px;
          font-weight: 650;
          letter-spacing: .01em;
        }
        .head-meta {
          color: #9da6b5;
          font-size: 12px;
        }
        .content {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .toolbar {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
          padding: 8px 12px;
          border-bottom: 1px solid #303642;
          background: #1c2027;
        }
        .toolbar-spacer { flex: 1 1 auto; }
        button {
          appearance: none;
          border: 1px solid #414856;
          border-radius: 0;
          background: #272c35;
          color: #e9edf4;
          padding: 6px 11px;
          cursor: pointer;
        }
        button:hover:not(:disabled) { background: #313845; }
        button:disabled { opacity: .42; cursor: default; }
        button.active {
          border-color: #5ea6ff;
          background: #244a75;
          color: white;
        }
        button.primary {
          border-color: #4c9aff;
          background: #1769d2;
          font-weight: 600;
        }
        button.danger { border-color: #7b3b3b; background: #402424; }
        .workspace {
          flex: 1 1 auto;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 286px;
        }
        .stage {
          min-width: 0;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          padding: 18px;
          background:
            radial-gradient(circle at 50% 35%, rgba(68, 82, 105, .24), transparent 48%),
            #101318;
        }
        .image-frame {
          position: relative;
          display: inline-block;
          line-height: 0;
          max-width: 100%;
          max-height: 100%;
          box-shadow: 0 8px 30px rgba(0, 0, 0, .5);
        }
        canvas {
          display: block;
          max-width: 100%;
          max-height: calc(94vh - 188px);
          width: auto;
          height: auto;
          touch-action: none;
          background-color: #24272d;
          background-image:
            linear-gradient(45deg, #343941 25%, transparent 25%),
            linear-gradient(-45deg, #343941 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #343941 75%),
            linear-gradient(-45deg, transparent 75%, #343941 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0;
        }
        .crop-layer, .grid-layer {
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .crop-layer[hidden], .grid-layer[hidden] { display: none; }
        .crop-layer { cursor: crosshair; }
        .crop-box {
          position: absolute;
          border: 1px solid #fff;
          box-shadow: 0 0 0 99999px rgba(0, 0, 0, .58);
          cursor: move;
          min-width: 12px;
          min-height: 12px;
        }
        .crop-box::before, .crop-box::after {
          content: "";
          position: absolute;
          pointer-events: none;
          border-color: rgba(255,255,255,.45);
          border-style: dashed;
        }
        .crop-box::before {
          left: 33.333%; right: 33.333%; top: 0; bottom: 0;
          border-left-width: 1px; border-right-width: 1px;
        }
        .crop-box::after {
          top: 33.333%; bottom: 33.333%; left: 0; right: 0;
          border-top-width: 1px; border-bottom-width: 1px;
        }
        .crop-handle {
          position: absolute;
          width: 11px;
          height: 11px;
          margin: -6px 0 0 -6px;
          border: 1px solid #111;
          border-radius: 2px;
          background: #fff;
          touch-action: none;
        }
        .crop-handle[data-handle="nw"] { left: 0; top: 0; cursor: nwse-resize; }
        .crop-handle[data-handle="n"]  { left: 50%; top: 0; cursor: ns-resize; }
        .crop-handle[data-handle="ne"] { left: 100%; top: 0; cursor: nesw-resize; }
        .crop-handle[data-handle="e"]  { left: 100%; top: 50%; cursor: ew-resize; }
        .crop-handle[data-handle="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
        .crop-handle[data-handle="s"]  { left: 50%; top: 100%; cursor: ns-resize; }
        .crop-handle[data-handle="sw"] { left: 0; top: 100%; cursor: nesw-resize; }
        .crop-handle[data-handle="w"]  { left: 0; top: 50%; cursor: ew-resize; }
        .grid-layer {
          pointer-events: none;
          border: 1px solid rgba(255,255,255,.22);
        }
        .grid-layer .line {
          position: absolute;
          border-color: rgba(255, 255, 255, .62);
          border-style: dashed;
          filter: drop-shadow(0 1px 1px rgba(0,0,0,.8));
        }
        .grid-layer .v1 { left: 33.333%; top: 0; bottom: 0; border-left-width: 1px; }
        .grid-layer .v2 { left: 66.666%; top: 0; bottom: 0; border-left-width: 1px; }
        .grid-layer .h1 { top: 33.333%; left: 0; right: 0; border-top-width: 1px; }
        .grid-layer .h2 { top: 66.666%; left: 0; right: 0; border-top-width: 1px; }
        aside {
          min-height: 0;
          overflow: auto;
          padding: 12px;
          border-left: 1px solid #303642;
          background: #1a1e25;
        }
        .panel { display: none; gap: 10px; }
        .panel.active { display: grid; }
        .panel h3 {
          margin: 0 0 2px;
          font-size: 13px;
          font-weight: 650;
        }
        .field {
          display: grid;
          gap: 5px;
          color: #b7bfcc;
          font-size: 12px;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 7px;
        }
        .row > * { min-width: 0; }
        input[type="number"], input[type="text"], select {
          width: 100%;
          border: 1px solid #404754;
          border-radius: 0;
          background: #252a33;
          color: #edf1f7;
          padding: 6px 8px;
        }
        input[type="checkbox"] {
          width: 15px;
          height: 15px;
          margin: 0;
          accent-color: #4c9aff;
        }
        input.invalid {
          border-color: #e35d5d;
          outline: 1px solid rgba(227, 93, 93, .32);
        }
        input[type="range"] { width: 100%; accent-color: #4c9aff; }
        input[type="color"] {
          width: 42px;
          height: 31px;
          padding: 2px;
          border: 1px solid #404754;
          border-radius: 0;
          background: #252a33;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #c5ccd7;
          font-size: 12px;
        }
        .mask-color-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 34px;
          align-items: center;
          gap: 8px;
        }
        .mask-color-swatch {
          width: 34px;
          height: 31px;
          border: 1px solid #596171;
          background: #000;
        }
        .hint {
          padding: 8px 9px;
          border-radius: 0;
          background: #222832;
          color: #9fa9b8;
          font-size: 11px;
          line-height: 1.55;
        }
        .footer-status {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #9da6b5;
          font-size: 12px;
        }
        .footer-status.error { color: #ff8c8c; }
        .footer-actions {
          display: flex;
          gap: 8px;
          flex: 0 0 auto;
        }
        .busy {
          position: absolute;
          inset: 0;
          display: none;
          place-items: center;
          background: rgba(8, 11, 16, .7);
          color: #fff;
          font-weight: 600;
          z-index: 10;
        }
        .busy.active { display: grid; }
        @media (max-width: 920px) {
          .backdrop { padding: 6px; }
          .window {
            width: calc(100vw - 16px);
            height: calc(100vh - 16px);
          }
          .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 1fr) auto; }
          aside { max-height: 34vh; border-left: 0; border-top: 1px solid #303642; }
          canvas { max-height: 56vh; }
        }
      </style>
      <div class="backdrop">
        <div class="window" role="dialog" aria-modal="false" aria-label="Image Astral image editor">
          <header title="Drag the title bar to move the window.">
            <div>
              <h2>Image Astral · Image Editor</h2>
              <div class="head-meta">Cropping and rotation are done locally in this browser</div>
            </div>
            <button type="button" data-action="close" title="Close">Close</button>
          </header>
          <div class="content">
            <div class="toolbar">
              <button type="button" data-tool="crop" class="active">Crop</button>
              <button type="button" data-tool="rotate">Rotate</button>
              <button type="button" data-action="open-mask-editor" title="Open the ComfyUI official mask editor in the custom editor first">Open Mask Editor</button>
              <button type="button" data-tool="mask-settings" title="Set mask color, hole filling, bevel, invert, and grow">Mask Settings</button>
              <span class="toolbar-spacer"></span>
              <button type="button" data-action="undo">↶ Undo</button>
              <button type="button" data-action="redo">↷ Redo</button>
              <button type="button" data-action="reset" class="danger">Restore Original</button>
            </div>
            <div class="workspace">
              <main class="stage">
                <div class="image-frame">
                  <canvas></canvas>
                  <div class="crop-layer">
                    <div class="crop-box">
                      <span class="crop-handle" data-handle="nw"></span>
                      <span class="crop-handle" data-handle="n"></span>
                      <span class="crop-handle" data-handle="ne"></span>
                      <span class="crop-handle" data-handle="e"></span>
                      <span class="crop-handle" data-handle="se"></span>
                      <span class="crop-handle" data-handle="s"></span>
                      <span class="crop-handle" data-handle="sw"></span>
                      <span class="crop-handle" data-handle="w"></span>
                    </div>
                  </div>
                  <div class="grid-layer" hidden>
                    <span class="line v1"></span>
                    <span class="line v2"></span>
                    <span class="line h1"></span>
                    <span class="line h2"></span>
                  </div>
                  <div class="busy">Uploading edit result…</div>
                </div>
              </main>
              <aside>
                <section class="panel active" data-panel="crop">
                  <h3>Crop</h3>
                  <label class="field">Common aspect ratios
                    <select data-control="crop-ratio">
                      <option value="0">Free</option>
                      <option value="1">1:1</option>
                      <option value="1.3333333333">4:3</option>
                      <option value="0.75">3:4</option>
                      <option value="1.7777777778">16:9</option>
                      <option value="0.5625">9:16</option>
                      <option value="1.5">3:2</option>
                      <option value="0.6666666667">2:3</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <div class="row">
                    <label class="field">Output Width
                      <input data-control="crop-width" type="number" min="1" max="16384" step="1" value="512">
                    </label>
                    <label class="field">Output Height
                      <input data-control="crop-height" type="number" min="1" max="16384" step="1" value="512">
                    </label>
                  </div>
                  <button type="button" data-action="apply-crop" class="primary">Apply Crop</button>
                  <div class="hint">Drag inside the box to move it, drag the eight handles to resize, and drag outside the box to draw a new selection. Custom sizes output at that width and height, scaling up proportionally when the source is too small; the crop box can still be moved before applying. A crop that has not been applied is also applied automatically on final upload.</div>
                </section>
                <section class="panel" data-panel="rotate">
                  <h3>Rotate</h3>
                  <label class="field">Angle
                    <div class="row">
                      <input data-control="angle-number" type="number" min="-180" max="180" step="0.1" value="0">
                      <span>°</span>
                    </div>
                  </label>
                  <input data-control="angle-range" type="range" min="-180" max="180" step="0.1" value="0">
                  <div class="row">
                    <button type="button" data-action="rotate-minus90">-90°</button>
                    <button type="button" data-action="rotate-plus90">+90°</button>
                    <button type="button" data-action="rotate-180">180°</button>
                    <button type="button" data-action="rotate-reset">Reset</button>
                  </div>
                  <button type="button" data-action="apply-rotation" class="primary">Apply Rotation</button>
                  <div class="hint">A dashed rule-of-thirds grid appears while rotating; the canvas expands automatically so rotated corners are not cut off.</div>
                </section>
                <section class="panel" data-panel="mask-settings">
                  <h3>Mask Settings</h3>
                  <label class="field">Mask Color RGB
                    <div class="mask-color-row">
                      <input data-control="mask-color" type="text" value="0,0,0" placeholder="0,0,0" autocomplete="off">
                      <span class="mask-color-swatch" data-role="mask-color-swatch" title="Mask color preview"></span>
                    </div>
                  </label>
                  <label class="checkbox-row">
                    <input data-control="fill-mask-holes" type="checkbox">
                    Fill Mask Holes
                  </label>
                  <label class="checkbox-row">
                    <input data-control="bevel-mask" type="checkbox">
                    Bevel Mask (1 px edge softening)
                  </label>
                  <label class="checkbox-row">
                    <input data-control="invert-mask" type="checkbox">
                    Invert Mask
                  </label>
                  <label class="field">Mask Grow
                    <div class="row">
                      <input data-control="mask-grow-range" type="range" min="-256" max="256" step="1" value="0">
                      <input data-control="mask-grow-number" type="number" min="-256" max="256" step="1" value="0">
                    </div>
                  </label>
                  <div class="hint">Enter RGB values from 0–255, for example 0,0,0. Positive grow values expand outward; negative values shrink inward. These parameters are saved with the node workflow and affect the mask and mask_image outputs.</div>
                </section>
              </aside>
            </div>
          </div>
          <footer>
            <div class="footer-status" data-role="status">Loading image…</div>
            <div class="footer-actions">
              <button type="button" data-action="cancel">Cancel</button>
              <button type="button" data-action="apply" class="primary">Apply and Upload</button>
            </div>
          </footer>
        </div>
      </div>
    `;

    const q = (selector) => this.shadow.querySelector(selector);
    this.window = q(".window");
    this.dragHandle = q("header");
    this.canvas = q("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.stage = q(".stage");
    this.imageFrame = q(".image-frame");
    this.cropLayer = q(".crop-layer");
    this.cropBox = q(".crop-box");
    this.gridLayer = q(".grid-layer");
    this.status = q('[data-role="status"]');
    this.applyButton = q('[data-action="apply"]');
    this.undoButton = q('[data-action="undo"]');
    this.redoButton = q('[data-action="redo"]');
    this.cropRatio = q('[data-control="crop-ratio"]');
    this.cropWidth = q('[data-control="crop-width"]');
    this.cropHeight = q('[data-control="crop-height"]');
    this.angleNumber = q('[data-control="angle-number"]');
    this.angleRange = q('[data-control="angle-range"]');
    this.busyOverlay = q(".busy");
    this.maskColorInput = q('[data-control="mask-color"]');
    this.maskColorSwatch = q('[data-role="mask-color-swatch"]');
    this.fillMaskHolesInput = q('[data-control="fill-mask-holes"]');
    this.bevelMaskInput = q('[data-control="bevel-mask"]');
    this.invertMaskInput = q('[data-control="invert-mask"]');
    this.maskGrowRange = q('[data-control="mask-grow-range"]');
    this.maskGrowNumber = q('[data-control="mask-grow-number"]');

    this.bindEvents();
    this.syncMaskSettings();
  }

  bindEvents() {
    this.dragHandle.addEventListener("pointerdown", (event) => {
      this.startWindowDrag(event);
    });
    this.dragHandle.addEventListener("pointermove", (event) => {
      this.moveWindowDrag(event);
    });
    this.dragHandle.addEventListener("pointerup", (event) => {
      this.endWindowDrag(event);
    });
    this.dragHandle.addEventListener("pointercancel", (event) => {
      this.endWindowDrag(event);
    });

    this.shadow.querySelectorAll("[data-tool]").forEach((button) => {
      button.addEventListener("click", () => this.setTool(button.dataset.tool));
    });
    this.shadow.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => this.handleAction(button.dataset.action));
    });

    this.cropRatio.addEventListener("change", () => {
      const value = this.cropRatio.value;
      this.ratio = value === "custom" ? this.customRatio() : Number(value);
      this.resetCropRect();
      this.cropDirty = true;
    });
    this.cropWidth.addEventListener("change", () => {
      if (this.cropRatio.value === "custom") this.setCustomCropSize();
    });
    this.cropHeight.addEventListener("change", () => {
      if (this.cropRatio.value === "custom") this.setCustomCropSize();
    });

    this.angleNumber.addEventListener("input", () => {
      this.setAngle(Number(this.angleNumber.value) || 0);
    });
    this.angleRange.addEventListener("input", () => {
      this.setAngle(Number(this.angleRange.value) || 0);
    });

    this.maskColorInput.addEventListener("input", () => {
      const color = normalizeRgbColor(this.maskColorInput.value);
      this.maskColorInput.classList.toggle("invalid", !color);
      this.updateMaskColorSwatch(color);
    });
    this.maskColorInput.addEventListener("change", () => {
      this.commitMaskColor();
    });
    this.fillMaskHolesInput.addEventListener("change", () => {
      setNodeWidgetValue(
        this.node,
        "fill_mask_holes",
        this.fillMaskHolesInput.checked,
      );
    });
    this.bevelMaskInput.addEventListener("change", () => {
      setNodeWidgetValue(
        this.node,
        "bevel_mask",
        this.bevelMaskInput.checked,
      );
    });
    this.invertMaskInput.addEventListener("change", () => {
      setNodeWidgetValue(
        this.node,
        "invert_mask",
        this.invertMaskInput.checked,
      );
    });
    this.maskGrowRange.addEventListener("input", () => {
      this.commitMaskGrow(this.maskGrowRange.value);
    });
    this.maskGrowNumber.addEventListener("change", () => {
      this.commitMaskGrow(this.maskGrowNumber.value);
    });

    this.cropLayer.addEventListener("pointerdown", (event) => this.onCropPointerDown(event));
    this.cropLayer.addEventListener("pointermove", (event) => this.onCropPointerMove(event));
    this.cropLayer.addEventListener("pointerup", (event) => this.onCropPointerUp(event));
    this.cropLayer.addEventListener("pointercancel", (event) => this.onCropPointerUp(event));
  }

  startWindowDrag(event) {
    if (
      event.button !== 0 ||
      event.target?.closest?.("button, input, select, textarea, a")
    ) {
      return;
    }
    const rect = this.window.getBoundingClientRect();
    this.window.style.position = "fixed";
    this.window.style.left = `${rect.left}px`;
    this.window.style.top = `${rect.top}px`;
    this.window.style.width = `${rect.width}px`;
    this.window.style.height = `${rect.height}px`;
    this.windowDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    this.dragHandle.classList.add("dragging");
    this.dragHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  moveWindowDrag(event) {
    if (
      !this.windowDrag ||
      event.pointerId !== this.windowDrag.pointerId
    ) {
      return;
    }
    const maxLeft = Math.max(
      0,
      window.innerWidth - this.windowDrag.width,
    );
    const maxTop = Math.max(
      0,
      window.innerHeight - this.windowDrag.height,
    );
    const left = clamp(
      this.windowDrag.left + event.clientX - this.windowDrag.startX,
      0,
      maxLeft,
    );
    const top = clamp(
      this.windowDrag.top + event.clientY - this.windowDrag.startY,
      0,
      maxTop,
    );
    this.window.style.left = `${left}px`;
    this.window.style.top = `${top}px`;
    event.preventDefault();
    event.stopPropagation();
  }

  endWindowDrag(event) {
    if (
      !this.windowDrag ||
      event.pointerId !== this.windowDrag.pointerId
    ) {
      return;
    }
    this.dragHandle.classList.remove("dragging");
    if (this.dragHandle.hasPointerCapture?.(event.pointerId)) {
      this.dragHandle.releasePointerCapture(event.pointerId);
    }
    this.windowDrag = null;
    event.preventDefault();
    event.stopPropagation();
  }

  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  renderBasePreview() {
    if (!this.baseCanvas) return;
    if (
      this.canvas.width !== this.baseCanvas.width ||
      this.canvas.height !== this.baseCanvas.height
    ) {
      this.canvas.width = this.baseCanvas.width;
      this.canvas.height = this.baseCanvas.height;
    }
    this.ctx.save();
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.baseCanvas, 0, 0);
    this.ctx.restore();
  }

  async open() {
    document.body.appendChild(this.host);
    window.addEventListener("keydown", this._keyHandler, true);
    if (globalThis.ResizeObserver) {
      this._stageResizeObserver = new ResizeObserver(() => {
        this.fitCanvasToStage();
      });
      this._stageResizeObserver.observe(this.stage);
    }
    this.setTool("crop");
    await this.loadImage();
  }

  async loadBrowserImage(url, label) {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () =>
        reject(new Error(`${label} failed to load; choose the file again`));
      image.src = url;
    });
    return image;
  }

  async loadImage() {
    const currentPromise = this.loadBrowserImage(this.imageUrl, "Current image");
    const originalPromise =
      this.originalImageUrl && this.originalImageUrl !== this.imageUrl
        ? this.loadBrowserImage(this.originalImageUrl, "Original image").catch(
            (error) => {
              console.warn(
                "[Image Astral] Original image failed to load; using the current image as the restore baseline",
                error,
              );
              return null;
            },
          )
        : currentPromise;
    const [image, loadedOriginal] = await Promise.all([
      currentPromise,
      originalPromise,
    ]);

    this.originalImage = loadedOriginal || image;
    this.baseCanvas = document.createElement("canvas");
    this.baseCanvas.width = image.naturalWidth;
    this.baseCanvas.height = image.naturalHeight;
    this.baseCtx = this.baseCanvas.getContext("2d", { willReadFrequently: true });
    this.baseCtx.drawImage(image, 0, 0);

    this.syncViewFromBase();
    this.resetCropRect();
    this.clearHistory();
    this.pushHistory();
    this.busy = false;
    this.applyButton.disabled = false;
    this.fitCanvasToStage();
    this.setStatus(
      `Current ${image.naturalWidth} × ${image.naturalHeight} px · original ${this.originalImage.naturalWidth} × ${this.originalImage.naturalHeight} px`,
    );
  }

  fitCanvasToStage() {
    if (!this.baseCanvas || !this.stage || !this.canvas) return;
    const style = getComputedStyle(this.stage);
    const availableWidth =
      this.stage.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const availableHeight =
      this.stage.clientHeight -
      (Number.parseFloat(style.paddingTop) || 0) -
      (Number.parseFloat(style.paddingBottom) || 0);
    if (availableWidth <= 0 || availableHeight <= 0) return;

    const scale = Math.min(
      1,
      availableWidth / this.canvas.width,
      availableHeight / this.canvas.height,
    );
    this.canvas.style.width = `${Math.max(1, this.canvas.width * scale)}px`;
    this.canvas.style.height = `${Math.max(1, this.canvas.height * scale)}px`;
    this.updateCropOverlay();
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.classList.toggle("error", !!isError);
  }

  syncMaskSettings() {
    if (!this.maskColorInput) return;
    const color =
      normalizeRgbColor(findWidget(this.node, "mask_color")?.value) ||
      MASK_WIDGET_DEFAULTS.mask_color;
    this.maskColorInput.value = color;
    this.maskColorInput.classList.remove("invalid");
    this.updateMaskColorSwatch(color);

    this.fillMaskHolesInput.checked = widgetBooleanValue(
      findWidget(this.node, "fill_mask_holes"),
      MASK_WIDGET_DEFAULTS.fill_mask_holes,
    );
    this.bevelMaskInput.checked = widgetBooleanValue(
      findWidget(this.node, "bevel_mask"),
      MASK_WIDGET_DEFAULTS.bevel_mask,
    );
    this.invertMaskInput.checked = widgetBooleanValue(
      findWidget(this.node, "invert_mask"),
      MASK_WIDGET_DEFAULTS.invert_mask,
    );
    const grow = clamp(
      Math.round(
        numberValue(
          findWidget(this.node, "mask_grow"),
          MASK_WIDGET_DEFAULTS.mask_grow,
        ),
      ),
      -256,
      256,
    );
    this.maskGrowRange.value = String(grow);
    this.maskGrowNumber.value = String(grow);
  }

  updateMaskColorSwatch(color) {
    if (!this.maskColorSwatch) return;
    this.maskColorSwatch.style.backgroundColor = color
      ? `rgb(${color.replaceAll(",", ", ")})`
      : "#3a3f49";
  }

  commitMaskColor() {
    const color = normalizeRgbColor(this.maskColorInput.value);
    if (!color) {
      this.syncMaskSettings();
      this.setStatus("Invalid mask color format; enter 0–255, e.g. 0,0,0.", true);
      return;
    }
    this.maskColorInput.value = color;
    this.maskColorInput.classList.remove("invalid");
    this.updateMaskColorSwatch(color);
    setNodeWidgetValue(this.node, "mask_color", color);
    this.setStatus(`Mask color set to RGB ${color}.`);
  }

  commitMaskGrow(value) {
    const grow = clamp(Math.round(Number(value) || 0), -256, 256);
    this.maskGrowRange.value = String(grow);
    this.maskGrowNumber.value = String(grow);
    setNodeWidgetValue(this.node, "mask_grow", grow);
    this.setStatus(
      grow === 0
        ? "Mask grow set to 0."
        : grow > 0
          ? `Mask will expand outward by ${grow} px.`
          : `Mask will shrink inward by ${Math.abs(grow)} px.`,
    );
  }

  hasPendingChanges() {
    return (
      this.history.length > 1 ||
      this.cropDirty ||
      Math.abs(this.angle) > 0.01
    );
  }

  async openOfficialMaskEditor() {
    if (this.busy || !this.baseCanvas) return;
    try {
      if (this.hasPendingChanges()) {
        this.setStatus("Saving uncommitted image edits…");
        const saved = await this.applyAndUpload({ closeAfterUpload: false });
        if (!saved) return;
      }
      setNodeStatus(this.node, "Opening the ComfyUI official mask editor…");
      this.close();
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      await openComfyMaskEditorForNode(this.node);
    } catch (error) {
      console.error("[Image Astral] Unable to open the official mask editor", error);
      setNodeStatus(
        this.node,
        error?.message || "Unable to open the ComfyUI official mask editor.",
        true,
      );
    }
  }

  setTool(tool) {
    if (tool !== "rotate" && Math.abs(this.angle) > 0.01) {
      this.applyRotation(false);
    }
    this.tool = tool;
    this.shadow.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    this.shadow.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === tool);
    });
    this.cropLayer.hidden = tool !== "crop" || Math.abs(this.angle) > 0.01;
    this.gridLayer.hidden = tool !== "rotate";
    this.canvas.style.cursor = tool === "crop" ? "crosshair" : "default";
    if (tool === "rotate" && Math.abs(this.angle) <= 0.01) {
      this.syncViewFromBase();
    }
  }

  handleAction(action) {
    if (this.busy && !["close", "cancel"].includes(action)) return;
    switch (action) {
      case "close":
      case "cancel":
        this.close();
        break;
      case "undo":
        this.undo();
        break;
      case "redo":
        this.redo();
        break;
      case "reset":
        this.resetToOriginal();
        break;
      case "apply-crop":
        this.applyCrop();
        break;
      case "open-mask-editor":
        void this.openOfficialMaskEditor();
        break;
      case "rotate-minus90":
        this.setAngle(this.normalizeAngle(this.angle - 90));
        break;
      case "rotate-plus90":
        this.setAngle(this.normalizeAngle(this.angle + 90));
        break;
      case "rotate-180":
        this.setAngle(this.angle >= 0 ? -180 : 180);
        break;
      case "rotate-reset":
        this.setAngle(0);
        break;
      case "apply-rotation":
        this.applyRotation(true);
        break;
      case "apply":
        this.applyAndUpload();
        break;
      default:
        break;
    }
  }

  handleKey(event) {
    if (event.key === "Escape" && !this.busy) {
      event.preventDefault();
      this.close();
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
    }
  }

  normalizeAngle(value) {
    let angle = ((Number(value) + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(angle) < 0.01) angle = 0;
    return angle;
  }

  setAngle(value) {
    if (!this.baseCanvas) return;
    this.angle = this.normalizeAngle(value);
    this.angleNumber.value = String(this.angle);
    this.angleRange.value = String(this.angle);
    this.syncNodeRotationToCanvas();
    this.cropLayer.hidden = this.tool !== "crop" || Math.abs(this.angle) > 0.01;
    this.renderRotationPreview();
  }

  syncNodeRotationToCanvas() {
    if (!this.baseCanvas) return;
    const half = Math.round((this.baseCanvas.width * 0.5) * 10) / 10;
    const halfHeight = Math.round((this.baseCanvas.height * 0.5) * 10) / 10;
    this.cropWidth.placeholder = String(half);
    this.cropHeight.placeholder = String(halfHeight);
  }

  renderRotationPreview() {
    if (!this.baseCanvas) return;
    if (Math.abs(this.angle) < 0.01) {
      this.syncViewFromBase();
      return;
    }

    const radians = (this.angle * Math.PI) / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    const width = Math.max(
      1,
      Math.ceil(this.baseCanvas.width * cosine + this.baseCanvas.height * sine),
    );
    const height = Math.max(
      1,
      Math.ceil(this.baseCanvas.width * sine + this.baseCanvas.height * cosine),
    );

    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.save();
    this.ctx.translate(width / 2, height / 2);
    this.ctx.rotate(radians);
    this.ctx.drawImage(
      this.baseCanvas,
      -this.baseCanvas.width / 2,
      -this.baseCanvas.height / 2,
    );
    this.ctx.restore();
    requestAnimationFrame(() => this.fitCanvasToStage());
    this.setStatus(`Rotation preview ${this.angle.toFixed(1)}° · ${width} × ${height} px`);
  }

  syncViewFromBase() {
    if (!this.baseCanvas) return;
    this.renderBasePreview();
    this.updateCropOverlay();
    requestAnimationFrame(() => this.fitCanvasToStage());
  }

  replaceBaseFromCanvas(canvas) {
    this.baseCanvas = canvas;
    this.baseCtx = canvas.getContext("2d", { willReadFrequently: true });
    this.customCropSize = null;
    this.cropDirty = false;
    this.cropRect = {
      x: 0,
      y: 0,
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
    };
    this.cropWidth.value = String(this.baseCanvas.width);
    this.cropHeight.value = String(this.baseCanvas.height);
  }

  rotateLayer(source, width, height, radians) {
    const rotated = this.createCanvas(width, height);
    const ctx = rotated.getContext("2d");
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(radians);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    ctx.restore();
    return rotated;
  }

  applyRotation(showStatus = true) {
    if (!this.baseCanvas || Math.abs(this.angle) < 0.01) {
      if (showStatus) this.setStatus("There is no rotation to apply.", true);
      return false;
    }
    this.renderRotationPreview();
    const radians = (this.angle * Math.PI) / 180;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const rotated = this.rotateLayer(this.baseCanvas, width, height, radians);
    this.replaceBaseFromCanvas(rotated);
    this.angle = 0;
    this.angleNumber.value = "0";
    this.angleRange.value = "0";
    this.syncViewFromBase();
    this.pushHistory();
    if (showStatus) {
      this.setStatus(`Rotation applied: ${rotated.width} × ${rotated.height} px`);
    }
    return true;
  }

  resetToOriginal() {
    if (!this.originalImage) return;
    const original = document.createElement("canvas");
    original.width = this.originalImage.naturalWidth;
    original.height = this.originalImage.naturalHeight;
    original.getContext("2d").drawImage(this.originalImage, 0, 0);
    this.replaceBaseFromCanvas(original);
    this.angle = 0;
    this.angleNumber.value = "0";
    this.angleRange.value = "0";
    this.syncViewFromBase();
    this.pushHistory();
    this.setStatus("Restored the original image loaded by the node.");
  }

  cropPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * this.baseCanvas.width, 0, this.baseCanvas.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * this.baseCanvas.height, 0, this.baseCanvas.height),
    };
  }

  onCropPointerDown(event) {
    if (this.tool !== "crop" || !this.baseCanvas || event.button !== 0) return;
    event.preventDefault();
    const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
    const insideBox = event.target.closest?.(".crop-box") && !handle;
    const point = this.cropPoint(event);
    this.customCropSize = null;
    if (handle) {
      this.cropDrag = {
        mode: "resize",
        handle,
        start: point,
        rect: { ...this.cropRect },
      };
    } else if (insideBox) {
      this.cropDrag = {
        mode: "move",
        start: point,
        rect: { ...this.cropRect },
      };
    } else {
      this.cropDrag = {
        mode: "new",
        start: point,
        rect: { x: point.x, y: point.y, width: 0, height: 0 },
      };
      this.cropRect = { ...this.cropDrag.rect };
      this.updateCropOverlay();
    }
    this.cropDirty = true;
    this.cropLayer.setPointerCapture(event.pointerId);
  }

  onCropPointerMove(event) {
    if (!this.cropDrag || !this.baseCanvas) return;
    event.preventDefault();
    const point = this.cropPoint(event);
    if (this.cropDrag.mode === "new") {
      this.cropRect = this.makeCropRect(
        this.cropDrag.start.x,
        this.cropDrag.start.y,
        point.x,
        point.y,
      );
    } else if (this.cropDrag.mode === "move") {
      const dx = point.x - this.cropDrag.start.x;
      const dy = point.y - this.cropDrag.start.y;
      this.cropRect = {
        x: clamp(this.cropDrag.rect.x + dx, 0, this.baseCanvas.width - this.cropDrag.rect.width),
        y: clamp(this.cropDrag.rect.y + dy, 0, this.baseCanvas.height - this.cropDrag.rect.height),
        width: this.cropDrag.rect.width,
        height: this.cropDrag.rect.height,
      };
    } else {
      this.cropRect = this.resizeCropRect(
        this.cropDrag.rect,
        this.cropDrag.handle,
        point,
      );
    }
    this.updateCropOverlay();
  }

  onCropPointerUp(event) {
    if (!this.cropDrag) return;
    this.cropDrag = null;
    if (this.cropLayer.hasPointerCapture(event.pointerId)) {
      this.cropLayer.releasePointerCapture(event.pointerId);
    }
    if (this.cropRect.width < 16 || this.cropRect.height < 16) {
      this.resetCropRect();
      this.cropDirty = false;
      return;
    }
    this.cropWidth.value = String(Math.round(this.cropRect.width));
    this.cropHeight.value = String(Math.round(this.cropRect.height));
    this.updateCropOverlay();
    this.setStatus(
      `Crop box ${Math.round(this.cropRect.width)} × ${Math.round(this.cropRect.height)} px`,
    );
  }

  fitRatioCropSize(desiredWidth, desiredHeight, maxWidth, maxHeight) {
    const ratio = this.ratio || 0;
    if (!(ratio > 0)) {
      return {
        width: clamp(desiredWidth, 0, Math.max(0, maxWidth)),
        height: clamp(desiredHeight, 0, Math.max(0, maxHeight)),
      };
    }

    const maxRatioWidth = Math.max(0, Math.min(maxWidth, maxHeight * ratio));
    if (maxRatioWidth <= 0) return { width: 0, height: 0 };
    const minimumWidth = Math.min(16, maxRatioWidth);
    const requestedWidth = Math.max(
      0,
      Math.min(desiredWidth, desiredHeight * ratio),
    );
    const width = clamp(requestedWidth, minimumWidth, maxRatioWidth);
    return { width, height: width / ratio };
  }

  makeCropRect(x1, y1, x2, y2) {
    const dragRight = x2 >= x1;
    const dragDown = y2 >= y1;
    const maxWidth = dragRight
      ? this.baseCanvas.width - x1
      : x1;
    const maxHeight = dragDown
      ? this.baseCanvas.height - y1
      : y1;
    const { width, height } = this.fitRatioCropSize(
      Math.abs(x2 - x1),
      Math.abs(y2 - y1),
      maxWidth,
      maxHeight,
    );
    return {
      x: dragRight ? x1 : x1 - width,
      y: dragDown ? y1 : y1 - height,
      width,
      height,
    };
  }

  resizeCropRect(rect, handle, point) {
    const ratio = this.ratio || 0;
    const handlesWest = handle.includes("w");
    const handlesEast = handle.includes("e");
    const handlesNorth = handle.includes("n");
    const handlesSouth = handle.includes("s");

    if (ratio > 0) {
      const anchorX = handlesWest ? rect.x + rect.width : rect.x;
      const anchorY = handlesNorth ? rect.y + rect.height : rect.y;

      if ((handlesWest || handlesEast) && (handlesNorth || handlesSouth)) {
        const maxWidth = handlesWest ? anchorX : this.baseCanvas.width - anchorX;
        const maxHeight = handlesNorth ? anchorY : this.baseCanvas.height - anchorY;
        const { width, height } = this.fitRatioCropSize(
          Math.abs(point.x - anchorX),
          Math.abs(point.y - anchorY),
          maxWidth,
          maxHeight,
        );
        return {
          x: handlesWest ? anchorX - width : anchorX,
          y: handlesNorth ? anchorY - height : anchorY,
          width,
          height,
        };
      }

      if (handlesWest || handlesEast) {
        const maxWidth = handlesWest ? anchorX : this.baseCanvas.width - anchorX;
        const desiredWidth = Math.abs(point.x - anchorX);
        const { width, height } = this.fitRatioCropSize(
          desiredWidth,
          desiredWidth / ratio,
          maxWidth,
          this.baseCanvas.height,
        );
        const centerY = rect.y + rect.height / 2;
        return {
          x: handlesWest ? anchorX - width : anchorX,
          y: clamp(centerY - height / 2, 0, this.baseCanvas.height - height),
          width,
          height,
        };
      }

      const maxHeight = handlesNorth ? anchorY : this.baseCanvas.height - anchorY;
      const desiredHeight = Math.abs(point.y - anchorY);
      const { width, height } = this.fitRatioCropSize(
        desiredHeight * ratio,
        desiredHeight,
        this.baseCanvas.width,
        maxHeight,
      );
      const centerX = rect.x + rect.width / 2;
      return {
        x: clamp(centerX - width / 2, 0, this.baseCanvas.width - width),
        y: handlesNorth ? anchorY - height : anchorY,
        width,
        height,
      };
    }

    let left = rect.x;
    let top = rect.y;
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    if (handlesWest) left = clamp(point.x, 0, right - 16);
    if (handlesEast) right = clamp(point.x, left + 16, this.baseCanvas.width);
    if (handlesNorth) top = clamp(point.y, 0, bottom - 16);
    if (handlesSouth) bottom = clamp(point.y, top + 16, this.baseCanvas.height);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  updateCropOverlay() {
    if (!this.baseCanvas) return;
    const width = Math.max(1, this.baseCanvas.width);
    const height = Math.max(1, this.baseCanvas.height);
    const rect = this.cropRect;
    this.cropBox.style.left = `${(rect.x / width) * 100}%`;
    this.cropBox.style.top = `${(rect.y / height) * 100}%`;
    this.cropBox.style.width = `${(rect.width / width) * 100}%`;
    this.cropBox.style.height = `${(rect.height / height) * 100}%`;
  }

  resetCropRect() {
    if (!this.baseCanvas) return;
    const ratio = this.ratio || 0;
    if (ratio > 0) {
      let width = this.baseCanvas.width;
      let height = width / ratio;
      if (height > this.baseCanvas.height) {
        height = this.baseCanvas.height;
        width = height * ratio;
      }
      this.cropRect = {
        x: (this.baseCanvas.width - width) / 2,
        y: (this.baseCanvas.height - height) / 2,
        width,
        height,
      };
    } else {
      this.cropRect = {
        x: 0,
        y: 0,
        width: this.baseCanvas.width,
        height: this.baseCanvas.height,
      };
    }
    this.cropWidth.value = String(Math.round(this.cropRect.width));
    this.cropHeight.value = String(Math.round(this.cropRect.height));
    this.updateCropOverlay();
  }

  customRatio() {
    const width = Math.max(1, Number(this.cropWidth.value) || 512);
    const height = Math.max(1, Number(this.cropHeight.value) || 512);
    return width / height;
  }

  setCustomCropSize() {
    if (!this.baseCanvas || this.cropRatio.value !== "custom") return;
    const width = Math.round(clamp(Number(this.cropWidth.value) || 512, 1, MAX_CROP_EDGE));
    const height = Math.round(clamp(Number(this.cropHeight.value) || 512, 1, MAX_CROP_EDGE));
    if (width * height > MAX_CROP_PIXELS) {
      this.setStatus(
        `Custom size too large: ${width} × ${height} exceeds the ${MAX_CROP_PIXELS / 1048576} megapixel limit.`,
        true,
      );
      return;
    }
    this.cropWidth.value = String(width);
    this.cropHeight.value = String(height);

    const ratio = width / height;
    this.ratio = ratio;
    const cropWidth = Math.min(
      this.baseCanvas.width,
      this.baseCanvas.height * ratio,
    );
    const cropHeight = cropWidth / ratio;
    this.cropRect = {
      x: (this.baseCanvas.width - cropWidth) / 2,
      y: (this.baseCanvas.height - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    };
    this.customCropSize = { width, height };
    this.cropDirty = true;
    this.updateCropOverlay();
    const sourceText =
      Math.round(cropWidth) === width && Math.round(cropHeight) === height
        ? `Source area ${width} × ${height}`
        : `Source area ${Math.round(cropWidth)} × ${Math.round(cropHeight)}, scaled proportionally to ${width} × ${height} on apply`;
    this.setStatus(`Custom output ${width} × ${height} px · ${sourceText}`);
  }

  applyCrop(showStatus = true) {
    if (!this.baseCanvas) return false;
    const customSize = this.customCropSize;
    const x = clamp(Math.round(this.cropRect.x), 0, this.baseCanvas.width - 1);
    const y = clamp(Math.round(this.cropRect.y), 0, this.baseCanvas.height - 1);
    const sourceWidth = clamp(Math.round(this.cropRect.width), 1, this.baseCanvas.width - x);
    const sourceHeight = clamp(Math.round(this.cropRect.height), 1, this.baseCanvas.height - y);
    const width = customSize?.width ?? sourceWidth;
    const height = customSize?.height ?? sourceHeight;
    if (width < 1 || height < 1 || sourceWidth < 1 || sourceHeight < 1) return false;

    const cropLayer = (source) => {
      const cropped = this.createCanvas(width, height);
      const ctx = cropped.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        source,
        x,
        y,
        sourceWidth,
        sourceHeight,
        0,
        0,
        width,
        height,
      );
      return cropped;
    };
    const cropped = cropLayer(this.baseCanvas);
    this.replaceBaseFromCanvas(cropped);
    this.cropDirty = false;
    this.syncViewFromBase();
    this.resetCropRect();
    this.pushHistory();
    if (showStatus) this.setStatus(`Crop applied: ${width} × ${height} px`);
    return true;
  }

  captureState() {
    const baseData = this.baseCtx.getImageData(
      0,
      0,
      this.baseCanvas.width,
      this.baseCanvas.height,
    );
    return {
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
      baseData,
      byteLength: baseData.data.byteLength,
    };
  }

  restoreState(state) {
    const canvas = this.createCanvas(state.width, state.height);
    canvas.getContext("2d").putImageData(state.baseData, 0, 0);
    this.replaceBaseFromCanvas(canvas);
    this.angle = 0;
    this.angleNumber.value = "0";
    this.angleRange.value = "0";
    this.syncViewFromBase();
    this.resetCropRect();
    this.cropDirty = false;
  }

  clearHistory() {
    this.history = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.updateHistoryButtons();
  }

  pushHistory() {
    if (!this.baseCanvas) return;
    const state = this.captureState();
    this.history.push(state);
    this.historyBytes += state.byteLength;
    this.redoStack = [];
    const maxBytes = 256 * 1024 * 1024;
    while (this.history.length > 20) {
      const removed = this.history.shift();
      this.historyBytes -= removed.byteLength;
    }
    while (this.history.length > 1 && this.historyBytes > maxBytes) {
      const removed = this.history.shift();
      this.historyBytes -= removed.byteLength;
    }
    this.updateHistoryButtons();
  }

  undo() {
    if (this.history.length <= 1) return;
    const current = this.history.pop();
    this.historyBytes -= current.byteLength;
    this.redoStack.push(current);
    this.restoreState(this.history[this.history.length - 1]);
    this.updateHistoryButtons();
    this.setStatus("Undone.");
  }

  redo() {
    const state = this.redoStack.pop();
    if (!state) return;
    this.restoreState(state);
    this.history.push(state);
    this.historyBytes += state.byteLength;
    this.updateHistoryButtons();
    this.setStatus("Redone.");
  }

  updateHistoryButtons() {
    this.undoButton.disabled = this.history.length <= 1;
    this.redoButton.disabled = this.redoStack.length === 0;
  }

  setBusy(value) {
    this.busy = value;
    this.busyOverlay.classList.toggle("active", value);
    this.applyButton.disabled = value;
  }

  async applyAndUpload({ closeAfterUpload = true } = {}) {
    if (this.busy || !this.baseCanvas) return false;
    if (Math.abs(this.angle) > 0.01) this.applyRotation(false);
    if (this.cropDirty) this.applyCrop(false);

    this.setBusy(true);
    this.setStatus("Encoding PNG and uploading to the ComfyUI input directory…");
    try {
      const blob = await new Promise((resolve, reject) => {
        this.baseCanvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("PNG encoding failed"))),
          "image/png",
        );
      });
      const stamp = new Date()
        .toISOString()
        .replaceAll("-", "")
        .replaceAll(":", "")
        .replace("T", "_")
        .replace("Z", "");
      const suffix = Math.random().toString(36).slice(2, 8);
      const filename = `image_astral_edit_${stamp}_${suffix}.png`;
      const form = new FormData();
      form.append("image", new File([blob], filename, { type: "image/png" }));
      form.append("subfolder", "image_astral/edited");
      form.append("type", "input");

      const response = await api.fetchApi("/upload/image", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Upload failed: HTTP ${response.status}${detail ? ` · ${detail.slice(0, 180)}` : ""}`,
        );
      }
      const result = await response.json();
      const path = result.subfolder
        ? `${result.subfolder}/${result.name}`
        : result.name;
      this.onApplied?.(path, {
        width: this.baseCanvas.width,
        height: this.baseCanvas.height,
      });
      this.setStatus(`Saved and written back: ${path}`);
      this.setBusy(false);
      if (closeAfterUpload) this.close();
      return true;
    } catch (error) {
      console.error("[Image Astral] Editor upload failed", error);
      this.setBusy(false);
      this.setStatus(error?.message || "Failed to upload the edit result", true);
      return false;
    }
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this._stageResizeObserver?.disconnect();
    window.removeEventListener("keydown", this._keyHandler, true);
    this.host.remove();
    this.onClosed?.();
  }
}

app.registerExtension({
  name: "Image.Astral.NodeTypeMigration",
  beforeConfigureGraph(graphData) {
    migrateLegacyNodeTypes(graphData);
  },
  beforeRegisterVueAppNodeDefs(nodeDefs) {
    hideDuplicateLegacyNodeDefs(nodeDefs);
  },
  setup() {
    for (const legacyType of Object.keys(LEGACY_NODE_TYPES)) {
      LiteGraph.unregisterNodeType?.(legacyType);
    }
  },
});

app.registerExtension({
  name: "Image.Astral.ImageLoadEditor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== EDITOR_NODE_ID) return;
    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      this._astralHadSavedSize =
        Array.isArray(args[0]?.size) && args[0].size.length >= 2;
      args[0] = migrateSerializedWidgetValues(this, args[0]);
      const result = originalConfigure?.apply(this, args);
      trimImageEditorOutputs(this);
      // Hide the inactive target/parameter rows before the canvas performs its
      // first layout pass. Otherwise all rows briefly count as visible and the
      // frontend expands restored nodes from the saved size to roughly 800px.
      syncNodeControls(this);
      window.setTimeout(() => {
        syncNodeControls(this);
        initializeImageNodeSize(this);
      }, 0);
      window.setTimeout(() => trimImageEditorOutputs(this), 0);
      return result;
    };
    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      trimImageEditorOutputs(this);
      activateImageNode(this);
      return result;
    };
  },
});

app.registerExtension({
  name: "Image.Astral.ResolutionSelector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== RESOLUTION_SELECTOR_NODE_ID) return;

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      const result = originalConfigure?.apply(this, args);
      hookResolutionSelectorWidgets(this);
      window.setTimeout(() => syncResolutionSelectorWidgets(this), 0);
      return result;
    };

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      hookResolutionSelectorWidgets(this);
      return result;
    };
  },
});
