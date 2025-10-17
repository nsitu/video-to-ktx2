# Video to KTX2 Array Encoding

This project now supports encoding video files directly to KTX2 array textures using a memory-efficient generator pattern.

## How It Works

The video encoder uses:
1. **mediabunny** - To decode video frames asynchronously
2. **Generator Pattern** - To lazily load and encode frames one at a time
3. **BASIS Universal** - To encode each frame as UASTC compressed texture
4. **KTX2 Array Assembly** - To combine all frames into a single KTX2 2D array texture

## Usage

### From Code

```javascript
import { ImagesToKtxSequential } from './images_to_ktx_sequential.js';

// Encode first 10 frames of a video
const arrayKtx = await ImagesToKtxSequential.encodeFromVideoUrl('./assets/test.webm', {
    maxFrames: 10,      // Limit to first 10 frames
    startTime: 0,       // Start at beginning (seconds)
    endTime: null       // Optional: end time in seconds
});

// Load the resulting KTX2 array texture
await loadKTX2ArrayFromBuffer(arrayKtx, 10);
```

### From URL Parameter

Add `?array=video` to the URL to test video encoding:

```
http://localhost:5173/?array=video
```

This will:
- Load `public/assets/test.webm`
- Extract the first 10 frames
- Encode each frame to UASTC format with mipmaps
- Assemble into a KTX2 2D array texture
- Display as animated texture layers

## Memory Efficiency

The generator pattern ensures:
- **One frame at a time**: Only one video frame is in memory during encoding
- **Pipeline optimization**: While encoding frame N, frame N+1 is being decoded
- **Automatic cleanup**: VideoFrames are closed immediately after pixel extraction
- **No upfront loading**: Frames are decoded on-demand from the video file

## Supported Formats

- **Input**: Any video format supported by browser's WebCodecs API
  - WebM (VP8, VP9, AV1)
  - MP4 (H.264, H.265)
  - And more depending on browser support

- **Output**: KTX2 with UASTC compression
  - Format: UASTC LDR 4x4
  - Mipmaps: Enabled
  - Supercompression: Disabled (for compatibility)

## Configuration

Encoder settings can be configured before encoding:

```javascript
import { ImageToKtx } from './image_to_ktx.js';

ImageToKtx.configure({
    mipmaps: true,           // Generate mipmap chain
    supercompression: false, // Zstd compression (disabled for video)
    srgb: true,             // sRGB color space
    uastcQuality: 1,        // UASTC quality (0-4)
    rdoEnabled: false       // Rate-distortion optimization
});
```

## Technical Details

### Frame Processing Pipeline

1. **Video Decoding** (mediabunny):
   ```javascript
   const videoSample = await sink.getSample(timestamp);
   const videoFrame = videoSample.toVideoFrame();
   ```

2. **Pixel Extraction** (WebCodecs):
   ```javascript
   const rgba = new Uint8Array(videoFrame.allocationSize({ format: 'RGBA' }));
   await videoFrame.copyTo(rgba, { format: 'RGBA' });
   ```

3. **BASIS Encoding** (custom):
   ```javascript
   basisEncoder.setSliceSourceImage(0, rgba, width, height, Module.ldr_image_type.cRGBA32.value);
   const ktx2Bytes = basisEncoder.encode(outputBuffer);
   ```

4. **Array Assembly** (ktx-parse):
   ```javascript
   const arrayContainer = {
       layerCount: frameCount,
       levels: combinedMipLevels,
       // ... other properties
   };
   const finalKtx2 = write(arrayContainer);
   ```

### Format Validation

The encoder validates that all frames have:
- ✓ Same dimensions (width × height)
- ✓ Same pixel format (UASTC)
- ✓ Same number of mip levels
- ✓ Same compression scheme

## Performance Tips

1. **Limit Frame Count**: Use `maxFrames` to process only needed frames
2. **Choose Resolution Wisely**: Smaller frames encode faster
3. **Time Range**: Use `startTime`/`endTime` to extract specific segments
4. **POT Dimensions**: Power-of-two dimensions work best (512×512, 1024×1024)

## Example Output

```
[Video Pipeline] Loading video from: ./assets/test.webm
[Video Pipeline] Video: 1920x1080, duration: 10.05s
[Video Frame] Encoded frame_00000 (1920x1080) in 245.3ms -> 2488320 bytes
[Video Frame] Encoded frame_00001 (1920x1080) in 238.1ms -> 2488320 bytes
...
[Video Pipeline] Decoded and encoded 10 frames
[Video Sequential Encoder] Complete: 24883200 bytes, 10 frames, 11 mips, 2453.67ms
```

## Comparison: Video vs Images

| Mode | Memory Usage | Processing Time | Use Case |
|------|-------------|----------------|----------|
| `video` | **Low** (1 frame) | Moderate | Many frames, limited memory |
| `sequential` | Low (1 image) | Fast | Multiple images |
| `ktx2` | High (all images) | Fastest | Few images, parallel encoding |
| `slices` | High (all images) | Fast | Separate KTX2 files per layer |

## Browser Requirements

- **WebCodecs API** (for video decoding)
- **WebAssembly** (for BASIS encoder)
- **Threading** (optional, for faster encoding)
- **SharedArrayBuffer** (optional, for threaded encoding)

## Troubleshooting

### "Video codec not supported"
- Try different video format (WebM with VP9 has best browser support)
- Check browser's WebCodecs support: `navigator.mediaCapabilities`

### Out of Memory
- Reduce `maxFrames` count
- Lower video resolution before encoding
- Close browser tabs to free memory

### Slow Encoding
- Enable threading in encoder configuration
- Use lower UASTC quality setting
- Disable RDO optimization
- Reduce video resolution
