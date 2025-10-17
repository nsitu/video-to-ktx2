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

// Android detection utility
function isAndroid() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Android/i.test(ua);
}

// Safari/iOS detection utilities
function isIOS() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';

    // Traditional iOS detection
    if (/iPad|iPhone|iPod/.test(ua)) {
        return true;
    }

    // Modern iPad detection - iPads report as Mac but have touch support
    // and specific characteristics
    const isMacUA = /Macintosh/.test(ua);
    const hasTouch = typeof navigator !== 'undefined' && 'maxTouchPoints' in navigator && navigator.maxTouchPoints > 0;
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);

    // iPad running iPadOS 13+ reports as Mac but has touch and is Safari
    return isMacUA && hasTouch && isSafari;
}

function isSafari() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Safari/.test(ua) && !/Chrome/.test(ua);
}

// Safari/iOS specific diagnostics
function getSafariIOSDiagnostics() {
    const isIOSDevice = isIOS();
    const isSafariBrowser = isSafari();
    const hasServiceWorker = 'serviceWorker' in navigator;
    const hasController = navigator.serviceWorker?.controller ? true : false;
    const isSecure = window.isSecureContext;
    const isCrossOriginIsolated = window.crossOriginIsolated;

    return {
        isIOS: isIOSDevice,
        isSafari: isSafariBrowser,
        hasServiceWorker,
        hasController,
        isSecureContext: isSecure,
        crossOriginIsolated: isCrossOriginIsolated,
        userAgent: navigator.userAgent,
        // Safari/iOS specific capabilities
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        hasWebAssembly: typeof WebAssembly !== 'undefined',
        hasWebWorker: typeof Worker !== 'undefined',
        threadingDiagnostics: getWasmThreadingDiagnostics()
    };
}

// Safari/iOS specific error handler for common issues
function handleSafariIOSErrors() {
    if (!isIOS() && !isSafari()) return;

    // Listen for unhandled promise rejections (common with service workers on Safari/iOS)
    window.addEventListener('unhandledrejection', (event) => {
        console.error('[Safari/iOS] Unhandled Promise Rejection:', event.reason);

        // Check if it's a service worker related error
        if (event.reason && typeof event.reason === 'object') {
            const reason = event.reason.toString ? event.reason.toString() : JSON.stringify(event.reason);
            if (reason.includes('respondWith') || reason.includes('FetchEvent') || reason.includes('serviceworker')) {
                console.error('[Safari/iOS] Service Worker Error Detected:', reason);

                // Attempt to recover by unregistering and reregistering service worker
                if (navigator.serviceWorker) {
                    navigator.serviceWorker.getRegistrations().then((registrations) => {
                        registrations.forEach((registration) => {
                            console.log('[Safari/iOS] Attempting to recover service worker registration');
                            registration.unregister().then(() => {
                                setTimeout(() => {
                                    location.reload();
                                }, 1000);
                            });
                        });
                    });
                }
            }
        }
    });

    // Listen for general errors
    window.addEventListener('error', (event) => {
        console.error('[Safari/iOS] Global Error:', {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: event.error
        });
    });

    console.log('[Safari/iOS] Error handlers initialized');
}

// Initialize Safari/iOS error handling
if (isIOS() || isSafari()) {
    handleSafariIOSErrors();

    // Log Safari/iOS diagnostics if detected
    console.group('[Safari/iOS] Compatibility Diagnostics');
    const diagnostics = getSafariIOSDiagnostics();
    Object.entries(diagnostics).forEach(([key, value]) => {
        if (typeof value === 'object') {
            console.log(`${key}:`, value);
        } else {
            console.log(`${key}: ${value}`);
        }
    });
    console.groupEnd();
}

// Loading spinner control functions
function showLoadingSpinner() {
    const spinner = document.getElementById('loadingSpinner');
    const cube = document.querySelector('canvas');
    if (spinner) {
        spinner.style.display = 'flex';
    }

    // Hide the cube while loading
    if (cube) {
        cube.style.display = 'none';
    }
}

function hideLoadingSpinner() {
    const spinner = document.getElementById('loadingSpinner');
    const cube = document.querySelector('canvas');
    if (spinner) {
        spinner.style.display = 'none';
    }

    // Show the cube when done loading
    if (cube) {
        cube.style.display = 'block';
    }
}

