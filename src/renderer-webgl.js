
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

import { showLoadingSpinner, hideLoadingSpinner } from './utils/ui-utils.js';
import { isAndroid } from './utils/user-agent-utils.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 10);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Environment diagnostics
try {
    const gl = renderer.getContext();
    const isWebGL2 = (gl instanceof WebGL2RenderingContext);
    const extASTC = gl.getExtension('WEBGL_compressed_texture_astc');
    const extASTCWebkit = gl.getExtension('WEBKIT_WEBGL_compressed_texture_astc');
    const extETC = gl.getExtension('WEBGL_compressed_texture_etc');
    const extETC1 = gl.getExtension('WEBGL_compressed_texture_etc1');
    const extETCvs = gl.getExtension('WEBGL_compressed_texture_etc');
    const extS3TC = gl.getExtension('WEBGL_compressed_texture_s3tc');
    const extBPTC = gl.getExtension('EXT_texture_compression_bptc');
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) : 'unknown';
    const rendererStr = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
    console.log('[GL Env] WebGL2:', isWebGL2, 'ASTC ext:', !!(extASTC || extASTCWebkit), 'ETC/ETC1:', !!extETC, !!extETC1, 'S3TC:', !!extS3TC, 'BPTC:', !!extBPTC);
    console.log('[GL Env] Vendor/Renderer:', vendor, '/', rendererStr);
} catch (e) {
    console.log('[GL Env] Diagnostics failed:', e);
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



// Set up KTX2 loader
const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('./wasm/');
ktx2Loader.detectSupport(renderer);
// A/B switch for ASTC vs ETC2:
// - ?force=astc   -> prefer ASTC (disable ETC2)
// - ?force=etc2   -> prefer ETC2 (disable ASTC)
// - default (auto): on Android + Mali, prefer ETC2; otherwise leave detected support
function getQueryParam(name) {
    try { return new URLSearchParams(window.location.search).get(name) || null; } catch { return null; }
}
try {
    const isAndroidDevice = isAndroid();
    // Read GPU renderer string if available
    let rendererStr = 'unknown';
    try {
        const gl = renderer.getContext();
        const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
        rendererStr = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
    } catch { /* ignore */ }
    const isMali = /Mali/i.test(rendererStr);

    const force = (getQueryParam('force') || '').toLowerCase(); // 'astc' | 'etc2' | ''
    let policy = 'auto';
    if (force === 'astc') policy = 'force-astc';
    else if (force === 'etc2') policy = 'force-etc2';
    else if (isAndroidDevice && isMali) policy = 'android-mali-etc2';

    if (policy === 'force-astc') {
        ktx2Loader.workerConfig = {
            ...ktx2Loader.workerConfig,
            astcSupported: true,
            dxtSupported: false,
            bptcSupported: false,
            pvrtcSupported: false,
            etc2Supported: false,
            etc1Supported: false,
        };
    } else if (policy === 'force-etc2' || policy === 'android-mali-etc2') {
        ktx2Loader.workerConfig = {
            ...ktx2Loader.workerConfig,
            astcSupported: false,
            dxtSupported: false,
            bptcSupported: false,
            pvrtcSupported: false,
            etc2Supported: true,
            etc1Supported: true,
        };
    }
    console.log('[KTX2 cfg] policy =', policy, '| Android =', isAndroidDevice, '| renderer =', rendererStr);
} catch { }

// Default texture load removed for array demo focus

// Function to update cube texture
function updateCubeTexture(texture) {
    // Fix horizontal mirroring by adjusting texture properties
    texture.flipY = false; // KTX2 textures typically don't need Y-flip
    texture.wrapS = THREE.RepeatWrapping; // Allow for negative repeat to flip
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.x = -1; // Flip horizontally by using negative repeat
    texture.repeat.y = 1;  // Keep vertical as is
    texture.generateMipmaps = false; // KTX2 files may already contain mipmaps

    if (cube) {
        cube.material.map = texture;
        cube.material.needsUpdate = true;
    }
}

// Function to load KTX2 from blob/buffer
function loadKTX2FromBuffer(buffer, callback) {
    // Show loading spinner
    showLoadingSpinner();

    // Create a blob URL from the buffer
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    ktx2Loader.load(url, (texture) => {
        updateCubeTexture(texture);
        URL.revokeObjectURL(url); // Clean up

        // Hide loading spinner and show cube
        hideLoadingSpinner();

        if (callback) callback(texture);
    }, undefined, (error) => {
        // Hide loading spinner on error too
        hideLoadingSpinner();
        console.error('Error loading KTX2 texture:', error);
    });
}

// Create cube geometry and material (texture will be applied when loaded)
const geometry = new THREE.BoxGeometry(2, 2, 2);



const material = new THREE.MeshBasicMaterial({ color: 0xffffff }); // Default white color until texture loads
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    // Rotate the cube
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.01;

    // If an array material is active, advance layer once per second
    updateArrayLayerCycling();

    // Update controls
    controls.update();

    // Render the scene
    renderer.render(scene, camera);
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});


