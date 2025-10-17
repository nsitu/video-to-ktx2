import './style.css';
import { loadBasisModule } from './load_basis.js';
import { KTX2Assembler } from './ktx2-assembler.js';
import { threadingSupported } from './utils/wasm-utils.js';
import { isAndroid } from './utils/user-agent-utils.js';
import { showLoadingSpinner, hideLoadingSpinner } from './utils/ui-utils.js';
import { logMemoryInfo, runMemoryDiagnostics } from './utils/memory-utils.js';

// Pre-import both renderer modules to ensure Vite includes them in production build
// We'll use dynamic imports to actually load them, but this ensures dependencies are bundled
import * as rendererWebGL from './renderer-webgl.js';
import * as rendererWebGPU from './renderer-webgpu.js';

// Renderer selection and imports
let renderer;
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
            renderer = rendererWebGPU;
            await renderer.initRenderer();
            console.log('[Renderer] WebGPU initialized');
        } catch (error) {
            console.error('[Renderer] WebGPU failed, falling back to WebGL:', error);
            rendererType = 'webgl';
        }
    }

    if (rendererType === 'webgl') {
        console.log('Using WebGL renderer');
        renderer = rendererWebGL;
        renderer.animate();
    }

    // Update title to show renderer type
    const titleElement = document.getElementById('titleText');
    if (titleElement) {
        const threading = threadingSupported ? ' (Threaded)' : '';
        const rendererLabel = rendererType === 'webgpu' ? ' [WebGPU]' : ' [WebGL]';
        titleElement.textContent = 'KTX2 Array Demo' + threading + rendererLabel;
    }
}

async function runArrayDemo() {
    try {
        showLoadingSpinner();
        const params = new URLSearchParams(window.location.search);
        const mode = (params.get('mode') || 'video').toLowerCase();
        console.log(`[Array Mode] ${mode}`);
        let arrayKtx = null
        if (mode === 'video') {
            const videoUrl = './assets/test.webm';
            arrayKtx = await KTX2Assembler.fromVideoUrl(videoUrl, {
                maxFrames: 10,  // Only first 10 frames
                startTime: 0
            });
        } else {
            const names = ['city.jpg', 'leaves.jpg', 'trees.jpg', 'sunflower.jpg'];
            const urls = names.map(name => `./assets/${name}`);
            arrayKtx = await KTX2Assembler.fromImageUrls(urls);
        }
        await renderer.loadKTX2ArrayFromBuffer(arrayKtx);
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