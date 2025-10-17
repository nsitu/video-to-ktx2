
import * as THREE from 'three/webgpu';
import { texture, uniform, uv } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';

import { showLoadingSpinner, hideLoadingSpinner } from './utils/ui-utils.js';
import { isAndroid } from './utils/user-agent-utils.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 10);

let renderer = null;
let controls = null;

// Initialize WebGPU renderer
async function initRenderer() {
    if (renderer) return renderer;

    if (!WebGPU.isAvailable()) {
        throw new Error('WebGPU not available');
    }

    renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Wait for WebGPU backend to initialize
    await renderer.init();

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Set animation loop after init is complete
    renderer.setAnimationLoop(animate);

    console.log('[WebGPU] Renderer initialized');

    return renderer;
}

// Small overlay label to show current array layer
let layerLabelEl = null;
function ensureLayerLabel() {
    if (layerLabelEl) return layerLabelEl;
    const el = document.createElement('div');
    el.id = 'layerLabel';
    el.textContent = '';
    document.body.appendChild(el);
    layerLabelEl = el;
    return el;
}
function setLayerLabel(text) {
    const el = ensureLayerLabel();
    el.textContent = text;
}

// Map THREE format constants to readable names for logging
function formatToString(fmt) {
    const T = THREE;
    switch (fmt) {
        case T.RGBA_BPTC_Format: return 'BC7 (BPTC RGBA)';
        case T.RGB_BPTC_SIGNED_Format: return 'BC6H (RGB Signed)';
        case T.RGB_BPTC_UNSIGNED_Format: return 'BC6H (RGB Unsigned)';
        case T.RGBA_ETC2_EAC_Format: return 'ETC2 RGBA';
        case T.RGB_ETC2_Format: return 'ETC2 RGB';
        case T.RGBA_ASTC_4x4_Format: return 'ASTC 4x4';
        case T.RGBA_ASTC_5x4_Format: return 'ASTC 5x4';
        case T.RGBA_ASTC_5x5_Format: return 'ASTC 5x5';
        case T.RGBA_ASTC_6x5_Format: return 'ASTC 6x5';
        case T.RGBA_ASTC_6x6_Format: return 'ASTC 6x6';
        case T.RGBA_ASTC_8x5_Format: return 'ASTC 8x5';
        case T.RGBA_ASTC_8x6_Format: return 'ASTC 8x6';
        case T.RGBA_ASTC_8x8_Format: return 'ASTC 8x8';
        case T.RGBA_ASTC_10x5_Format: return 'ASTC 10x5';
        case T.RGBA_ASTC_10x6_Format: return 'ASTC 10x6';
        case T.RGBA_ASTC_10x8_Format: return 'ASTC 10x8';
        case T.RGBA_ASTC_10x10_Format: return 'ASTC 10x10';
        case T.RGBA_ASTC_12x10_Format: return 'ASTC 12x10';
        case T.RGBA_ASTC_12x12_Format: return 'ASTC 12x12';
        case T.RGBA_S3TC_DXT1_Format: return 'BC1 (DXT1 RGBA)';
        case T.RGB_S3TC_DXT1_Format: return 'BC1 (DXT1 RGB)';
        case T.RGBA_S3TC_DXT3_Format: return 'BC2 (DXT3 RGBA)';
        case T.RGBA_S3TC_DXT5_Format: return 'BC3 (DXT5 RGBA)';
        case T.RED_RGTC1_Format: return 'RGTC1 (BC4 R)';
        case T.RED_GREEN_RGTC2_Format: return 'RGTC2 (BC5 RG)';
        case T.RGBAFormat: return 'RGBA8 (uncompressed)';
        case T.RGBFormat: return 'RGB8 (uncompressed)';
        default: return `Unknown (${fmt})`;
    }
}

// Set up KTX2 loader (WebGPU doesn't need format forcing - handles ASTC arrays correctly)
const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('./wasm/');

// Create cube geometry and material
const geometry = new THREE.BoxGeometry(2, 2, 2);
const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// Animation loop
function animate() {
    // Rotate the cube
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.01;

    // If an array material is active, advance layer once per second
    updateArrayLayerCycling();

    // Update controls
    if (controls) controls.update();

    // Render the scene
    if (renderer) renderer.render(scene, camera);
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (renderer) renderer.setSize(window.innerWidth, window.innerHeight);
});