// Memory diagnostics and testing functions
function getMemoryInfo(stage = 'unknown') {
    const info = {
        stage,
        timestamp: Date.now(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        hardwareConcurrency: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 'unknown') : 'unknown',
        deviceMemory: typeof navigator !== 'undefined' ? (navigator.deviceMemory || 'unknown') : 'unknown',
        threadingSupported,
        optimalThreadCount,
        isIOS: isIOS(),
        isSafari: isSafari(),
        isAndroid: isAndroid(),
        sharedArrayBufferSupported: typeof SharedArrayBuffer !== 'undefined',
    };

    // Performance memory API (if available - Chrome/Edge mainly)
    if (typeof performance !== 'undefined' && performance.memory) {
        info.performanceMemory = {
            usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + 'MB',
            totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + 'MB',
            jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + 'MB'
        };
    }

    return info;
}

function logMemoryInfo(stage) {
    const info = getMemoryInfo(stage);
    console.log(`[Memory Info - ${stage}]:`, info);
    return info;
}

function isPrivateBrowsingMode() {
    let isPrivate = false;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('__test_private', 'test');
            localStorage.removeItem('__test_private');
        }
    } catch (e) {
        isPrivate = true;
    }
    return isPrivate;
}

function estimateAvailableMemory() {
    let estimatedMB = 300; // Default assumption 
    if (isIOS() || isSafari()) {
        // Conservative estimates for iOS/Safari based on device memory
        const deviceMemory = typeof navigator !== 'undefined' ? (navigator.deviceMemory || 2) : 2; // Assume 2GB if unknown
        if (isPrivateBrowsingMode()) {
            estimatedMB = Math.min(50, deviceMemory * 25); // Very limited in private mode
        } else if (deviceMemory <= 1) {
            estimatedMB = 100; // 1GB devices
        } else if (deviceMemory <= 2) {
            estimatedMB = 200; // 2GB devices  
        } else if (deviceMemory <= 4) {
            estimatedMB = 400; // 4GB devices
        } else {
            estimatedMB = 500; // 4GB+ devices
        }
    } else if (isAndroid()) {
        // Android typically has better memory management
        const deviceMemory = typeof navigator !== 'undefined' ? (navigator.deviceMemory || 4) : 4;
        estimatedMB = Math.min(800, deviceMemory * 200);
    } else {
        // Desktop browsers - use performance.memory if available
        if (typeof performance !== 'undefined' && performance.memory) {
            const available = (performance.memory.jsHeapSizeLimit - performance.memory.usedJSHeapSize) / 1024 / 1024;
            estimatedMB = Math.max(200, available * 0.7); // Conservative estimate
        } else {
            estimatedMB = 600; // Desktop default assumption
        }
    }
    return Math.round(estimatedMB);
}

function getMemoryConstraints() {
    const constraints = {
        isPrivateMode: isPrivateBrowsingMode(),
        deviceMemory: typeof navigator !== 'undefined' ? (navigator.deviceMemory || 'unknown') : 'unknown',
        estimatedAvailable: estimateAvailableMemory(),
        recommendedInitialMemory: null
    };

    // Recommend initial memory size for WebAssembly modules
    if (isIOS() || isSafari()) {
        if (constraints.estimatedAvailable < 150) {
            constraints.recommendedInitialMemory = 64 * 1024 * 1024; // 64MB
        } else if (constraints.estimatedAvailable < 300) {
            constraints.recommendedInitialMemory = 128 * 1024 * 1024; // 128MB
        } else {
            constraints.recommendedInitialMemory = 256 * 1024 * 1024; // 256MB
        }
    } else {
        // Desktop/Android can typically handle more
        constraints.recommendedInitialMemory = 512 * 1024 * 1024; // 512MB
    }

    return constraints;
}

// Might not be wise to do this memory probing. 
// We should perhaps adjust based on actual Out of Memoery (OOM) errors instead.
// if we run out of memory, so be it, we will learn from that.
// however we should alert the user that they are low on memory
// and perhaps allow them to adjust settings accordingly.
// also i need a better understanding of the memory requirements 
// of the basis encoder 
// it may be unreasonable to expect low-memory devices 
// to be able to encode at all

function pageTouch(view, step = 4096) { // 4 KiB default
    const n = view.byteLength;
    for (let i = 0; i < n; i += step) view[i] = 1;
    view[n - 1] = 1; // last byte too
}


