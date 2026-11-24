/* global OcctJS */

const defaultColor = { r: 0.47, g: 0.57, b: 0.62 };

function packMesh(mesh, transfer) {
  if (mesh.positions.length < 9 || mesh.indices.length < 3) return null;

  const positions = new Float32Array(mesh.positions);
  const normal = mesh.normals.length === positions.length ? new Float32Array(mesh.normals) : null;
  const IndexArray = positions.length / 3 <= 65536 ? Uint16Array : Uint32Array;
  const index = new IndexArray(mesh.indices);
  const { r, g, b } = mesh.color ?? defaultColor;
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = r;
    colors[i + 1] = g;
    colors[i + 2] = b;
  }

  // XDE supplies linear RGB, and each tessellated face has its own vertices.
  for (const { color, firstIndex, indexCount } of mesh.faces) {
    if (!color) continue;
    const rgb = [color.r, color.g, color.b];
    const end = Math.min(index.length, firstIndex + indexCount);
    for (let i = firstIndex; i < end; i++) colors.set(rgb, index[i] * 3);
  }
  transfer.push(positions.buffer, colors.buffer, index.buffer);
  if (normal) transfer.push(normal.buffer);
  return { positions, normal, index, colors };
}

self.onmessage = async ({ data: { buffer, runtimeUrl, wasmUrl, wasmBinary } }) => {
  try {
    const bytes = new Uint8Array(buffer);
    const header = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
    if (!header.startsWith('ISO-10303-21;')) {
      throw new Error('无法识别 STEP 文件，请确认文件内容或重新从 CAD 软件导出。');
    }

    let parser;
    try {
      if (runtimeUrl) importScripts(runtimeUrl);
      parser = await OcctJS(wasmBinary ? { wasmBinary } : { locateFile: () => wasmUrl });
    } catch (error) {
      console.error(error);
      throw new Error('STEP 解析器加载失败，请刷新页面后重试。');
    }
    const parsed = parser.ReadStepFile(bytes, {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.25,
      readColors: true,
    });
    if (!parsed.success) throw new Error('STEP 解析失败，请确认文件完整或重新导出。');

    const transfer = [];
    const meshes = parsed.geometries.map((mesh) => packMesh(mesh, transfer));
    self.postMessage({ roots: parsed.rootNodes, meshes }, transfer);
  } catch (error) {
    self.postMessage({ error: error.message || '读取 STEP 时发生错误。' });
  }
};