// ================= Array texture demo support =================

let arrayMaterial = null;
let arrayLayerCount = 0;
let arrayLayer = 0;
let arrayLastSwitchTime = 0;

// Create a material that samples from a sampler2DArray using TSL (Three.js Shading Language)
function makeArrayMaterial(arrayTex, layers) {
    arrayLayerCount = layers;
    arrayLayer = 0;
    arrayLastSwitchTime = performance.now();

    // Create a uniform for the current layer (like the official example)
    const layerUniform = uniform(0);

    // Create NodeMaterial with texture array sampling using .depth()
    const material = new THREE.NodeMaterial();
    material.colorNode = texture(arrayTex).depth(layerUniform);

    // Store reference to the layer uniform for updates
    material.userData.layerUniform = layerUniform;

    setLayerLabel(`Layer 0 / ${layers}`);
    return material;
}

// Load a KTX2 array texture from bytes and apply shader cycling material
async function loadKTX2ArrayFromBuffer(buffer, layers) {
    showLoadingSpinner();
    await initRenderer();
    await ktx2Loader.detectSupportAsync(renderer);

    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    ktx2Loader.load(url, (texture) => {
        URL.revokeObjectURL(url);

        texture.flipY = false;
        texture.generateMipmaps = false;
        const hasMips = Array.isArray(texture.mipmaps) ? texture.mipmaps.length > 1 : true;
        texture.minFilter = hasMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;

        try {
            if (!isAndroid()) {
                texture.anisotropy = Math.min(4, renderer.capabilities?.getMaxAnisotropy?.() || 4);
            }
        } catch { }

        console.log('[WebGPU KTX2 array] GPU-format:', formatToString(texture.format), `(${texture.format})`, 'mips=', texture.mipmaps?.length ?? 'unknown');

        arrayMaterial = makeArrayMaterial(texture, layers);
        cube.material = arrayMaterial;
        cube.material.needsUpdate = true;

        hideLoadingSpinner();
    }, undefined, (error) => {
        hideLoadingSpinner();
        console.error('Error loading KTX2 array texture:', error);
    });
}

// Load a KTX2 array texture directly from a URL and apply shader cycling material
async function loadKTX2ArrayFromUrl(url) {
    showLoadingSpinner();
    await initRenderer();
    await ktx2Loader.detectSupportAsync(renderer);

    ktx2Loader.load(url, (texture) => {
        texture.flipY = false;
        texture.generateMipmaps = false;
        const hasMips = Array.isArray(texture.mipmaps) ? texture.mipmaps.length > 1 : true;
        texture.minFilter = hasMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;

        try {
            if (!isAndroid()) {
                texture.anisotropy = Math.min(4, renderer.capabilities?.getMaxAnisotropy?.() || 4);
            }
        } catch { }

        const depth = texture?.image?.depth || 1;
        console.log('[WebGPU KTX2 array url] GPU-format:', formatToString(texture.format), `(${texture.format})`, 'layers=', depth, 'mips=', texture.mipmaps?.length ?? 'unknown');

        arrayMaterial = makeArrayMaterial(texture, depth);
        cube.material = arrayMaterial;
        cube.material.needsUpdate = true;

        hideLoadingSpinner();
    }, undefined, (error) => {
        hideLoadingSpinner();
        console.error('Error loading KTX2 array texture from URL:', error);
    });
}