export { animate, loadKTX2FromBuffer };
export { loadKTX2ArrayFromBuffer };
export { loadKTX2ArrayFromSlices };
export { loadKTX2ArrayFromUrl };

// ================= Array texture demo support =================

let arrayMaterial = null;
let arrayLayerCount = 0;
let arrayLayer = 0;
let arrayLastSwitchTime = 0;

// Create a shader material that samples from a sampler2DArray
// NOTE: sampler2DArray is a GLSL (OpenGL Shading Language) type 
// that represents a 2D texture array.
function makeArrayMaterial(arrayTex, layers) {
    arrayLayerCount = layers;
    arrayLayer = 0;
    arrayLastSwitchTime = performance.now();

    const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
            uTex: { value: arrayTex },
            uLayer: { value: 0 }
        },
        vertexShader: /* glsl */`
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp sampler2DArray;
            in vec2 vUv;
            uniform sampler2DArray uTex;
            uniform int uLayer;
            out vec4 outColor;
            void main() {
                outColor = texture(uTex, vec3(vUv, float(uLayer)));
            }
        `,
    });
    mat.transparent = false;
    mat.depthWrite = true;
    setLayerLabel(`Layer 0 / ${layers}`);
    return mat;
}

// Load a KTX2 array texture from bytes and apply shader cycling material
function loadKTX2ArrayFromBuffer(buffer, layers) {
    showLoadingSpinner();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    ktx2Loader.load(url, (texture) => {
        URL.revokeObjectURL(url);

        // KTX2Loader will create a DataTexture2DArray when the source is an array
        texture.flipY = false;
        texture.generateMipmaps = false;
        // Align filters/wraps with the slices-built CompressedArrayTexture
        const hasMips = Array.isArray(texture.mipmaps) ? texture.mipmaps.length > 1 : true;
        texture.minFilter = hasMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        // Avoid anisotropy on Android for stability
        try {
            if (!isAndroid()) {
                texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            }
        } catch { }

        // Diagnostics: log chosen GPU format
        console.log('[KTX2 array single-file] GPU-format:', formatToString(texture.format), `(${texture.format})`, 'mips=', texture.mipmaps?.length ?? 'unknown');

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
function loadKTX2ArrayFromUrl(url) {
    showLoadingSpinner();
    ktx2Loader.load(url, (texture) => {
        // KTX2Loader will create a DataTexture2DArray when the source is an array
        texture.flipY = false;
        texture.generateMipmaps = false;
        const hasMips = Array.isArray(texture.mipmaps) ? texture.mipmaps.length > 1 : true;
        texture.minFilter = hasMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        try {
            if (!isAndroid()) {
                texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            }
        } catch { }

        // Determine depth (layers) from texture.image if available
        const depth = texture?.image?.depth || 1;
        console.log('[KTX2 array url] GPU-format:', formatToString(texture.format), `(${texture.format})`, 'layers=', depth, 'mips=', texture.mipmaps?.length ?? 'unknown');

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
        // Helper: block sizes for a few common compressed formats
        const getBlockInfo = (fmt) => {
            const T = THREE;
            if (fmt === T.RGBA_ASTC_4x4_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGBA_BPTC_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGBA_S3TC_DXT1_Format || fmt === T.RGB_S3TC_DXT1_Format) return { bw: 4, bh: 4, bpb: 8 };
            if (fmt === T.RGBA_S3TC_DXT3_Format || fmt === T.RGBA_S3TC_DXT5_Format) return { bw: 4, bh: 4, bpb: 16 };
            if (fmt === T.RGB_ETC2_Format) return { bw: 4, bh: 4, bpb: 8 };
            if (fmt === T.RGBA_ETC2_EAC_Format) return { bw: 4, bh: 4, bpb: 16 };
            // Fallback unknown
            return null;
        };

        // Create blob URLs and load each slice as a compressed texture
        const urls = buffers.map((buf) => URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' })));
        let textures = await Promise.all(urls.map((u) => ktx2Loader.loadAsync(u)));
        // Cleanup URLs
        urls.forEach((u) => URL.revokeObjectURL(u));

        // Debug: log slice summaries
        console.log('[KTX2 slices] loaded:', textures.length);
        textures.forEach((t, i) => {
            const w = t.image?.width; const h = t.image?.height;
            const mips = Array.isArray(t.mipmaps) ? t.mipmaps.length : 0;
            console.log(` slice[${i}] format=${t.format} base=${w}x${h} mips=${mips}`);
        });

        // For each texture, get its mipmaps array; ensure at least base level present
        let mipmapsList = extractMipmapsList(textures);

        // Sanity check: format, dimensions, mip count must match across slices
        let f = textures[0].format;
        console.log('[KTX2 slices] GPU-format (first slice):', formatToString(f), `(${f})`);
        // Heuristic: On Android devices, ASTC array uploads can be flaky on some drivers.
        // If ASTC was chosen, try reloading slices with ASTC disabled to prefer ETC2.
        // Note: Android is configured to prefer ETC2 at loader init; no re-transcode here.
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

        // Transform to mip-major structure: for each mip level, provide data array of length=depth
        const depth = mipmapsList.length;
        const mipmapsByLevel = [];
        for (let level = 0; level < mipsCount; level++) {
            const levelWidth = mipmapsList[0][level].width;
            const levelHeight = mipmapsList[0][level].height;
            const levelData = [];
            for (let layer = 0; layer < depth; layer++) {
                const entry = mipmapsList[layer][level];
                // Ensure each entry is a typed array (single layer payload)
                if (Array.isArray(entry.data)) {
                    // If a loader provided array-of-layers per slice (unlikely), take this layer index
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
            // Flatten per-layer typed arrays into a single contiguous typed array as expected by three.js
            const ctor = levelData[0].constructor; // assume all layers share the same constructor
            if (!levelData.every(d => d.constructor === ctor)) {
                console.warn('[KTX2 array build] Mixed typed array constructors across layers at mip', level, levelData.map(d => d.constructor && d.constructor.name));
            }
            const totalBytes = levelData.reduce((sum, d) => sum + d.byteLength, 0);
            // Use Uint8Array as a safe fallback for compressed payloads since bytes are copied verbatim
            const flat = new Uint8Array(totalBytes);
            let offset = 0;
            for (let i = 0; i < levelData.length; i++) {
                const part = levelData[i];
                flat.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
                offset += part.byteLength;
            }
            // Debug per-level summary, include expected bytes if known
            const blk = getBlockInfo(f);
            let expectedBytes = null;
            if (blk) {
                const bw = Math.ceil(levelWidth / blk.bw);
                const bh = Math.ceil(levelHeight / blk.bh);
                expectedBytes = bw * bh * blk.bpb * depth;
            }
            console.log(`[KTX2 array build] mip ${level}: ${levelWidth}x${levelHeight}, layers=${levelData.length}, flatBytes=${flat.byteLength}` + (expectedBytes !== null ? ` (expected≈${expectedBytes})` : ''));
            mipmapsByLevel.push({ data: flat, width: levelWidth, height: levelHeight });
        }

        // If ETC2 format was selected, double-check whether data matches RGB (8bpb) or RGBA (16bpb)
        // and correct the format accordingly to avoid GPU interpreting with the wrong internalformat.
        if (f === THREE.RGB_ETC2_Format || f === THREE.RGBA_ETC2_EAC_Format) {
            const lvl0 = mipmapsByLevel[0];
            const blocksW = Math.ceil(lvl0.width / 4);
            const blocksH = Math.ceil(lvl0.height / 4);
            const totalBlocks = blocksW * blocksH;
            const perLayerBytes = lvl0.data.byteLength / mipmapsList.length; // depth
            const isRGB = perLayerBytes === totalBlocks * 8;
            const isRGBA = perLayerBytes === totalBlocks * 16;
            if (isRGB && f !== THREE.RGB_ETC2_Format) {
                console.warn('[KTX2 array build] Correcting format to ETC2 RGB based on byte size.');
                f = THREE.RGB_ETC2_Format;
            } else if (isRGBA && f !== THREE.RGBA_ETC2_EAC_Format) {
                console.warn('[KTX2 array build] Correcting format to ETC2 RGBA based on byte size.');
                f = THREE.RGBA_ETC2_EAC_Format;
            } else if (!isRGB && !isRGBA) {
                console.warn('[KTX2 array build] ETC2 byte size does not match RGB or RGBA expectations. Proceeding with', formatToString(f));
            }
        }

        // Construct CompressedArrayTexture with mip-major mipmaps
        const texArray = new THREE.CompressedArrayTexture(mipmapsByLevel, baseW, baseH, depth, f);
        texArray.needsUpdate = true;
        texArray.flipY = false;
        texArray.generateMipmaps = false;
        texArray.minFilter = mipsCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texArray.magFilter = THREE.LinearFilter;
        texArray.wrapS = THREE.ClampToEdgeWrapping;
        texArray.wrapT = THREE.ClampToEdgeWrapping;
        // Mild anisotropy for better quality when minifying; 
        // avoid on Android to reduce driver variability
        try {
            if (!isAndroid()) {
                texArray.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            }
        } catch { }
        // Try to propagate color space from the first slice (e.g., SRGBColorSpace)
        if (textures[0].colorSpace) {
            texArray.colorSpace = textures[0].colorSpace;
        }

        // Additional debug of the final texture object
        console.log('[KTX2 array build] final tex image:', texArray.image, 'format=', texArray.format, 'mips=', texArray.mipmaps.length);
        if (texArray.mipmaps[0] && Array.isArray(texArray.mipmaps[0].data)) {
            console.log('[KTX2 array build] mip0 layer types:', texArray.mipmaps[0].data.map(d => d && d.constructor && d.constructor.name));
        }

        // Free intermediate per-slice textures to save GPU memory
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
        arrayMaterial.uniforms.uLayer.value = arrayLayer;
        arrayLastSwitchTime = now;
        setLayerLabel(`Layer ${arrayLayer} / ${arrayLayerCount}`);
    }
}

// Inject array layer cycling into the existing animation loop
// (Call updateArrayLayerCycling() inside the original animate below.)