
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

// Cube will be created when texture is loaded
let cube = null;

// Animation loop
function animate() {
    // Rotate the cube (if it exists)
    if (cube) {
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
    }

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
function makeArrayMaterial(arrayTex) {
    // Infer layer count from the texture's image depth property
    const layers = arrayTex.image?.depth || 1;

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

    console.log('[WebGPU] Array material created with', layers, 'layers');
    setLayerLabel(`Layer 0 / ${layers}`);
    return material;
}

// Load a KTX2 array texture from bytes and apply shader cycling material
async function loadKTX2ArrayFromBuffer(buffer) {
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
        // Update the layer uniform for the TSL material
        if (arrayMaterial.userData && arrayMaterial.userData.layerUniform) {
            arrayMaterial.userData.layerUniform.value = arrayLayer;
        }
        arrayLastSwitchTime = now;
        setLayerLabel(`Layer ${arrayLayer} / ${arrayLayerCount}`);
    }
}

export { initRenderer, animate, loadKTX2ArrayFromBuffer };
