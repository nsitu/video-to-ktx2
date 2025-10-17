import { threadingSupported, optimalThreadCount } from './utils/wasm-utils.js';
import { getBasisModule } from './load_basis.js';
import { calculateKTX2ArrayBufferSize, getFileExtension } from './utils/image-utils.js';

// Multi-image encoder: encodes N input images (identical dimensions) as a KTX2 2D texture array
// Mirrors the single-image implementation in image_to_ktx.js but sets multiple slices.

export const ImagesToKtx = {
    encode: encodeImagesToKtxArray,
    getBlob: getEncodedBlob
};

// Encoding settings with defaults (kept independent from single-image settings)
let encodingSettings = {
    multithreading: threadingSupported,
    uastcQuality: 1,
    rdoQuality: 1,
    rdoEnabled: false,
    srgb: true,
    mipmaps: true,    // generate full mipmap chain per-layer (to match single-image path)
    basisTexFormat: 1  // UASTC LDR 4x4
};

let encodedKTX2File = null;

function getEncodedBlob() {
    if (!encodedKTX2File || !encodedKTX2File.length) return null;
    return new Blob([encodedKTX2File]);
}


/**
 * Encode multiple LDR images as a KTX2 2D texture array.
 * @param {Array<{ data:ArrayBuffer, fileName?:string, extension:string }>} layers - Ordered list of input images.
 * @returns {Promise<Uint8Array>} Resolves with encoded KTX2 bytes.
 */
function encodeImagesToKtxArray(layers) {
    return new Promise((resolve, reject) => {
        try {
            if (!Array.isArray(layers) || layers.length === 0) {
                reject(new Error('No input layers provided'));
                return;
            }

            // Basic HDR rejection and extension normalization
            const normalized = layers.map((l, idx) => {
                if (!l || !l.data) throw new Error(`Layer ${idx}: missing data`);
                const ext = getFileExtension(l.extension);
                if (ext === 'exr' || ext === 'hdr') throw new Error('HDR source files are not supported');
                return { data: l.data, fileName: l.fileName || `layer_${idx}`, ext };
            });

            const Module = getBasisModule();
            if (!Module) {
                reject(new Error('BASIS module not loaded'));
                return;
            }

            const { BasisEncoder, initializeBasis } = Module;
            initializeBasis();

            // Allocate destination buffer (async)
            calculateKTX2ArrayBufferSize(normalized[0].data, normalized[0].ext, normalized.length, { mipmaps: encodingSettings.mipmaps })
                .then((bufferSize) => {
                    const ktx2FileData = new Uint8Array(bufferSize);

                    console.log('BasisEncoder::encode() for texture array started');
                    const basisEncoder = new BasisEncoder();
                    console.log(`Using ${optimalThreadCount} threads (multithreading=${encodingSettings.multithreading})`);
                    basisEncoder.controlThreading(encodingSettings.multithreading, optimalThreadCount);

                    // Configure for KTX2 + UASTC LDR
                    basisEncoder.setCreateKTX2File(true);
                    // Supercompression (Zstd) currently disabled to match single-image path; enable if desired
                    basisEncoder.setKTX2UASTCSupercompression(false);
                    basisEncoder.setKTX2SRGBTransferFunc(true);

                    // If the enum/method exists, explicitly request a 2D array texture type
                    try {
                        if (Module.cBASISTexType && basisEncoder.setTexType && Module.cBASISTexType.cBASISTexType2DArray !== undefined) {
                            basisEncoder.setTexType(Module.cBASISTexType.cBASISTexType2DArray);
                        }
                    } catch (_) { /* optional */ }

                    // Feed each slice
                    for (let i = 0; i < normalized.length; i++) {
                        const layer = normalized[i];
                        let img_type = Module.ldr_image_type.cPNGImage.value;
                        if (layer.ext === 'jpg' || layer.ext === 'jpeg' || layer.ext === 'jfif') {
                            img_type = Module.ldr_image_type.cJPGImage.value;
                        }
                        basisEncoder.setSliceSourceImage(i, new Uint8Array(layer.data), 0, 0, img_type);
                    }

                    // Common settings
                    basisEncoder.setFormatMode(encodingSettings.basisTexFormat);
                    basisEncoder.setPerceptual(encodingSettings.srgb);
                    basisEncoder.setMipSRGB(encodingSettings.srgb);
                    basisEncoder.setRDOUASTC(encodingSettings.rdoEnabled);
                    basisEncoder.setRDOUASTCQualityScalar(encodingSettings.rdoQuality);
                    basisEncoder.setMipGen(encodingSettings.mipmaps);
                    basisEncoder.setPackUASTCFlags(encodingSettings.uastcQuality);

                    console.log(`Encoding ${normalized.length} layer(s) to UASTC LDR 4x4`);
                    const startTime = performance.now();
                    const num_output_bytes = basisEncoder.encode(ktx2FileData);
                    const elapsed = performance.now() - startTime;
                    console.log('Encoding Time: ' + elapsed.toFixed(2) + 'ms');

                    const actualKTX2FileData = new Uint8Array(ktx2FileData.buffer, 0, num_output_bytes);
                    basisEncoder.delete();

                    if (num_output_bytes === 0) {
                        reject(new Error('encodeBasisTexture(array) failed! Output buffer may be too small or inputs mismatched.'));
                        return;
                    }

                    console.log(`encodeBasisTexture(array) succeeded, output size ${num_output_bytes}`);
                    encodedKTX2File = actualKTX2FileData;
                    resolve(actualKTX2FileData);
                })
                .catch(reject);
        } catch (err) {
            reject(err);
        }
    });
}

// Optional: allow callers to tweak settings
export function setImagesToKtxSettings(partial) {
    encodingSettings = { ...encodingSettings, ...(partial || {}) };
}