// Load multiple single-image KTX2 slices and build a CompressedArrayTexture
async function loadKTX2ArrayFromSlices(buffers) {
    showLoadingSpinner();
    await initRenderer();
    await ktx2Loader.detectSupportAsync(renderer);

    try {
        // Helper: extract and validate mipmaps for each texture
        const extractMipmapsList = (texs) => {
            const list = texs.map((t, idx) => {
                let mips = t.mipmaps;
                if (!Array.isArray(mips) || mips.length === 0) {
                    const iw = t.image?.width;
                    const ih = t.image?.height;
                    const idata = t.image?.data;
                    if (idata && typeof iw === 'number' && typeof ih === 'number') {
                        mips = [{ data: idata, width: iw, height: ih }];
                    } else {
                        throw new Error(`Slice ${idx}: missing mipmap data`);
                    }
                }
                for (let m = 0; m < mips.length; m++) {
                    const level = mips[m];
                    if (!level || !level.data) throw new Error(`Slice ${idx} mip ${m}: missing data`);
                    const d = level.data;
                    const isTypedArray = ArrayBuffer.isView(d);
                    const isArrayOfTyped = Array.isArray(d) && d.every((x) => ArrayBuffer.isView(x));
                    if (!isTypedArray && !isArrayOfTyped) throw new Error(`Slice ${idx} mip ${m}: data must be typed array(s)`);
                    if (!(level.width > 0) || !(level.height > 0)) throw new Error(`Slice ${idx} mip ${m}: invalid dimensions ${level.width}x${level.height}`);
                }
                return mips;
            });
            return list;
        };

        // Helper: block sizes for common compressed formats
        const getBlockInfo = (fmt) => {
            const T = THREE;
            if (fmt === T.RGBA_ASTC_4x4_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGBA_BPTC_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGBA_S3TC_DXT1_Format || fmt === T.RGB_S3TC_DXT1_Format) return { bw: 4, bh: 4, bpb: 8 };
            if (fmt === T.RGBA_S3TC_DXT3_Format || fmt === T.RGBA_S3TC_DXT5_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGB_ETC2_Format) return { bw: 4, bh: 4, bpb: 8 };
            if (fmt === T.RGBA_ETC2_EAC_Format) return { bw: 4, bh: 4, bpb: 16 };
            return null;
        };

        // Create blob URLs and load each slice as a compressed texture
        const urls = buffers.map((buf) => URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' })));
        let textures = await Promise.all(urls.map((u) => ktx2Loader.loadAsync(u)));
        urls.forEach((u) => URL.revokeObjectURL(u));

        console.log('[WebGPU KTX2 slices] loaded:', textures.length);
        textures.forEach((t, i) => {
            const w = t.image?.width; const h = t.image?.height;
            const mips = Array.isArray(t.mipmaps) ? t.mipmaps.length : 0;
            console.log(` slice[${i}] format=${t.format} base=${w}x${h} mips=${mips}`);
        });

        let mipmapsList = extractMipmapsList(textures);

        let f = textures[0].format;
        console.log('[WebGPU KTX2 slices] GPU-format (first slice):', formatToString(f), `(${f})`);

        const baseW = mipmapsList[0][0].width;
        const baseH = mipmapsList[0][0].height;
        const mipsCount = mipmapsList[0].length;

        for (let i = 0; i < textures.length; i++) {
            const t = textures[i];
            const mips = mipmapsList[i];
            if (t.format !== f) throw new Error(`Slice ${i}: format mismatch`);
            if (mips.length !== mipsCount) throw new Error(`Slice ${i}: mip count mismatch (${mips.length} vs ${mipsCount})`);
            if (mips[0].width !== baseW || mips[0].height !== baseH) throw new Error(`Slice ${i}: base dimensions mismatch`);
        }

        const depth = mipmapsList.length;
        const mipmapsByLevel = [];

        for (let level = 0; level < mipsCount; level++) {
            const levelWidth = mipmapsList[0][level].width;
            const levelHeight = mipmapsList[0][level].height;
            const levelData = [];

            for (let layer = 0; layer < depth; layer++) {
                const entry = mipmapsList[layer][level];
                if (Array.isArray(entry.data)) {
                    const maybeTyped = entry.data[layer];
                    if (!ArrayBuffer.isView(maybeTyped)) {
                        throw new Error(`Layer ${layer} mip ${level}: expected typed array, got ${typeof maybeTyped}`);
                    }
                    levelData.push(maybeTyped);
                } else {
                    if (!ArrayBuffer.isView(entry.data)) {
                        throw new Error(`Layer ${layer} mip ${level}: data is not typed array`);
                    }
                    levelData.push(entry.data);
                }
            }

            if (levelData.length !== depth) {
                throw new Error(`Mip ${level}: data array length ${levelData.length} != depth ${depth}`);
            }

            const ctor = levelData[0].constructor;
            if (!levelData.every(d => d.constructor === ctor)) {
                console.warn('[WebGPU KTX2 array build] Mixed typed array constructors across layers at mip', level);
            }

            const totalBytes = levelData.reduce((sum, d) => sum + d.byteLength, 0);
            const flat = new Uint8Array(totalBytes);
            let offset = 0;

            for (let i = 0; i < levelData.length; i++) {
                const part = levelData[i];
                flat.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
                offset += part.byteLength;
            }

            const blk = getBlockInfo(f);
            let expectedBytes = null;
            if (blk) {
                const bw = Math.ceil(levelWidth / blk.bw);
                const bh = Math.ceil(levelHeight / blk.bh);
                expectedBytes = bw * bh * blk.bpb * depth;
            }

            console.log(`[WebGPU KTX2 array build] mip ${level}: ${levelWidth}x${levelHeight}, layers=${levelData.length}, flatBytes=${flat.byteLength}` + (expectedBytes !== null ? ` (expected≈${expectedBytes})` : ''));
            mipmapsByLevel.push({ data: flat, width: levelWidth, height: levelHeight });
        }

        if (f === THREE.RGB_ETC2_Format || f === THREE.RGBA_ETC2_EAC_Format) {
            const lvl0 = mipmapsByLevel[0];
            const blocksW = Math.ceil(lvl0.width / 4);
            const blocksH = Math.ceil(lvl0.height / 4);
            const totalBlocks = blocksW * blocksH;
            const perLayerBytes = lvl0.data.byteLength / mipmapsList.length;
            const isRGB = perLayerBytes === totalBlocks * 8;
            const isRGBA = perLayerBytes === totalBlocks * 16;

            if (isRGB && f !== THREE.RGB_ETC2_Format) {
                console.warn('[WebGPU KTX2 array build] Correcting format to ETC2 RGB based on byte size.');
                f = THREE.RGB_ETC2_Format;
            } else if (isRGBA && f !== THREE.RGBA_ETC2_EAC_Format) {
                console.warn('[WebGPU KTX2 array build] Correcting format to ETC2 RGBA based on byte size.');
                f = THREE.RGBA_ETC2_EAC_Format;
            }
        }

        const texArray = new THREE.CompressedArrayTexture(mipmapsByLevel, baseW, baseH, depth, f);
        texArray.needsUpdate = true;
        texArray.flipY = false;
        texArray.generateMipmaps = false;
        texArray.minFilter = mipsCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texArray.magFilter = THREE.LinearFilter;
        texArray.wrapS = THREE.ClampToEdgeWrapping;
        texArray.wrapT = THREE.ClampToEdgeWrapping;

        try {
            if (!isAndroid()) {
                texArray.anisotropy = Math.min(4, renderer.capabilities?.getMaxAnisotropy?.() || 4);
            }
        } catch { }

        if (textures[0].colorSpace) {
            texArray.colorSpace = textures[0].colorSpace;
        }

        console.log('[WebGPU KTX2 array build] final tex image:', texArray.image, 'format=', texArray.format, 'mips=', texArray.mipmaps.length);

        try { textures.forEach(t => t && t.dispose && t.dispose()); } catch { }

        arrayMaterial = makeArrayMaterial(texArray, depth);
        cube.material = arrayMaterial;
        cube.material.needsUpdate = true;
    } catch (err) {
        console.error('Failed to build CompressedArrayTexture from slices:', err);
    } finally {
        hideLoadingSpinner();
    }
}

// Update layer once per second when arrayMaterial is active
const ONE_SECOND = 1000;
function updateArrayLayerCycling() {
    if (!arrayMaterial || arrayLayerCount <= 1) return;
    const now = performance.now();
    if (now - arrayLastSwitchTime >= ONE_SECOND) {
        arrayLayer = (arrayLayer + 1) % arrayLayerCount;
        // Update the layer uniform for the TSL material
        if (arrayMaterial.userData && arrayMaterial.userData.layerUniform) {
            arrayMaterial.userData.layerUniform.value = arrayLayer;
        }
        arrayLastSwitchTime = now;
        setLayerLabel(`Layer ${arrayLayer} / ${arrayLayerCount}`);
    }
}

export { initRenderer, animate };
export { loadKTX2ArrayFromBuffer };
export { loadKTX2ArrayFromSlices };
export { loadKTX2ArrayFromUrl };
