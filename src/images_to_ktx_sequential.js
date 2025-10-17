import { read, write } from 'ktx-parse';
import { ImageToKtx } from './image_to_ktx.js';
import { Input, ALL_FORMATS, BlobSource, UrlSource, VideoSampleSink } from 'mediabunny';
import { getBasisModule } from './load_basis.js';

/**
 * Sequential KTX2 Array Encoder
 * Encodes images one at a time to avoid memory spikes, then assembles into a single KTX2 array texture.
 * More memory-efficient than encoding all images simultaneously for high frame counts.
 */
export class ImagesToKtxSequential {
    /**
     * Encode video frames from a video file URL with lazy frame decoding
     * @param {string} videoUrl - URL of the video file to decode and encode
     * @param {Object} options - Encoding options
     * @param {number} [options.maxFrames] - Maximum number of frames to encode (optional, encodes all if not specified)
     * @param {number} [options.startTime] - Start time in seconds (default: 0)
     * @param {number} [options.endTime] - End time in seconds (optional)
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async encodeFromVideoUrl(videoUrl, options = {}) {
        const { maxFrames = null, startTime = 0, endTime = null } = options;

        console.log(`[Video Pipeline] Loading video from: ${videoUrl}`);

        // Create mediabunny input with URL source for streaming (memory-efficient)
        // This streams the video data on-demand rather than loading it all into memory
        const input = new Input({
            formats: ALL_FORMATS,
            source: new UrlSource(videoUrl),
        });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
            throw new Error('No video track found in file');
        }

        // Check if we can decode
        const canDecode = await videoTrack.canDecode();
        if (!canDecode) {
            throw new Error('Video codec not supported for decoding');
        }

        // Get video info from direct properties
        const width = videoTrack.displayWidth;
        const height = videoTrack.displayHeight;
        const duration = await videoTrack.computeDuration();

        console.log(`[Video Pipeline] Video: ${width}x${height}, duration: ${duration.toFixed(2)}s`);

        // Get Basis module for encoding
        const Module = getBasisModule();
        if (!Module) {
            throw new Error('BASIS module not loaded');
        }

        // Generator function that yields encoded KTX2 frames from video
        async function* videoFrameGenerator() {
            const sink = new VideoSampleSink(videoTrack);

            let frameCount = 0;
            const actualEndTime = endTime !== null ? endTime : duration;

            // Iterate through video samples (frames)
            for await (const videoSample of sink.samples(startTime, actualEndTime)) {
                // Check if we've hit the max frame limit
                if (maxFrames !== null && frameCount >= maxFrames) {
                    videoSample.close();
                    break;
                }

                try {
                    // Convert to VideoFrame for pixel extraction
                    const videoFrame = videoSample.toVideoFrame();

                    const w = videoFrame.displayWidth;
                    const h = videoFrame.displayHeight;

                    // Extract RGBA pixel data from VideoFrame
                    const rgbaSize = videoFrame.allocationSize({ format: 'RGBA' });
                    const rgba = new Uint8Array(rgbaSize);
                    await videoFrame.copyTo(rgba, { format: 'RGBA' });

                    // Close the VideoFrame to free memory
                    videoFrame.close();
                    videoSample.close();

                    // Encode this frame to KTX2 using raw pixel data
                    const frameFileName = `frame_${frameCount.toString().padStart(5, '0')}`;
                    const ktx2Buffer = await encodeRGBAToKtx(rgba, w, h, frameFileName, Module);

                    // Parse to extract format info (we'll need this for assembly)
                    const container = read(new Uint8Array(ktx2Buffer));

                    yield {
                        ktx2Buffer,
                        container,
                        fileName: frameFileName,
                        frameIndex: frameCount
                    };

                    frameCount++;
                } catch (error) {
                    videoSample.close();
                    throw error;
                }
            }

            console.log(`[Video Pipeline] Decoded and encoded ${frameCount} frames`);
        }

        // Use modified encode logic that handles video frames
        return await this.encodeFromVideoGenerator(videoFrameGenerator());
    }

    /**
     * Encode from a generator that yields pre-encoded KTX2 frames
     * @param {AsyncIterable} frameGenerator - Async iterable yielding {ktx2Buffer, container, fileName, frameIndex}
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async encodeFromVideoGenerator(frameGenerator) {
        console.log(`[Sequential Video Encoder] Starting video frame encoding...`);
        const startTime = performance.now();

        const encodedLayers = [];
        let sharedDfd = null;
        let baseFormat = null;
        let baseWidth = null;
        let baseHeight = null;
        let baseSupercompression = null;
        let baseKeyValue = null;
        let baseTypeSize = null;

        let frameIndex = 0;

        // Process each pre-encoded frame
        for await (const { ktx2Buffer, container, fileName, frameIndex: idx } of frameGenerator) {
            console.log(`[Video Sequential] Processing frame ${idx + 1}: ${fileName}`);

            // Validate consistency across frames
            if (frameIndex === 0) {
                baseFormat = container.vkFormat;
                baseWidth = container.pixelWidth;
                baseHeight = container.pixelHeight;
                baseSupercompression = container.supercompressionScheme;
                baseKeyValue = container.keyValue;
                baseTypeSize = container.typeSize;
                sharedDfd = container.dataFormatDescriptor;
            } else {
                if (baseFormat !== 0 && container.vkFormat !== 0 && container.vkFormat !== baseFormat) {
                    throw new Error(`Frame ${frameIndex} format mismatch: expected ${baseFormat}, got ${container.vkFormat}`);
                }
                if (container.pixelWidth !== baseWidth || container.pixelHeight !== baseHeight) {
                    throw new Error(`Frame ${frameIndex} size mismatch: expected ${baseWidth}x${baseHeight}, got ${container.pixelWidth}x${container.pixelHeight}`);
                }
                if (container.levels.length !== encodedLayers[0].levels.length) {
                    throw new Error(`Frame ${frameIndex} mip count mismatch: expected ${encodedLayers[0].levels.length}, got ${container.levels.length}`);
                }
            }

            // Extract all mip levels for this frame
            const layerLevels = container.levels.map(level => ({
                levelData: level.levelData,
                uncompressedByteLength: level.uncompressedByteLength
            }));

            encodedLayers.push({
                levels: layerLevels,
                format: container.vkFormat,
                width: container.pixelWidth,
                height: container.pixelHeight
            });

            // Help GC reclaim memory
            container.levels = null;
            frameIndex++;
        }

        const layerCount = encodedLayers.length;
        console.log(`[Video Sequential] All ${layerCount} frames encoded. Assembling array texture...`);

        // Determine number of mip levels from first frame
        const mipCount = encodedLayers[0].levels.length;

        // Helper: Calculate expected UASTC size for a mip level
        const uastcBytesPerImageAtLevel = (level, width, height) => {
            const wL = Math.max(1, width >> level);
            const hL = Math.max(1, height >> level);
            const blocksX = Math.ceil(wL / 4);
            const blocksY = Math.ceil(hL / 4);
            return blocksX * blocksY * 16; // 16 bytes per 4x4 block
        };

        // Helper: Calculate 8-byte alignment padding
        const pad8 = (n) => (8 - (n % 8)) % 8;

        // Build combined levels array (one entry per mip level, containing all frames)
        const combinedLevels = [];

        for (let mipLevel = 0; mipLevel < mipCount; mipLevel++) {
            // Collect all frame data for this mip level
            const layersForThisMip = encodedLayers.map(layer => layer.levels[mipLevel]);

            // For NONE supercompression, calculate exact size with padding
            const exactSize = uastcBytesPerImageAtLevel(mipLevel, baseWidth, baseHeight);
            const perImagePadding = pad8(exactSize);
            const perImageWithPad = exactSize + perImagePadding;

            // Calculate total size including padding
            const totalSize = baseSupercompression === 0
                ? perImageWithPad * layerCount
                : layersForThisMip.reduce((sum, l) => sum + l.levelData.byteLength, 0);

            const combined = new Uint8Array(totalSize);
            let offset = 0;

            // Concatenate frame data with proper trimming and padding
            for (const levelData of layersForThisMip) {
                const srcData = new Uint8Array(levelData.levelData);

                if (baseSupercompression === 0) {
                    // NONE: Trim to exact UASTC size and add 8-byte padding
                    const trimmed = srcData.subarray(0, exactSize);
                    combined.set(trimmed, offset);
                    offset += trimmed.byteLength;

                    // Add padding (already zeros from initialization)
                    if (perImagePadding > 0) {
                        offset += perImagePadding;
                    }
                } else {
                    // ZSTD: Keep compressed bytes as-is
                    combined.set(srcData, offset);
                    offset += srcData.byteLength;
                }
            }

            // Calculate total uncompressed size for this mip across all frames
            const totalUncompressed = baseSupercompression === 0
                ? totalSize  // For NONE, uncompressed = total (including padding)
                : layersForThisMip.reduce((sum, l) => sum + l.uncompressedByteLength, 0);

            combinedLevels.push({
                levelData: combined,
                uncompressedByteLength: totalUncompressed
            });
        }

        // Assemble final KTX2 container as 2D array texture
        const arrayContainer = {
            vkFormat: baseFormat,
            typeSize: baseTypeSize,
            pixelWidth: baseWidth,
            pixelHeight: baseHeight,
            pixelDepth: 0,
            layerCount: layerCount,
            faceCount: 1,
            levelCount: mipCount,
            supercompressionScheme: baseSupercompression,
            levels: combinedLevels,
            dataFormatDescriptor: sharedDfd,
            keyValue: baseKeyValue || {},
            globalData: null
        };

        // Write final KTX2 file
        const arrayBuffer = write(arrayContainer);

        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);
        console.log(`[Video Sequential Encoder] Complete: ${arrayBuffer.byteLength} bytes, ${layerCount} frames, ${mipCount} mips, ${duration}ms`);

        return arrayBuffer;
    }

    /**
     * Encode multiple images from URLs with pipelined fetching and encoding
     * @param {Array<string>} urls - Array of image URLs to fetch and encode
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async encodeFromUrls(urls) {
        if (!urls || urls.length === 0) {
            throw new Error('ImagesToKtxSequential: No URLs provided');
        }

        console.log(`[Sequential Pipeline] Encoding ${urls.length} images with pipelined fetch...`);

        // Generator function that yields {data, fileName, extension} objects
        async function* imageGenerator() {
            // Start fetching first image
            let nextFetchPromise = fetch(urls[0]).then(r => {
                if (!r.ok) throw new Error(`Failed to fetch ${urls[0]}`);
                return r.arrayBuffer();
            });

            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const fileName = url.split('/').pop() || `image${i}`;
                const extension = fileName.split('.').pop() || 'jpg';

                // Wait for current image to finish fetching
                const data = await nextFetchPromise;

                // Immediately start fetching next image (pipeline optimization)
                if (i + 1 < urls.length) {
                    nextFetchPromise = fetch(urls[i + 1]).then(r => {
                        if (!r.ok) throw new Error(`Failed to fetch ${urls[i + 1]}`);
                        return r.arrayBuffer();
                    });
                }

                yield { data, fileName, extension };
            }
        }

        // Use the shared encode logic with our generator
        return await this.encode(imageGenerator(), urls.length);
    }

    /**
     * Encode multiple images into a KTX2 2D array texture sequentially
     * @param {Array|AsyncIterable} layers - Array or async iterable of {data: ArrayBuffer, fileName: string, extension: string}
     * @param {number} [expectedCount] - Expected number of layers (optional, for progress logging)
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async encode(layers, expectedCount = null) {
        console.log(`[Sequential Array Encoder] Starting sequential encoding...`);
        const startTime = performance.now();

        const encodedLayers = [];
        let sharedDfd = null;
        let baseFormat = null;
        let baseWidth = null;
        let baseHeight = null;
        let baseSupercompression = null;
        let baseKeyValue = null;
        let baseTypeSize = null;

        let layerIndex = 0;

        // Support both arrays and async iterables (generators)
        for await (const { data, fileName, extension } of layers) {
            const total = expectedCount !== null ? `/${expectedCount}` : '';
            console.log(`[Sequential] Encoding layer ${layerIndex + 1}${total}: ${fileName}`);

            // Encode single layer to KTX2
            const ktx2Buffer = await ImageToKtx.encode(data, fileName, extension);

            // Parse KTX2 to extract compressed data
            const container = read(new Uint8Array(ktx2Buffer));

            // Validate consistency across layers
            if (layerIndex === 0) {
                baseFormat = container.vkFormat;
                baseWidth = container.pixelWidth;
                baseHeight = container.pixelHeight;
                baseSupercompression = container.supercompressionScheme;
                baseKeyValue = container.keyValue;
                baseTypeSize = container.typeSize;
                sharedDfd = container.dataFormatDescriptor;
            } else {
                // For UASTC textures, vkFormat might be 0, so we should only check if both are non-zero
                if (baseFormat !== 0 && container.vkFormat !== 0 && container.vkFormat !== baseFormat) {
                    throw new Error(`Layer ${layerIndex} format mismatch: expected ${baseFormat}, got ${container.vkFormat}`);
                }
                if (container.pixelWidth !== baseWidth || container.pixelHeight !== baseHeight) {
                    throw new Error(`Layer ${layerIndex} size mismatch: expected ${baseWidth}x${baseHeight}, got ${container.pixelWidth}x${container.pixelHeight}`);
                }
                if (container.levels.length !== encodedLayers[0].levels.length) {
                    throw new Error(`Layer ${layerIndex} mip count mismatch: expected ${encodedLayers[0].levels.length}, got ${container.levels.length}`);
                }
            }

            // Extract all mip levels for this layer
            const layerLevels = container.levels.map(level => ({
                levelData: level.levelData,
                uncompressedByteLength: level.uncompressedByteLength
            }));

            encodedLayers.push({
                levels: layerLevels,
                format: container.vkFormat,
                width: container.pixelWidth,
                height: container.pixelHeight
            });

            // Help GC reclaim memory
            container.levels = null;
            layerIndex++;
        }

        const layerCount = encodedLayers.length;
        console.log(`[Sequential] All ${layerCount} layers encoded. Assembling array texture...`);

        // Determine number of mip levels from first layer
        const mipCount = encodedLayers[0].levels.length;

        // Helper: Calculate expected UASTC size for a mip level
        const uastcBytesPerImageAtLevel = (level, width, height) => {
            const wL = Math.max(1, width >> level);
            const hL = Math.max(1, height >> level);
            const blocksX = Math.ceil(wL / 4);
            const blocksY = Math.ceil(hL / 4);
            return blocksX * blocksY * 16; // 16 bytes per 4x4 block
        };

        // Helper: Calculate 8-byte alignment padding
        const pad8 = (n) => (8 - (n % 8)) % 8;

        // Build combined levels array (one entry per mip level, containing all layers)
        const combinedLevels = [];

        for (let mipLevel = 0; mipLevel < mipCount; mipLevel++) {
            // Collect all layer data for this mip level
            const layersForThisMip = encodedLayers.map(layer => layer.levels[mipLevel]);

            // For NONE supercompression, calculate exact size with padding
            const exactSize = uastcBytesPerImageAtLevel(mipLevel, baseWidth, baseHeight);
            const perImagePadding = pad8(exactSize);
            const perImageWithPad = exactSize + perImagePadding;

            // Calculate total size including padding
            const totalSize = baseSupercompression === 0
                ? perImageWithPad * layerCount
                : layersForThisMip.reduce((sum, l) => sum + l.levelData.byteLength, 0);

            const combined = new Uint8Array(totalSize);
            let offset = 0;

            // Concatenate layer data with proper trimming and padding
            for (const levelData of layersForThisMip) {
                const srcData = new Uint8Array(levelData.levelData);

                if (baseSupercompression === 0) {
                    // NONE: Trim to exact UASTC size and add 8-byte padding
                    const trimmed = srcData.subarray(0, exactSize);
                    combined.set(trimmed, offset);
                    offset += trimmed.byteLength;

                    // Add padding (already zeros from initialization)
                    if (perImagePadding > 0) {
                        offset += perImagePadding;
                    }
                } else {
                    // ZSTD: Keep compressed bytes as-is
                    combined.set(srcData, offset);
                    offset += srcData.byteLength;
                }
            }

            // Calculate total uncompressed size for this mip across all layers
            const totalUncompressed = baseSupercompression === 0
                ? totalSize  // For NONE, uncompressed = total (including padding)
                : layersForThisMip.reduce((sum, l) => sum + l.uncompressedByteLength, 0);

            combinedLevels.push({
                levelData: combined,  // Use Uint8Array directly, not .buffer
                uncompressedByteLength: totalUncompressed
            });
        }

        // Assemble final KTX2 container as 2D array texture
        const arrayContainer = {
            vkFormat: baseFormat,
            typeSize: baseTypeSize,
            pixelWidth: baseWidth,
            pixelHeight: baseHeight,
            pixelDepth: 0,
            layerCount: layerCount,
            faceCount: 1,
            levelCount: mipCount,  // Explicitly set levelCount
            supercompressionScheme: baseSupercompression,
            levels: combinedLevels,
            dataFormatDescriptor: sharedDfd,
            keyValue: baseKeyValue || {},
            globalData: null  // Array textures don't use globalData
        };

        // Write final KTX2 file
        const finalBuffer = write(arrayContainer);

        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);

        console.log(`[Sequential Array Encoder] Complete: ${finalBuffer.byteLength} bytes, ${layerCount} layers, ${mipCount} mips, ${duration}ms`);

        return finalBuffer;
    }

    /**
     * Configure encoder settings (passed through to ImageToKtx)
     * @param {Object} options - Configuration options
     */
    static configure(options) {
        ImageToKtx.configure(options);
    }
}