// Test memory allocation capability (useful for debugging OOM errors)
async function testMemoryAllocation(sizeInMB = 100) {
    const res = { requestedMB: sizeInMB, success: false, actualAllocatedMB: 0, error: null, timeMs: 0 };
    const t0 = performance.now();
    let buffer = null, view = null;

    try {
        const bytes = sizeInMB * 1024 * 1024;
        if (bytes <= 0) throw new Error("size must be > 0");

        buffer = new ArrayBuffer(bytes);
        view = new Uint8Array(buffer);

        // Force physical commit (best-effort)
        pageTouch(view, 4096); // or 65536 if you prefer a coarser step

        res.success = true;
        res.actualAllocatedMB = sizeInMB;
    } catch (e) {
        res.error = e?.message ?? String(e);
    } finally {
        // Make collectible: drop ALL references to detach memory
        // Garbage collection will collect large detached memory
        // especially when pressure is high.
        view = null;
        buffer = null;

    }

    res.timeMs = Math.round(performance.now() - t0);
    return res;
}


// Find maximum allocatable memory using predefined test sizes
async function findMaxAllocatableMemory() {
    // Array of memory sizes to test (in MB) - ordered from largest to smallest for efficiency
    const memorySizesToTest = [2048, 1536, 1024, 768, 512, 384, 256, 192, 128, 96, 64, 48, 32];
    let maxSuccessful = 0;

    console.log(`[Memory Test] Testing memory allocation with predefined sizes: ${memorySizesToTest.join(', ')}MB`);

    for (const sizeToTest of memorySizesToTest) {
        const result = await testMemoryAllocation(sizeToTest);

        if (result.success) {
            maxSuccessful = sizeToTest;
            console.log(`[Memory Test] ✅ ${sizeToTest}MB allocation successful`);
            // Found the maximum, no need to test smaller sizes
            break;
        } else {
            console.log(`[Memory Test] ❌ ${sizeToTest}MB allocation failed: ${result.error}`);
        }

        // Small delay to avoid overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log(`[Memory Test] Maximum allocatable memory: ${maxSuccessful}MB`);
    return maxSuccessful;
}

// Memory diagnostics and initialization check
async function runMemoryDiagnostics() {
    console.group('[Memory Diagnostics] Pre-BASIS Analysis');
    // Get comprehensive memory constraints
    const constraints = getMemoryConstraints();
    console.log('[Memory] Constraints analysis:', constraints);
    // Get initial estimate
    const estimated = estimateAvailableMemory();
    console.log(`[Memory] Estimated available: ${estimated}MB`);
    // Always run deep memory tests for accurate assessment
    console.log('[Memory] 🧪 Running memory allocation tests for accurate assessment...');


    const actualMaxMB = await findMaxAllocatableMemory();

    // Use the actual tested results instead of estimates for decision making
    const reliableMemory = actualMaxMB;

    // Update constraints with actual tested memory
    constraints.actualAvailable = reliableMemory;
    constraints.estimatedAvailable = estimated; // Keep estimate for comparison


    if (reliableMemory < 150) {
        console.warn('[Memory] ⚠️ LOW MEMORY WARNING: Basis encoding may fail on this device');
        console.warn(`[Memory] Actual available: ${reliableMemory}MB (estimated: ${estimated}MB)`);
        console.warn('[Memory] Consider using alternative compression or reducing image sizes');
    } else if (reliableMemory < 300) {
        console.warn('[Memory] ⚠️ MODERATE MEMORY: Using conservative settings');
        console.warn(`[Memory] Actual available: ${reliableMemory}MB (estimated: ${estimated}MB)`);
    } else {
        console.log('[Memory] ✅ Sufficient memory available for Basis encoding');
        console.log(`[Memory] Actual available: ${reliableMemory}MB (estimated: ${estimated}MB)`);
    }


    console.groupEnd();

    return constraints;
}

export {
    threadingSupported,
    optimalThreadCount,
    isAndroid,
    isIOS,
    isSafari,
    getSafariIOSDiagnostics,
    showLoadingSpinner,
    hideLoadingSpinner,
    getWasmThreadingDiagnostics,
    getMemoryInfo,
    logMemoryInfo,
    isPrivateBrowsingMode,
    estimateAvailableMemory,
    getMemoryConstraints,
    testMemoryAllocation,
    findMaxAllocatableMemory,
    runMemoryDiagnostics
};