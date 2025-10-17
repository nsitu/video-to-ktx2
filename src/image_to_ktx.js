
import { threadingSupported, optimalThreadCount } from './utils/wasm-utils.js';
import { getBasisModule } from './load_basis.js';
import { calculateKTX2BufferSize, getFileExtension } from './utils/image-utils.js';

// NOTE: Input images should have POT dimensions

export const ImageToKtx = {
    encode: encodeImageToKtx,
    getBlob: getEncodedBlob,
    configure: configureEncoding
}


// Encoding settings with defaults
let encodingSettings = {
    multithreading: threadingSupported,
    uastcQuality: 1,
    rdoQuality: 1,
    rdoEnabled: false,
    srgb: true,
    mipmaps: true,   // generate full mipmap chain for better minification quality
    supercompression: false, // Zstd supercompression disabled
    basisTexFormat: 1 // UASTC LDR 4x4
};

// NOTE:  Zstandard supercompression is disabled for simplicity 
// If you do want to enable it you might need additional zstddec.js/wasm 
// on the display end, hosted alongside the transcoder for KTX2Loader.

function configureEncoding(opts = {}) {
    // Shallow merge allowed options
    const allowed = [
        'multithreading', 'uastcQuality', 'rdoQuality', 'rdoEnabled',
        'srgb', 'mipmaps', 'supercompression', 'basisTexFormat'
    ];
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) {
            encodingSettings[k] = opts[k];
        }
    }
}


let encodedKTX2File = null;



function getEncodedBlob() {
    if (!encodedKTX2File) return null;
    if (!encodedKTX2File.length) return null;
    return new Blob([encodedKTX2File]);
}

// getFileExtension is imported from image-utils.js

// sniffImageSize is imported from image-utils.js

// calculateKTX2BufferSize is now imported from image-utils.js




async function encodeImageToKtx(data, fileName, extension) {
    return new Promise(async (resolve, reject) => {
        if (!data) {
            reject(new Error('No image data provided'));
            return;
        }

        const cleanExtension = getFileExtension(extension);


        const Module = getBasisModule();
        if (!Module) {
            reject(new Error('BASIS module not loaded'));
            return;
        }

        const { BasisEncoder, initializeBasis } = Module;

        initializeBasis();

        console.log("imageFileDataLoaded URI: " + fileName + '.' + cleanExtension);

        // Create a destination buffer with dynamic size based on image dimensions
        const bufferSize = await calculateKTX2BufferSize(data, cleanExtension);
        var ktx2FileData = new Uint8Array(bufferSize);

        // Compress using the BasisEncoder class
        console.log('BasisEncoder::encode() started:');

        const basisEncoder = new BasisEncoder();

        console.log(`Using ${optimalThreadCount} threads for encoding (CPU has ${navigator.hardwareConcurrency || 'unknown'} threads)`);
        basisEncoder.controlThreading(encodingSettings.multithreading, optimalThreadCount);


        // Since we only support LDR, force HDR files to error
        const isHDRSourceFile = (cleanExtension === "exr" || cleanExtension === "hdr");

        if (isHDRSourceFile) {
            const errorMsg = 'HDR source files are not supported';
            console.error(errorMsg);
            reject(new Error(errorMsg));
            return;
        }
        // Only LDR image types supported
        var img_type = Module.ldr_image_type.cPNGImage.value;
        if (cleanExtension != null) {
            if ((cleanExtension === "jpg") || (cleanExtension === "jpeg") || (cleanExtension === "jfif"))
                img_type = Module.ldr_image_type.cJPGImage.value;
        }
        // Settings
        basisEncoder.setSliceSourceImage(0, new Uint8Array(data), 0, 0, img_type);
        basisEncoder.setCreateKTX2File(true);
        basisEncoder.setKTX2UASTCSupercompression(encodingSettings.supercompression);
        basisEncoder.setKTX2SRGBTransferFunc(true); // Always true for LDR 
        basisEncoder.setFormatMode(encodingSettings.basisTexFormat);
        basisEncoder.setPerceptual(encodingSettings.srgb);
        basisEncoder.setMipSRGB(encodingSettings.srgb);
        basisEncoder.setRDOUASTC(encodingSettings.rdoEnabled);
        basisEncoder.setRDOUASTCQualityScalar(encodingSettings.rdoQuality);
        basisEncoder.setMipGen(encodingSettings.mipmaps);
        basisEncoder.setPackUASTCFlags(encodingSettings.uastcQuality);

        console.log('Encoding to UASTC LDR 4x4', encodingSettings.mipmaps ? '(with mipmaps)' : '(no mips)', encodingSettings.supercompression ? 'and Zstd supercompression' : 'without supercompression');

        const startTime = performance.now();

        var num_output_bytes = basisEncoder.encode(ktx2FileData);

        const elapsed = performance.now() - startTime;

        console.log('Encoding Time: ' + elapsed.toFixed(2) + 'ms');

        // Copy the encoded data to a new ArrayBuffer of the correct size

        var actualKTX2FileData = new Uint8Array(ktx2FileData.buffer, 0, num_output_bytes);

        basisEncoder.delete();

        if (num_output_bytes == 0) {
            const errorMsg = 'encodeBasisTexture() failed! Image may be too large to compress using 32-bit WASM.';
            console.error(errorMsg);
            reject(new Error(errorMsg));
        } else {
            console.log('encodeBasisTexture() succeeded, output size ' + num_output_bytes);
            encodedKTX2File = actualKTX2FileData;
            resolve(actualKTX2FileData);
        }
    });
}