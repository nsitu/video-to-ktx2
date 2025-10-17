
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

// Cube will be created when texture is loaded
let cube = null;

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    // Rotate the cube (if it exists)
    if (cube) {
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
    }

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

// ================= Array texture demo support =================

let arrayMaterial = null;
let arrayLayerCount = 0;
let arrayLayer = 0;
let arrayLastSwitchTime = 0;

// Create a shader material that samples from a sampler2DArray
// NOTE: sampler2DArray is a GLSL (OpenGL Shading Language) type 
// that represents a 2D texture array.
function makeArrayMaterial(arrayTex) {
    // Infer layer count from the texture's image depth property
    const layers = arrayTex.image?.depth || 1;

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
    console.log('[WebGL] Array material created with', layers, 'layers');
    setLayerLabel(`Layer 0 / ${layers}`);
    return mat;
}

// Load a KTX2 array texture from bytes and apply shader cycling material
function loadKTX2ArrayFromBuffer(buffer) {
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

        arrayMaterial = makeArrayMaterial(texture);

        // Create and add cube with the loaded texture
        if (!cube) {
            const geometry = new THREE.BoxGeometry(2, 2, 2);
            cube = new THREE.Mesh(geometry, arrayMaterial);
            scene.add(cube);
        } else {
            cube.material = arrayMaterial;
            cube.material.needsUpdate = true;
        }

        hideLoadingSpinner();
    }, undefined, (error) => {
        hideLoadingSpinner();
        console.error('Error loading KTX2 array texture:', error);
    });
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
