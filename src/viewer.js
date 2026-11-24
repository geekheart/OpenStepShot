import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const directions = {
  iso: [1, -1, 1],
  top: [0, -0.000001, 1],
  bottom: [0, -0.000001, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

const backgrounds = { transparent: null, white: '#ffffff', dark: '#172320' };

function buildModel({ roots, meshes }, material) {
  const geometries = meshes.map((mesh) => {
    if (!mesh) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    if (mesh.normal) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
    } else {
      geometry.computeVertexNormals();
    }
    return geometry;
  });

  function buildNode(node) {
    const group = new THREE.Group();
    group.matrix.fromArray(node.transform);
    group.matrixAutoUpdate = false;
    for (const index of node.meshes) {
      const geometry = geometries[index];
      if (geometry) group.add(new THREE.Mesh(geometry, material));
    }
    for (const child of node.children) group.add(buildNode(child));
    return group;
  }

  const model = new THREE.Group();
  for (const node of roots) model.add(buildNode(node));
  return model;
}

function drawAxes(canvas, camera) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const axes = [
    { label: 'X', vector: new THREE.Vector3(1, 0, 0), color: '#f48e8e' },
    { label: 'Y', vector: new THREE.Vector3(0, 1, 0), color: '#a4edbe' },
    { label: 'Z', vector: new THREE.Vector3(0, 0, 1), color: '#8ec6f4' },
  ];
  const rotation = camera.quaternion.clone().invert();
  for (const axis of axes) axis.vector.applyQuaternion(rotation);
  axes.sort((a, b) => a.vector.z - b.vector.z);
  context.clearRect(0, 0, 86, 86);
  context.lineWidth = 1.5;
  context.font = '11px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const { vector, label, color } of axes) {
    const x = vector.x * 23;
    const y = -vector.y * 23;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(43, 43);
    context.lineTo(43 + x, 43 + y);
    context.stroke();
    if (Math.hypot(x, y) > 3) {
      context.fillText(label, 43 + vector.x * 34, 43 - vector.y * 34);
    }
  }
  context.fillStyle = '#d6e8df';
  context.beginPath();
  context.arc(43, 43, 2.5, 0, Math.PI * 2);
  context.fill();
}

export class StepViewer {
  constructor(target, axes, onViewChange, onContextChange) {
    this.axes = axes;
    this.onViewChange = onViewChange;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    const gl = this.renderer.getContext();
    this.maxImageSize = Math.min(
      4096,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      ...gl.getParameter(gl.MAX_VIEWPORT_DIMS),
    );
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', 'STEP 三维模型。方向键旋转，滚轮缩放。');
    canvas.tabIndex = 0;
    target.append(canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.minZoom = 0.08;
    this.controls.maxZoom = 20;
    this.controls.rotateSpeed = 0.75;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.07, side: THREE.DoubleSide,
    });
    this.scene.add(new THREE.HemisphereLight(0xf0f6ff, 0xa2afa8, 2));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    for (const [intensity, x, y, z] of [[2.3, 3, -4, 6], [0.9, -4, 2, 1], [1.25, 1, 5, -4]]) {
      const light = new THREE.DirectionalLight(0xffffff, intensity);
      light.position.set(x, y, z);
      this.scene.add(light);
    }

    this.controls.addEventListener('change', () => {
      if (this.preset) {
        const forward = this.camera.position.clone().sub(this.controls.target).normalize();
        const expected = new THREE.Vector3(...directions[this.preset]).normalize();
        if (forward.dot(expected) < 1 - 1e-8) this.markView(null);
      }
      this.invalidate();
    });
    canvas.addEventListener('keydown', (event) => this.rotateWithKey(event));
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      onContextChange(false);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      onContextChange(true);
      this.invalidate();
    });
  }

  rotateWithKey(event) {
    if (!this.controls.enabled) return;
    const arrow = {
      ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0],
      ArrowUp: [0, -0.12], ArrowDown: [0, 0.12],
    }[event.key];
    if (!arrow) return;
    event.preventDefault();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const toYUp = new THREE.Quaternion().setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
    const orbit = new THREE.Spherical().setFromVector3(offset.applyQuaternion(toYUp));
    orbit.theta += arrow[0];
    orbit.phi += arrow[1];
    orbit.makeSafe();
    this.camera.position.copy(offset.setFromSpherical(orbit).applyQuaternion(toYUp.invert())).add(this.controls.target);
    this.controls.update();
  }

  setModel(data, view) {
    const model = buildModel(data, this.material);
    const bounds = new THREE.Box3().setFromObject(model, true);
    const size = bounds.getSize(new THREE.Vector3());
    if (bounds.isEmpty() || !Number.isFinite(size.lengthSq()) || size.lengthSq() === 0) {
      throw new Error('STEP 未包含可显示的实体或曲面。');
    }
    model.position.sub(bounds.getCenter(new THREE.Vector3()));
    if (this.model) {
      this.scene.remove(this.model);
      const geometries = new Set();
      this.model.traverse((object) => {
        if (object.isMesh) geometries.add(object.geometry);
      });
      for (const geometry of geometries) geometry.dispose();
    }
    this.model = model;
    this.scene.add(model);
    this.halfSize = size.clone().multiplyScalar(0.5);
    this.radius = this.halfSize.length();
    this.camera.near = this.radius * 0.001;
    this.camera.far = this.radius * 10;
    this.controls.enabled = true;
    this.setView(view);
    return size.toArray();
  }

  markView(preset) {
    this.preset = preset;
    this.onViewChange(preset);
  }

  setView(view) {
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(...directions[view]).setLength(this.radius * 3);
    this.markView(view);
    this.fit();
  }

  fit() {
    this.camera.position.sub(this.controls.target).setLength(this.radius * 3);
    this.controls.target.set(0, 0, 0);
    this.camera.zoom = 1;
    this.controls.update();
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const extent = (vector) =>
      Math.abs(vector.x) * this.halfSize.x +
      Math.abs(vector.y) * this.halfSize.y +
      Math.abs(vector.z) * this.halfSize.z;
    this.halfViewWidth = extent(right);
    this.halfViewHeight = extent(up);
    this.updateProjection();
  }

  resize(width, height, imageAspect) {
    this.width = width;
    this.height = height;
    this.aspect = imageAspect;
    this.renderer.setSize(width, height, false);
    this.updateProjection();
  }

  updateProjection() {
    const aspect = this.aspect ?? 16 / 9;
    const halfHeight = Math.max(this.halfViewHeight, this.halfViewWidth / aspect, this.radius * 0.02) * 1.23;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setBackground(background) {
    const color = backgrounds[background];
    this.scene.background = color ? new THREE.Color(color) : null;
    this.invalidate();
  }

  invalidate() {
    if (this.frame || !this.width) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
      drawAxes(this.axes, this.camera);
    });
  }

  exportImage({ width, height, format, quality }) {
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    this.renderer.setPixelRatio(1);
    try {
      this.renderer.setSize(width, height, false);
      this.renderer.render(this.scene, this.camera);
      return new Promise((resolve, reject) => {
        this.renderer.domElement.toBlob((blob) => {
          if (blob?.type === mime) resolve(blob);
          else reject(new Error('浏览器无法编码这张图片，请尝试较小的尺寸。'));
        }, mime, quality);
      });
    } finally {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(this.width, this.height, false);
      this.invalidate();
    }
  }
}
