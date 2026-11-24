import './style.css';
import { StepViewer } from './viewer.js';
import runtimeAsset from '@tx-code/occt-js/dist/occt-js.js?url';
import wasmAsset from '@tx-code/occt-js/dist/occt-js.wasm?url';

const byId = (id) => document.getElementById(id);
const fileInput = byId('file-input');
const fileName = byId('file-name');
const viewArea = byId('view-area');
const imageStage = byId('image-stage');
const emptyView = byId('empty-view');
const loadingView = byId('loading-view');
const dropView = byId('drop-view');
const axes = byId('axes');
const fitView = byId('fit-view');
const viewButtons = [...document.querySelectorAll('[data-view]')];
const sizePreset = byId('size-preset');
const widthInput = byId('image-width');
const heightInput = byId('image-height');
const background = byId('background');
const quality = byId('quality');
const download = byId('download');
const notice = byId('notice');
const assetRoot = new URL(import.meta.env.BASE_URL, location.href);
const dimensions = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 5, useGrouping: false });

let viewer;
let activeFileName;
let pendingImport;
let exporting = false;
let contextAvailable = true;
let view = 'iso';
let imageSize = { width: 1920, height: 1080 };
let sizeValid = true;
let pngBackground = 'transparent';
let parserAssets;

function notify(message, error = false) {
  notice.hidden = !message;
  notice.dataset.error = String(error);
  notice.textContent = message;
}

function markView(preset) {
  view = preset;
  for (const button of viewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.view === preset));
  }
  const button = viewButtons.find((item) => item.dataset.view === preset);
  byId('view-label').textContent = button ? button.firstElementChild.textContent : '自定义视角';
}

function syncAvailability() {
  const hasModel = Boolean(activeFileName);
  fitView.disabled = !hasModel || Boolean(pendingImport) || !contextAvailable;
  download.disabled = fitView.disabled || exporting || !sizeValid;
}

function fitStage() {
  if (!activeFileName) return;
  const aspect = imageSize.width / imageSize.height;
  const padding = viewArea.clientWidth < 500 ? 18 : 42;
  const maxWidth = viewArea.clientWidth - padding;
  const maxHeight = viewArea.clientHeight - padding;
  if (maxWidth < 1 || maxHeight < 1) return;
  const width = Math.min(maxWidth, maxHeight * aspect);
  const height = width / aspect;
  imageStage.style.width = `${width}px`;
  imageStage.style.height = `${height}px`;
  viewer.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), aspect);
}

function selectedFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

function syncExportSettings() {
  const format = selectedFormat();
  const maxSize = viewer?.maxImageSize ?? 4096;
  const custom = sizePreset.value === 'custom';
  for (const option of sizePreset.options) {
    if (option.value === 'custom') continue;
    option.disabled = option.value.split('x').some((value) => Number(value) > maxSize);
  }
  if (sizePreset.selectedOptions[0].disabled) {
    sizePreset.value = [...sizePreset.options].find((option) => !option.disabled).value;
    return syncExportSettings();
  }
  byId('custom-size').hidden = !custom;
  widthInput.max = heightInput.max = maxSize;
  const [width, height] = custom
    ? [widthInput.valueAsNumber, heightInput.valueAsNumber]
    : sizePreset.value.split('x').map(Number);
  const valid = (value) => Number.isInteger(value) && value >= 64 && value <= maxSize;
  widthInput.setAttribute('aria-invalid', String(custom && !valid(width)));
  heightInput.setAttribute('aria-invalid', String(custom && !valid(height)));
  sizeValid = valid(width) && valid(height);
  if (sizeValid) {
    imageSize = { width, height };
    if (!custom) {
      widthInput.value = width;
      heightInput.value = height;
    }
  }

  byId('export-note').textContent = sizeValid
    ? '导出当前画面，无坐标轴和界面元素。'
    : `宽度和高度需为 64–${maxSize} px 的整数。`;

  const isJpg = format === 'jpg';
  background.options[0].disabled = isJpg;
  if (isJpg && background.value === 'transparent') background.value = 'white';
  byId('jpg-settings').hidden = !isJpg;
  byId('quality-value').value = `${quality.value}%`;
  byId('download-label').textContent = exporting ? '正在生成…' : `下载 ${format.toUpperCase()}`;
  imageStage.dataset.background = background.value;
  viewer?.setBackground(background.value);
  syncAvailability();
  fitStage();
}

function decodeOfflineAsset(name) {
  const data = atob(byId(`offline-${name}`).textContent);
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = data.charCodeAt(i);
  return bytes;
}

function parserAssetUrls() {
  if (!byId('offline-worker')) {
    return {
      runtimeUrl: new URL(runtimeAsset, location.href).href,
      wasmUrl: new URL(wasmAsset, location.href).href,
      workerUrl: new URL('step-worker.js', assetRoot),
    };
  }

  return {
    workerUrl: URL.createObjectURL(new Blob(
      [decodeOfflineAsset('runtime'), ';\n', decodeOfflineAsset('worker')], { type: 'text/javascript' },
    )),
    wasmBinary: decodeOfflineAsset('wasm'),
  };
}

