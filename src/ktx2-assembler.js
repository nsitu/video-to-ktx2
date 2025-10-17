import { read, write } from 'ktx-parse';
import { KTX2Encoder } from './ktx2-encoder.js';
import { Input, ALL_FORMATS, UrlSource, VideoSampleSink } from 'mediabunny';
import { updateLoadingText } from './utils/ui-utils.js';

/**
 * KTX2 Array Assembler
 * Encodes images and/or video frames sequentially 
 * then assembles multiple KTX2 buffers
 * into a single KTX2 array texture.
 */
export class KTX2Assembler {
    /**
     * Extract base parameters from first container
     * @private
     */
    static _extractBaseParams(container) {
        return {
            baseFormat: container.vkFormat,
            baseWidth: container.pixelWidth,
            baseHeight: container.pixelHeight,
            baseSupercompression: container.supercompressionScheme,
            baseKeyValue: container.keyValue,
            baseTypeSize: container.typeSize,
            sharedDfd: container.dataFormatDescriptor,
            firstLayerMipCount: container.levels.length
        };
    }

    /**
     * Validate layer/frame consistency with base parameters
     * @private
     */
    static _validateLayerConsistency(container, baseParams, layerIndex) {
        const { baseFormat, baseWidth, baseHeight, firstLayerMipCount } = baseParams;

        if (baseFormat !== 0 && container.vkFormat !== 0 && container.vkFormat !== baseFormat) {
            throw new Error(`Layer ${layerIndex} format mismatch: expected ${baseFormat}, got ${container.vkFormat}`);
        }
        if (container.pixelWidth !== baseWidth || container.pixelHeight !== baseHeight) {
            throw new Error(`Layer ${layerIndex} size mismatch: expected ${baseWidth}x${baseHeight}, got ${container.pixelWidth}x${container.pixelHeight}`);
        }
        if (container.levels.length !== firstLayerMipCount) {
            throw new Error(`Layer ${layerIndex} mip count mismatch: expected ${firstLayerMipCount}, got ${container.levels.length}`);
        }
    }

    // ======= MIP LEVELS ==================
    // NOTE: KTX2 specification requires array textures 
    // to store all layers for each mip level contiguously in memory.
    // This allows the GPU to efficiently access 
    // any layer at any mip level during rendering.
    // To "assemble" the mip levels means:
    // Concatenate layer data for each mip level into a single buffer
    // Apply proper padding (8-byte alignment) for uncompressed data
    // etc.

    /**
     * Assemble combined mip levels from encoded layers
     * @private
     */
    static _assembleMipLevels(encodedLayers, baseParams) {
        const { baseWidth, baseHeight, baseSupercompression } = baseParams;
        const layerCount = encodedLayers.length;
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
                ? totalSize
                : layersForThisMip.reduce((sum, l) => sum + l.uncompressedByteLength, 0);

            combinedLevels.push({
                levelData: combined,
                uncompressedByteLength: totalUncompressed
            });
        }

        return combinedLevels;
    }

    /**
     * Create final KTX2 array container
     * @private
     */
    static _createArrayContainer(encodedLayers, baseParams, combinedLevels) {
        return {
            vkFormat: baseParams.baseFormat,
            typeSize: baseParams.baseTypeSize,
            pixelWidth: baseParams.baseWidth,
            pixelHeight: baseParams.baseHeight,
            pixelDepth: 0,
            layerCount: encodedLayers.length,
            faceCount: 1,
            levelCount: combinedLevels.length,
            supercompressionScheme: baseParams.baseSupercompression,
            levels: combinedLevels,
            dataFormatDescriptor: baseParams.sharedDfd,
            keyValue: baseParams.baseKeyValue || {},
            globalData: null
        };
    }

    /**
     * Encode video frames from a video file URL with lazy frame decoding
     * @param {string} videoUrl - URL of the video file to decode and encode
     * @param {Object} options - Encoding options
     * @param {number} [options.maxFrames] - Maximum number of frames to encode (optional, encodes all if not specified)
     * @param {number} [options.startTime] - Start time in seconds (default: 0)
     * @param {number} [options.endTime] - End time in seconds (optional)
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async fromVideoUrl(videoUrl, options = {}) {
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

        // Generator function that yields RGBA frame data
        async function* rgbaFrameGenerator() {
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

                    const frameFileName = `frame_${frameCount.toString().padStart(5, '0')}`;

                    yield {
                        rgba,
                        width: w,
                        height: h,
                        fileName: frameFileName
                    };

                    frameCount++;
                } catch (error) {
                    videoSample.close();
                    throw error;
                }
            }

            console.log(`[Video Pipeline] Decoded ${frameCount} frames`);
        }

        // Use the unified encode method
        return await this.encode(rgbaFrameGenerator(), maxFrames);
    }

    /**
     * Encode multiple images from URLs with pipelined fetching and encoding
     * @param {Array<string>} urls - Array of image URLs to fetch and encode
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async fromImageUrls(urls) {
        if (!urls || urls.length === 0) {
            throw new Error('KTX2Assembler: No URLs provided');
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
     * Encode multiple images or video frames into a KTX2 2D array texture sequentially
     * @param {AsyncIterable} layerSource - Async generator that yields either:
     *   - {data: ArrayBuffer, fileName: string, extension: string} for image files
     *   - {rgba: Uint8Array, width: number, height: number, fileName: string} for video frames
     * @param {number} [expectedCount] - Expected number of layers (optional, for progress logging)
     * @returns {Promise<ArrayBuffer>} - KTX2 file buffer with layered texture
     */
    static async encode(layerSource, expectedCount = null) {
        console.log(`[Sequential Array Encoder] Starting sequential encoding...`);
        const startTime = performance.now();

        const encodedLayers = [];
        let baseParams = null;
        let layerIndex = 0;

        // Iterate through the async generator
        for await (const layer of layerSource) {
            const total = expectedCount !== null ? `/${expectedCount}` : '';

            // Detect layer type and encode accordingly
            let ktx2Buffer;
            if ('rgba' in layer) {
                // Video frame: RGBA pixel data
                const { rgba, width, height, fileName } = layer;
                console.log(`[Sequential] Encoding frame ${layerIndex + 1}${total}: ${fileName}`);
                updateLoadingText(`Encoding frame ${layerIndex + 1}${total}...`);
                ktx2Buffer = await KTX2Encoder.fromRGBA(rgba, width, height);
            } else {
                // Image file: ArrayBuffer with file data
                const { data, extension, fileName } = layer;
                console.log(`[Sequential] Encoding layer ${layerIndex + 1}${total}: ${fileName}`);
                updateLoadingText(`Encoding image ${layerIndex + 1}${total}...`);
                ktx2Buffer = await KTX2Encoder.fromImageFile(data, extension);
            }

            // Parse KTX2 to extract compressed data
            const container = read(new Uint8Array(ktx2Buffer));

            // Validate consistency across layers
            if (layerIndex === 0) {
                baseParams = this._extractBaseParams(container);
            } else {
                this._validateLayerConsistency(container, baseParams, layerIndex);
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

        // Assemble combined mip levels and create container
        const combinedLevels = this._assembleMipLevels(encodedLayers, baseParams);
        const arrayContainer = this._createArrayContainer(encodedLayers, baseParams, combinedLevels);

        // Write final KTX2 file
        const finalBuffer = write(arrayContainer);

        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(2);
        console.log(`[Sequential Array Encoder] Complete: ${finalBuffer.byteLength} bytes, ${layerCount} layers, ${combinedLevels.length} mips, ${duration}ms`);

        return finalBuffer;
    }
}