/**
 * Encode RGBA pixel data directly to KTX2
 * @param {Uint8Array} rgba - RGBA pixel data (width * height * 4 bytes)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} fileName - File name for logging
 * @param {Object} Module - Basis encoder module
 * @returns {Promise<Uint8Array>} - Encoded KTX2 data
 */
async function encodeRGBAToKtx(rgba, width, height, fileName, Module) {
    return new Promise((resolve, reject) => {
        const { BasisEncoder, initializeBasis } = Module;
        initializeBasis();

        // Estimate buffer size for output (generous estimate)
        const bufferSize = Math.max(1024 * 1024, width * height * 2);
        const ktx2FileData = new Uint8Array(bufferSize);

        const basisEncoder = new BasisEncoder();

        // Use raw RGBA pixel data directly
        basisEncoder.setSliceSourceImage(
            0,  // slice index
            rgba,  // RGBA pixel data
            width,
            height,
            Module.ldr_image_type.cRGBA32.value  // RGBA32 format
        );

        // Apply encoding settings (these should be configured via ImageToKtx.configure)
        basisEncoder.setCreateKTX2File(true);
        basisEncoder.setKTX2UASTCSupercompression(false);  // No supercompression for video frames
        basisEncoder.setKTX2SRGBTransferFunc(true);  // LDR content
        basisEncoder.setFormatMode(1);  // UASTC LDR 4x4
        basisEncoder.setPerceptual(true);  // sRGB
        basisEncoder.setMipSRGB(true);
        basisEncoder.setRDOUASTC(false);  // RDO disabled
        basisEncoder.setMipGen(true);  // Generate mipmaps
        basisEncoder.setPackUASTCFlags(1);  // Quality level 1

        const startTime = performance.now();
        const numOutputBytes = basisEncoder.encode(ktx2FileData);
        const elapsed = performance.now() - startTime;

        basisEncoder.delete();

        if (numOutputBytes === 0) {
            reject(new Error(`Failed to encode frame ${fileName}`));
        } else {
            const actualKTX2FileData = new Uint8Array(ktx2FileData.buffer, 0, numOutputBytes);
            console.log(`[Video Frame] Encoded ${fileName} (${width}x${height}) in ${elapsed.toFixed(1)}ms -> ${numOutputBytes} bytes`);
            resolve(actualKTX2FileData);
        }
    });
}