async function parseFile(readBytes, signal) {
  const buffer = await readBytes(signal);
  signal.throwIfAborted();
  const { workerUrl, ...parserOptions } = parserAssets ??= parserAssetUrls();
  const worker = new Worker(workerUrl);
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        console.error(event.message);
        reject(new Error('STEP 解析器运行失败，请刷新页面或尝试较小的模型。'));
      };
      worker.onmessageerror = () => reject(new Error('无法读取解析后的模型。'));
      worker.postMessage({ buffer, ...parserOptions }, [buffer]);
    });
  } finally {
    signal.removeEventListener('abort', abort);
    worker.terminate();
  }
}

async function importFile(name, readBytes) {
  if (!/\.(step|stp)$/i.test(name)) {
    notify('请选择 .step 或 .stp 文件。', true);
    return;
  }

  pendingImport?.abort();
  const request = new AbortController();
  pendingImport = request;
  notify('');
  loadingView.hidden = false;
  loadingView.lastElementChild.textContent = `正在解析 ${name}…`;
  syncAvailability();

  try {
    const data = await parseFile(readBytes, request.signal);
    request.signal.throwIfAborted();
    if (!viewer) {
      try {
        viewer = new StepViewer(byId('render-target'), axes, markView, (available) => {
          contextAvailable = available;
          notify(available ? '三维预览已恢复。' : '三维预览已中断，等待浏览器恢复图形上下文。', !available);
          syncAvailability();
        });
      } catch (error) {
        console.error(error);
        throw new Error('浏览器无法启动三维预览，请启用支持 WebGL 2 的浏览器或图形加速。');
      }
    }

    const size = viewer.setModel(data, view ?? 'iso');
    activeFileName = name;
    fileName.textContent = name;
    fileName.title = name;
    byId('model-info').textContent = `${size.map((value) => dimensions.format(value)).join(' × ')} mm`;
    emptyView.hidden = true;
    imageStage.hidden = false;
    axes.hidden = false;
    syncExportSettings();
  } catch (error) {
    if (!request.signal.aborted) notify(error.message || '导入 STEP 失败。', true);
  } finally {
    if (pendingImport === request) {
      pendingImport = null;
      loadingView.hidden = true;
      syncAvailability();
    }
  }
}

function openLocalFile(file) {
  if (file) importFile(file.name, () => file.arrayBuffer());
}

byId('open-example').addEventListener('click', () => {
  const example = new URL('examples/sample-module.step', assetRoot);
  importFile('sample-module.step', async (signal) => {
    if (byId('offline-example')) return decodeOfflineAsset('example').buffer;
    const response = await fetch(example, { signal });
    if (!response.ok) throw new Error('示例加载失败，请刷新页面后重试。');
    return response.arrayBuffer();
  });
});

for (const id of ['open-file', 'empty-open']) {
  byId(id).addEventListener('click', () => fileInput.click());
}
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  fileInput.value = '';
  openLocalFile(file);
});

let dragDepth = 0;
const isFileDrop = (event) => event.dataTransfer?.types.includes('Files');
document.addEventListener('dragover', (event) => {
  if (isFileDrop(event)) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (isFileDrop(event)) event.preventDefault();
});
viewArea.addEventListener('dragenter', (event) => {
  if (!isFileDrop(event)) return;
  event.preventDefault();
  dragDepth++;
  dropView.hidden = false;
});
viewArea.addEventListener('dragover', (event) => {
  if (isFileDrop(event)) event.dataTransfer.dropEffect = 'copy';
});
viewArea.addEventListener('dragleave', (event) => {
  if (!isFileDrop(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  dropView.hidden = dragDepth === 0;
});
viewArea.addEventListener('drop', (event) => {
  if (!isFileDrop(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropView.hidden = true;
  const files = event.dataTransfer.files;
  if (files.length === 1) openLocalFile(files[0]);
  else if (files.length > 1) notify('每次可导入一个 STEP 文件。', true);
});

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    const preset = button.dataset.view;
    if (viewer && activeFileName) viewer.setView(preset);
    else markView(preset);
  });
}
fitView.addEventListener('click', () => viewer.fit());
new ResizeObserver(fitStage).observe(viewArea);

for (const input of document.querySelectorAll('input[name="format"]')) {
  input.addEventListener('change', () => {
    if (selectedFormat() === 'png') background.value = pngBackground;
    else pngBackground = background.value;
    syncExportSettings();
  });
}
background.addEventListener('change', () => {
  if (selectedFormat() === 'png') pngBackground = background.value;
  syncExportSettings();
});
sizePreset.addEventListener('change', syncExportSettings);
widthInput.addEventListener('input', syncExportSettings);
heightInput.addEventListener('input', syncExportSettings);
quality.addEventListener('input', syncExportSettings);

download.addEventListener('click', async () => {
  const format = selectedFormat();
  const settings = { ...imageSize, format, quality: Number(quality.value) / 100 };
  const basename = activeFileName.replace(/\.(step|stp)$/i, '') || 'model';
  const suffix = view ?? 'custom';
  const name = `${basename}-${suffix}-${settings.width}x${settings.height}.${format}`;
  exporting = true;
  syncExportSettings();
  notify('');

  try {
    const blob = await viewer.exportImage(settings);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify(`已生成 ${name}`);
  } catch (error) {
    notify(error.message || '导出失败，请尝试较小的尺寸。', true);
  } finally {
    exporting = false;
    syncExportSettings();
  }
});

syncExportSettings();
