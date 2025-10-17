import './style.css';
import { loadBasisModule } from './load_basis.js';
import { ImageToKtx } from './image_to_ktx.js';
import { ImagesToKtx } from './images_to_ktx.js';
import { ImagesToKtxSequential } from './images_to_ktx_sequential.js';
import { threadingSupported } from './utils/wasm-utils.js';
import { isAndroid } from './utils/user-agent-utils.js';
import { showLoadingSpinner, hideLoadingSpinner } from './utils/ui-utils.js';
import { logMemoryInfo, runMemoryDiagnostics } from './utils/memory-utils.js';

// Pre-import both renderer modules to ensure Vite includes them in production build
// We'll use dynamic imports to actually load them, but this ensures dependencies are bundled
import * as cubeWebGL from './renderer-webgl.js';
import * as cubeWebGPU from './renderer-webgpu.js';

// Renderer selection and imports
let animate, loadKTX2ArrayFromSlices, loadKTX2ArrayFromBuffer, loadKTX2ArrayFromUrl;
let rendererType = 'webgl'; // default

async function chooseRenderer() {
    const params = new URLSearchParams(window.location.search);
    const forceRenderer = (params.get('renderer') || '').toLowerCase();
    const isAndroidDevice = isAndroid();

    // Check WebGPU availability
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

    if (forceRenderer === 'webgpu') {
        rendererType = 'webgpu';
    } else if (forceRenderer === 'webgl') {
        rendererType = 'webgl';
    } else {
        // Auto-detect: prefer WebGPU if available (fixes ASTC array issues on Android)
        rendererType = hasWebGPU ? 'webgpu' : 'webgl';
    }

    console.log('[Renderer] chosen=', rendererType, '| hasWebGPU=', hasWebGPU, '| Android=', isAndroidDevice, '| force=', forceRenderer || 'auto');

    // Use pre-imported modules (already loaded above for Vite bundling)
    if (rendererType === 'webgpu') {
        try {
            console.log('Using WebGPU renderer');
            animate = cubeWebGPU.animate;
            loadKTX2ArrayFromSlices = cubeWebGPU.loadKTX2ArrayFromSlices;
            loadKTX2ArrayFromBuffer = cubeWebGPU.loadKTX2ArrayFromBuffer;
            loadKTX2ArrayFromUrl = cubeWebGPU.loadKTX2ArrayFromUrl;
            await cubeWebGPU.initRenderer();
            console.log('[Renderer] WebGPU initialized');
        } catch (error) {
            console.error('[Renderer] WebGPU failed, falling back to WebGL:', error);
            rendererType = 'webgl';
            animate = cubeWebGL.animate;
            loadKTX2ArrayFromSlices = cubeWebGL.loadKTX2ArrayFromSlices;
            loadKTX2ArrayFromBuffer = cubeWebGL.loadKTX2ArrayFromBuffer;
            loadKTX2ArrayFromUrl = cubeWebGL.loadKTX2ArrayFromUrl;
            animate();
        }
    } else {
        console.log('Using WebGL renderer');
        animate = cubeWebGL.animate;
        loadKTX2ArrayFromSlices = cubeWebGL.loadKTX2ArrayFromSlices;
        loadKTX2ArrayFromBuffer = cubeWebGL.loadKTX2ArrayFromBuffer;
        loadKTX2ArrayFromUrl = cubeWebGL.loadKTX2ArrayFromUrl;
        animate();
    }

    // Update title to show renderer type
    const titleElement = document.getElementById('titleText');
    if (titleElement) {
        const threading = threadingSupported ? ' (Threaded)' : '';
        const renderer = rendererType === 'webgpu' ? ' [WebGPU]' : ' [WebGL]';
        titleElement.textContent = 'KTX2 Array Demo' + threading + renderer;
    }
}

async function runArrayDemo() {
    try {
        showLoadingSpinner();

        // Configure encoder(s): mipmaps on, Zstd supercompression disabled
        ImageToKtx.configure({ mipmaps: true, supercompression: false });
        console.log('[Encoder config] mipmaps=true, supercompression=false');

        const names = ['city.jpg', 'leaves.jpg', 'trees.jpg', 'sunflower.jpg'];

        const params = new URLSearchParams(window.location.search);
        // Quick path: test a known KTX2 array file from public for ASTC/ETC2 behavior
        const sample = (params.get('sample') || '').toLowerCase();
        if (sample === 'spirited') {
            // Use the pre-encoded Spirited Away texture array
            await loadKTX2ArrayFromUrl('./assets/spiritedaway.ktx2');
            return;
        }

        // A/B/C switch: ?array=ktx2, ?array=slices, or ?array=sequential (default: slices)
        const mode = (params.get('array') || 'slices').toLowerCase();
        console.log(`[Array Mode] ${mode}`);

        if (mode === 'video') {
            // Mode 4: Encode video frames to KTX2 array (memory-efficient, lazy loading)
            const videoUrl = './assets/test.webm';
            const arrayKtx = await ImagesToKtxSequential.encodeFromVideoUrl(videoUrl, {
                maxFrames: 10,  // Only first 10 frames
                startTime: 0
            });
            await loadKTX2ArrayFromBuffer(arrayKtx, 10);
        } else if (mode === 'ktx2') {
            // Mode 1: Encode all images simultaneously into a single KTX2 array (high memory usage)
            // Must fetch all upfront for parallel encoding
            const responses = await Promise.all(names.map(n => fetch(`./assets/${n}`)));
            const ok = responses.every(r => r.ok);
            if (!ok) throw new Error('Failed to fetch one or more demo images');
            const rawImages = await Promise.all(responses.map(r => r.arrayBuffer()));

            const layers = names.map((name, i) => ({
                data: rawImages[i],
                fileName: name,
                extension: name.split('.').pop()
            }));
            const arrayKtx = await ImagesToKtx.encode(layers);
            await loadKTX2ArrayFromBuffer(arrayKtx, names.length);
        } else if (mode === 'sequential') {
            // Mode 2: Encode images one-by-one with pipelined fetching (memory-efficient)
            const urls = names.map(name => `./assets/${name}`);
            const arrayKtx = await ImagesToKtxSequential.encodeFromUrls(urls);
            await loadKTX2ArrayFromBuffer(arrayKtx, names.length);
        } else {
            // Mode 3: Encode each image to separate KTX2, let Three.js build array (default)
            const responses = await Promise.all(names.map(n => fetch(`./assets/${n}`)));
            const ok = responses.every(r => r.ok);
            if (!ok) throw new Error('Failed to fetch one or more demo images');
            const rawImages = await Promise.all(responses.map(r => r.arrayBuffer()));

            const singleKtx2Buffers = [];
            for (let i = 0; i < rawImages.length; i++) {
                const data = rawImages[i];
                const ext = names[i].split('.').pop();
                const base = names[i];
                const ktx = await ImageToKtx.encode(data, base, ext);
                singleKtx2Buffers.push(ktx);
            }
            await loadKTX2ArrayFromSlices(singleKtx2Buffers);
        }
    } catch (err) {
        console.error('Array demo failed:', err);
        hideLoadingSpinner();
    }
}

try {
    await chooseRenderer();
    // Run comprehensive memory diagnostics before loading BASIS
    runMemoryDiagnostics();
    await loadBasisModule();
    await runArrayDemo();
} catch (error) {
    console.error('Failed to initialize application');
    console.error(error);

    // Log memory state on error for debugging
    logMemoryInfo('app-error');
}