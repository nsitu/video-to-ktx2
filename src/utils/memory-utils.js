import { isIOS, isSafari, isAndroid } from './user-agent-utils.js';
import { threadingSupported, optimalThreadCount } from './wasm-utils.js';

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
    getMemoryInfo,
    logMemoryInfo,
    isPrivateBrowsingMode,
    estimateAvailableMemory,
    getMemoryConstraints,
    testMemoryAllocation,
    findMaxAllocatableMemory,
    runMemoryDiagnostics
};