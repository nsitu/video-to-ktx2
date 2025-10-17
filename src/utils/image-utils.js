// Utility helpers for image metadata

// Map common file extensions to MIME types; defaults to octet-stream
function extToMime(ext) {
    switch ((ext || '').toLowerCase()) {
        case 'jpg':
        case 'jpeg':
        case 'jfif':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'webp':
            return 'image/webp';
        default:
            return 'application/octet-stream';
    }
}

// Prefer WebCodecs ImageDecoder; fallback to createImageBitmap; else null
// NOTE: if we are building images more deliberately with canvas, 
// this will probably not be needed.
export async function sniffImageSize(imageData, ext) {
    const mime = extToMime(ext);
    const u8 = imageData instanceof Uint8Array
        ? imageData
        : imageData instanceof ArrayBuffer
            ? new Uint8Array(imageData)
            : new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength);

    if ('ImageDecoder' in globalThis) {
        try {
            const dec = new ImageDecoder({ data: u8, type: mime });
            const { image } = await dec.decode({ frameIndex: 0, completeFramesOnly: true });
            const width = image.displayWidth || image.codedWidth || image.width;
            const height = image.displayHeight || image.codedHeight || image.height;
            image.close?.();
            dec.close?.();
            if (width && height) return { width, height };
        } catch (_) {
            // fall through to bitmap path
        }
    }

    try {
        const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
        const size = { width: bmp.width, height: bmp.height };
        bmp.close?.();
        return size;
    } catch (_) {
        // final fallback
    }

    return null;
}

// Calculate appropriate buffer size for KTX2 encoding based on image data (async for metadata)
export async function calculateKTX2BufferSize(imageData, ext, options = {}) {
    const { mipmaps = true } = options;
    let width = 1024, height = 1024;
    const meta = await sniffImageSize(imageData, ext);
    if (meta && meta.width && meta.height) {
        width = meta.width; height = meta.height;
    }

    console.log(`Calculating buffer for ${width}x${height} square image`);

    // Estimate bytes using block math for UASTC (4x4 blocks, 16 bytes per block) across mips (optional)
    const blockBytes = 16, blockDim = 4;
    const blocksW0 = Math.ceil(width / blockDim);
    const blocksH0 = Math.ceil(height / blockDim);
    let bytes = blocksW0 * blocksH0 * blockBytes;
    if (mipmaps) {
        let w = width, h = height;
        while (w > 1 || h > 1) {
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
            bytes += Math.ceil(w / blockDim) * Math.ceil(h / blockDim) * blockBytes;
        }
    }
    const safety = 1.25; // overhead and headers
    const header = 4096;
    const total = Math.ceil(bytes * safety) + header;

    const minSize = 1024 * 1024; // 1MB
    const maxSize = 16 * 1024 * 1024; // 16MB
    const finalSize = Math.max(minSize, Math.min(maxSize, total));
    console.log(`Buffer size: ${(finalSize / 1024 / 1024).toFixed(1)}MB for ${width}x${height} square image`);
    return finalSize;
}

// Internal: compute UASTC bytes across mip chain from dimensions
function uastcBytesAcrossMips(width, height, mipmaps = true) {
    const blockBytes = 16, blockDim = 4;
    let bytes = Math.ceil(width / blockDim) * Math.ceil(height / blockDim) * blockBytes;
    if (mipmaps) {
        let w = width, h = height;
        while (w > 1 || h > 1) {
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
            bytes += Math.ceil(w / blockDim) * Math.ceil(h / blockDim) * blockBytes;
        }
    }
    return bytes;
}

// Array-aware sizing: estimates one buffer for a KTX2 2D array of N layers
export async function calculateKTX2ArrayBufferSize(firstImageData, ext, layerCount, options = {}) {
    const { mipmaps = true } = options;
    let width = 1024, height = 1024;
    const meta = await sniffImageSize(firstImageData, ext);
    if (meta && meta.width && meta.height) {
        width = meta.width; height = meta.height;
    }

    console.log(`Calculating buffer for ${layerCount} layer(s) of ${width}x${height} squares`);

    const bytesPerLayer = uastcBytesAcrossMips(width, height, mipmaps);
    const totalBytes = bytesPerLayer * Math.max(1, layerCount);
    const safety = 1.35; // multi-layer overhead
    const header = 4096;
    const total = Math.ceil(totalBytes * safety) + header;

    const minSize = 1 * 1024 * 1024; // 1MB
    const maxSize = 32 * 1024 * 1024; // 32MB
    const finalSize = Math.max(minSize, Math.min(maxSize, total));
    console.log(`Buffer size: ${(finalSize / 1024 / 1024).toFixed(1)}MB for ${layerCount} layer(s)`);
    return finalSize;
}

// Normalize/clean a file extension string (strip query/fragment, lower-case)
export function getFileExtension(input) {
    return (input || '').toString().split(/[#?]/)[0].toLowerCase();
}

export default { sniffImageSize, calculateKTX2BufferSize, calculateKTX2ArrayBufferSize, getFileExtension };
