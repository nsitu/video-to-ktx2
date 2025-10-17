// Web Worker for image resizing using OffscreenCanvas
// Handles cropping images to square and resizing to Power-of-Two dimensions for cube textures

const POWERS_OF_TWO = [128, 256, 512, 1024, 2048];
const MIN_SIZE = 128;
const MAX_SIZE = 2048; // Limited by BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS (6,291,456)

function nextPowerOfTwo(value) {
    // Clamp to valid range
    if (value <= MIN_SIZE) return MIN_SIZE;
    if (value >= MAX_SIZE) return MAX_SIZE;

    // Find the next power of two
    for (let pot of POWERS_OF_TWO) {
        if (pot >= value) {
            return pot;
        }
    }
    return MAX_SIZE;
}

function calculateSquareCropAndResize(originalWidth, originalHeight) {
    // Step 1: Determine the square crop size (use the smaller dimension)
    const squareSize = Math.min(originalWidth, originalHeight);

    // Check if the square crop is too small
    if (squareSize < MIN_SIZE) {
        throw new Error(`Image too small for square cropping (${originalWidth}x${originalHeight}). Minimum dimension: ${MIN_SIZE}px`);
    }

    // Step 2: Find the appropriate POT size for the square
    const potSize = nextPowerOfTwo(squareSize);

    // Step 3: Calculate crop region (center crop)
    const cropX = Math.floor((originalWidth - squareSize) / 2);
    const cropY = Math.floor((originalHeight - squareSize) / 2);

    return {
        cropRegion: {
            x: cropX,
            y: cropY,
            width: squareSize,
            height: squareSize
        },
        outputSize: potSize
    };
}

async function resizeImageToPOT(imageData, fileName, fileExtension) {
    const startTime = performance.now();

    try {
        // Create ImageBitmap from the image data
        const blob = new Blob([imageData], { type: `image/${fileExtension}` });
        const imageBitmap = await createImageBitmap(blob);

        const originalWidth = imageBitmap.width;
        const originalHeight = imageBitmap.height;

        console.log(`Processing ${fileName}.${fileExtension} (${originalWidth}x${originalHeight})`);

        // Calculate square crop and POT resize parameters
        const { cropRegion, outputSize } = calculateSquareCropAndResize(originalWidth, originalHeight);

        const isSquareAlready = originalWidth === originalHeight;
        const needsResize = cropRegion.width !== outputSize;

        if (!isSquareAlready) {
            console.log(`Cropping to square: ${cropRegion.width}x${cropRegion.height} (center crop)`);
        }

        if (needsResize) {
            console.log(`Resizing to POT: ${outputSize}x${outputSize}`);
        }

        // Create OffscreenCanvas with final POT square dimensions
        const canvas = new OffscreenCanvas(outputSize, outputSize);
        const ctx = canvas.getContext('2d');

        // Configure high-quality scaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Draw the cropped and scaled image
        // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
        ctx.drawImage(
            imageBitmap,
            cropRegion.x, cropRegion.y, cropRegion.width, cropRegion.height, // source crop
            0, 0, outputSize, outputSize // destination scale
        );

        // Convert back to blob
        const resizedBlob = await canvas.convertToBlob({
            type: 'image/png',
            quality: 1.0
        });

        // Convert blob to ArrayBuffer
        const resizedArrayBuffer = await resizedBlob.arrayBuffer();

        // Clean up
        imageBitmap.close();

        // Calculate timing and create appropriate message
        const elapsed = performance.now() - startTime;
        let timeMessage;

        if (!isSquareAlready && needsResize) {
            timeMessage = `Resize and Crop Time: ${elapsed.toFixed(2)}ms`;
        } else if (!isSquareAlready) {
            timeMessage = `Crop Time: ${elapsed.toFixed(2)}ms`;
        } else if (needsResize) {
            timeMessage = `Resize Time: ${elapsed.toFixed(2)}ms`;
        } else {
            timeMessage = `Processing Time: ${elapsed.toFixed(2)}ms (no changes needed)`;
        }

        console.log(timeMessage);

        return {
            success: true,
            data: resizedArrayBuffer,
            originalDimensions: { width: originalWidth, height: originalHeight },
            cropDimensions: { width: cropRegion.width, height: cropRegion.height },
            newDimensions: { width: outputSize, height: outputSize },
            wasCropped: !isSquareAlready,
            wasResized: needsResize,
            processingTime: elapsed,
            timeMessage: timeMessage,
            fileName: fileName,
            fileExtension: 'png' // Always output as PNG for consistency
        };

    } catch (error) {
        const elapsed = performance.now() - startTime;
        console.error('Error processing image:', error);
        return {
            success: false,
            error: error.message,
            processingTime: elapsed
        };
    }
}

// Handle messages from main thread
self.onmessage = async function (e) {
    const { imageData, fileName, fileExtension, taskId } = e.data;

    if (!imageData || !fileName || !fileExtension) {
        self.postMessage({
            taskId,
            success: false,
            error: 'Missing required parameters'
        });
        return;
    }

    const result = await resizeImageToPOT(imageData, fileName, fileExtension);

    // Send result back to main thread
    self.postMessage({
        taskId,
        ...result
    });
};