// Detailed diagnostics for WebAssembly threading prerequisites
function getWasmThreadingDiagnostics() {
    const hasWebAssembly = typeof WebAssembly === 'object';
    const hasWasmMemoryCtor = hasWebAssembly && typeof WebAssembly.Memory === 'function';
    const hasSharedArrayBufferCtor = typeof SharedArrayBuffer === 'function';
    // COOP/COEP cross-origin isolation is required to use SAB in most browsers
    const coi = typeof self !== 'undefined' && !!self.crossOriginIsolated;

    let canConstructSharedMemory = false;
    let sharedMemoryIsSharedBuffer = false;
    try {
        if (hasWasmMemoryCtor) {
            const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
            canConstructSharedMemory = mem instanceof WebAssembly.Memory;
            // If constructed, its .buffer should be a SharedArrayBuffer
            sharedMemoryIsSharedBuffer = typeof SharedArrayBuffer === 'function' && mem.buffer instanceof SharedArrayBuffer;
        }
    } catch (_) {
        canConstructSharedMemory = false;
        sharedMemoryIsSharedBuffer = false;
    }

    // Final support requires being able to make shared memory
    const isSupported = !!(hasWasmMemoryCtor && canConstructSharedMemory && sharedMemoryIsSharedBuffer);

    return {
        hasWebAssembly,
        hasWasmMemoryCtor,
        hasSharedArrayBufferCtor,
        crossOriginIsolated: coi,
        canConstructSharedMemory,
        sharedMemoryIsSharedBuffer,
        isSupported,
    };
}

// Function to check for WebAssembly threading support (boolean)
const checkIsWasmThreadingSupported = function () {
    try {
        return getWasmThreadingDiagnostics().isSupported;
    } catch {
        return false;
    }
}

const threadingSupported = checkIsWasmThreadingSupported();

if (threadingSupported) {
    console.log("Threading is supported");
} else {
    const d = getWasmThreadingDiagnostics();
    // Compact, explicit diagnostics so we know why it failed
    console.groupCollapsed('[WASM Threads] Not supported — diagnostics');
    console.log('hasWebAssembly:', d.hasWebAssembly);
    console.log('hasWasmMemoryCtor:', d.hasWasmMemoryCtor);
    console.log('hasSharedArrayBufferCtor:', d.hasSharedArrayBufferCtor);
    console.log('crossOriginIsolated:', d.crossOriginIsolated);
    console.log('canConstructSharedMemory:', d.canConstructSharedMemory);
    console.log('sharedMemoryIsSharedBuffer:', d.sharedMemoryIsSharedBuffer);
    console.groupEnd();
}


// Get the number of available CPU threads, with a reasonable fallback
const getOptimalThreadCount = () => {
    const cpuThreads = navigator.hardwareConcurrency || 4; // fallback to 4 if not available
    return Math.min(cpuThreads, 18); // cap at 18 to avoid potential issues
};

const optimalThreadCount = getOptimalThreadCount();


export {
    threadingSupported,
    optimalThreadCount,
    getWasmThreadingDiagnostics,
};