
import { getWasmThreadingDiagnostics } from './wasm-utils.js';

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

export {
    isAndroid,
    isIOS,
    isSafari,
    getSafariIOSDiagnostics
};