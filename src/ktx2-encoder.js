
import { threadingSupported, optimalThreadCount } from './utils/wasm-utils.js';
import { getBasisModule } from './load_basis.js';
import { calculateKTX2BufferSize, getFileExtension } from './utils/image-utils.js';

// NOTE: Input images should have POT dimensions


// NOTE:  Zstandard supercompression is disabled for simplicity 
// If you do want to enable it you might need additional zstddec.js/wasm 
// on the display end, hosted alongside the transcoder for KTX2Loader.


/**
 * KTX2 Encoder with factory methods for different input types
 */
export class KTX2Encoder {
    constructor() {
        this.settings = {
            multithreading: threadingSupported,
            uastcQuality: 1,
            rdoQuality: 1,
            rdoEnabled: false,
            srgb: true,
            mipmaps: true,   // generate full mipmap chain for better minification quality
            supercompression: false, // Zstd supercompression disabled
            basisTexFormat: 1 // UASTC LDR 4x4
        };
    }

    /**
     * Core encode method
     * @param {Object} params - Encoding parameters
     * @returns {Promise<Uint8Array>} - Encoded KTX2 data
     */
    async encode({ data, width, height, extension, isRGBA = false }) {
        return new Promise(async (resolve, reject) => {
            if (!data) {
                reject(new Error('No image data provided'));
                return;
            }

            const Module = getBasisModule();
            if (!Module) {
                reject(new Error('BASIS module not loaded'));
                return;
            }

            const { BasisEncoder, initializeBasis } = Module;
            initializeBasis();

            // Determine buffer size
            let bufferSize;
            if (isRGBA) {
                // For RGBA: generous estimate based on dimensions
                if (!width || !height) {
                    reject(new Error('Width and height required for RGBA encoding'));
                    return;
                }
                bufferSize = Math.max(1024 * 1024, width * height * 2);
            } else {
                // For files: calculate based on image data
                const cleanExtension = getFileExtension(extension);
                bufferSize = await calculateKTX2BufferSize(data, cleanExtension);
            }

            const ktx2FileData = new Uint8Array(bufferSize);
            const basisEncoder = new BasisEncoder();

            // Configure threading
            if (this.settings.multithreading) {
                console.log(`Using ${optimalThreadCount} threads for encoding`);
                basisEncoder.controlThreading(true, optimalThreadCount);
            } else {
                basisEncoder.controlThreading(false, 1);
            }

            // Set source image based on type
            if (isRGBA) {
                // Raw RGBA pixel data
                basisEncoder.setSliceSourceImage(
                    0,
                    data,
                    width,
                    height,
                    Module.ldr_image_type.cRGBA32.value
                );
            } else {
                // File data (PNG/JPG)
                const cleanExtension = getFileExtension(extension);

                // Check for HDR (not supported)
                if (cleanExtension === "exr" || cleanExtension === "hdr") {
                    reject(new Error('HDR source files are not supported'));
                    return;
                }

                // Determine image type
                let imgType = Module.ldr_image_type.cPNGImage.value;
                if (cleanExtension === "jpg" || cleanExtension === "jpeg" || cleanExtension === "jfif") {
                    imgType = Module.ldr_image_type.cJPGImage.value;
                }

                basisEncoder.setSliceSourceImage(0, data, 0, 0, imgType);
            }

            // Apply encoding settings
            basisEncoder.setCreateKTX2File(true);
            basisEncoder.setKTX2UASTCSupercompression(this.settings.supercompression);
            basisEncoder.setKTX2SRGBTransferFunc(true); // Always true for LDR
            basisEncoder.setFormatMode(this.settings.basisTexFormat);
            basisEncoder.setPerceptual(this.settings.srgb);
            basisEncoder.setMipSRGB(this.settings.srgb);
            basisEncoder.setRDOUASTC(this.settings.rdoEnabled);
            basisEncoder.setRDOUASTCQualityScalar(this.settings.rdoQuality);
            basisEncoder.setMipGen(this.settings.mipmaps);
            basisEncoder.setPackUASTCFlags(this.settings.uastcQuality);

            const startTime = performance.now();
            const numOutputBytes = basisEncoder.encode(ktx2FileData);
            const elapsed = performance.now() - startTime;

            basisEncoder.delete();

            if (numOutputBytes === 0) {
                reject(new Error('Encoding failed'));
            } else {
                const actualKTX2FileData = new Uint8Array(ktx2FileData.buffer, 0, numOutputBytes);
                const sizeKB = (numOutputBytes / 1024).toFixed(1);
                const dims = isRGBA ? ` (${width}x${height})` : '';
                console.log(`Encoded${dims} in ${elapsed.toFixed(1)}ms -> ${sizeKB}KB`);
                resolve(actualKTX2FileData);
            }
        });
    }

    /**
     * Encode from image file data (PNG/JPG)
     * @param {ArrayBuffer|Uint8Array} data - Image file bytes
     * @param {string} extension - File extension (e.g., 'jpg', 'png')
     * @returns {Promise<Uint8Array>} - Encoded KTX2 data
     */
    static async fromImageFile(data, extension) {
        return new KTX2Encoder().encode({
            data: new Uint8Array(data),
            extension,
            isRGBA: false
        });
    }

    /**
     * Encode from raw RGBA pixel data
     * @param {Uint8Array} rgba - RGBA pixel data (width * height * 4 bytes)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Promise<Uint8Array>} - Encoded KTX2 data
     */
    static async fromRGBA(rgba, width, height) {
        return new KTX2Encoder().encode({
            data: rgba,
            width,
            height,
            isRGBA: true
        });
    }
}