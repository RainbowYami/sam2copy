import { ImageFrame } from '@/common/codecs/VideoDecoder';
import { MP4ArrayBuffer, createFile } from 'mp4box';
import { cloneFrame } from '@/common/codecs/WebCodecUtils';

// WebCodecs API types
interface VideoFrameInit {
  timestamp: number;
  duration?: number;
  alpha?: 'keep' | 'discard';
}

declare class VideoFrame {
  constructor(source: CanvasImageSource, init: VideoFrameInit);
  constructor(data: BufferSource, init: VideoFrameBufferInit);

  readonly timestamp: number;
  readonly duration: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly format: VideoPixelFormat | null;
  readonly colorSpace: VideoColorSpace | null;
  readonly visibleRect: DOMRectReadOnly | null;
  readonly codedRect: DOMRectReadOnly | null;

  allocationSize(options?: VideoFrameCopyToOptions): number;
  copyTo(destination: BufferSource, options?: VideoFrameCopyToOptions): Promise<PlaneLayout[]>;
  clone(): VideoFrame;
  close(): void;
}

interface VideoFrameBufferInit {
  format: VideoPixelFormat;
  codedWidth: number;
  codedHeight: number;
  timestamp: number;
  duration?: number;
  displayWidth?: number;
  displayHeight?: number;
  layout?: VideoFrameLayout[];
  visibleRect?: DOMRectInit;
  colorSpace?: VideoColorSpaceInit;
  alpha?: 'keep' | 'discard';
}

interface VideoColorSpaceInit {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  fullRange?: boolean;
}

interface VideoFrameCopyToOptions {
  rect?: DOMRectReadOnly;
  layout?: VideoFrameLayout[];
}

interface PlaneLayout {
  offset: number;
  stride: number;
}

interface VideoFrameLayout extends PlaneLayout {}

type VideoPixelFormat = 'I420' | 'I420A' | 'I422' | 'I444' | 'NV12' | 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX';

interface VideoColorSpace {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
}

type VideoCodec = 'avc1.4d0034' | 'avc1.42001e' | 'vp8' | 'vp09.00.10.08' | 'av01.0.04M.08';

interface VideoEncoderConfig {
  codec: VideoCodec;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  alpha?: 'keep' | 'discard';
  latencyMode?: 'quality' | 'realtime';
  bitrateMode?: 'constant' | 'variable';
}

class VideoEncoderError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'VideoEncoderError';
  }
}

interface VideoEncoderInit {
  output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
  error: (error: Error) => void;
}

interface EncodedVideoChunkMetadata {
  decoderConfig?: VideoDecoderConfig;
}

interface VideoDecoderConfig {
  description?: ArrayBuffer | ArrayBufferView;
}

interface EncodedVideoChunk {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  byteLength: number;
  copyTo(destination: Uint8Array): void;
}

declare class VideoEncoder {
  static isConfigSupported(config: VideoEncoderConfig): Promise<{
    supported: boolean;
    config?: VideoEncoderConfig;
  }>;
  constructor(init: VideoEncoderInit);
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}

// Simple browser detection
const ua = navigator.userAgent;
const isChrome = /Chrome/.test(ua);
const isEdge = /Edg/.test(ua);
const isWindows = /Windows/.test(ua);

// 簡易メモリログ関数
function logMemoryUsage(label: string) {
  const mem = (performance as any)?.memory;
  if (mem) {
    const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
    const totalMB = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
    console.log(`[Memory] ${label} => used: ${usedMB}MB / limit: ${totalMB}MB`);
  } else {
    console.log(`[Memory] ${label} => not available`);
  }
}

// 簡易ログ
function log(msg: string, data?: any) {
  console.log(`[DEBUG] ${msg}`, data || '');
}

// 簡易エラーログ
function logError(msg: string, err?: any) {
  console.error(`[ERROR] ${msg}`, err);
}

export class MinimalEncoderManager {
  private encoder: VideoEncoder | null = null;
  private outputFile: any;
  private trackID: number | null = null;
  private isFlushing = false;
  private fps: number;

  constructor(
    private width: number,
    private height: number,
    private onError: (err: any) => void,
    fps?: number
  ) {
    log('MinimalEncoderManager constructor called', { width, height, fps });
    this.outputFile = createFile();
    this.fps = fps || 30; // デフォルトは30fps
  }

  private createTrackIfNeeded(decoderConfig?: VideoDecoderConfig): void {
    log('createTrackIfNeeded called', { decoderConfig });
    if (this.trackID !== null) {
      log('Track already created, skipping.');
      return;
    }
    log('Creating track in MP4Box');

    let avcDecoderConfigRecord: ArrayBuffer | undefined = undefined;
    if (decoderConfig?.description) {
      if (decoderConfig.description instanceof ArrayBuffer) {
        avcDecoderConfigRecord = decoderConfig.description;
      } else if (ArrayBuffer.isView(decoderConfig.description)) {
        avcDecoderConfigRecord = decoderConfig.description.buffer;
      }
    }

    this.trackID = this.outputFile.addTrack({
      width: this.width,
      height: this.height,
      timescale: 90000,
      avcDecoderConfigRecord,
    });

    if (this.trackID == null) {
      throw new VideoEncoderError('Failed to addTrack', 'TRACK_CREATION_FAILED');
    }
    log('Track created', { trackID: this.trackID });
  }

  async initialize(): Promise<void> {
    log('initialize() start');
    const config: VideoEncoderConfig = {
      codec: 'avc1.4d0034',
      width: this.width,
      height: this.height,
      bitrate: 14_000_000,
      framerate: this.fps,
      alpha: 'discard',
      bitrateMode: 'variable',
      latencyMode: 'realtime',  // Safariで必要
    };

    log('Checking VideoEncoder config support', config);
    const support = await VideoEncoder.isConfigSupported(config);
    log('isConfigSupported result', support);
    if (!support.supported) {
      throw new VideoEncoderError(
        `VideoEncoder config not supported: ${JSON.stringify(config)}`,
        'CONFIG_NOT_SUPPORTED'
      );
    }
    this.encoder = new VideoEncoder({
      output: this.handleEncodedChunk.bind(this),
      error: (e) => this.onError(new VideoEncoderError(e.message, 'ENCODER_ERROR')),
    });
    this.encoder.configure(config);

    log(`Encoder configured`, { width: this.width, height: this.height });
    log('initialize() end');
  }

  private async handleEncodedChunk(
    chunk: EncodedVideoChunk,
    meta?: EncodedVideoChunkMetadata
  ): Promise<void> {
    log('handleEncodedChunk() start', { chunkType: chunk.type, chunkSize: chunk.byteLength, meta });
    try {
      if (meta?.decoderConfig) {
        this.createTrackIfNeeded(meta.decoderConfig);
      } else {
        this.createTrackIfNeeded(undefined);
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      const isKeyFrame = chunk.type === 'key';
      
      // マイクロ秒からタイムスケール90kHzに変換
      const duration = chunk.duration ? Math.round((chunk.duration * 90000) / 1_000_000) : 0;
      const timestamp = Math.round((chunk.timestamp * 90000) / 1_000_000);
      
      this.outputFile.addSample(this.trackID!, data, {
        duration: duration,
        is_sync: isKeyFrame,
        dts: timestamp,
        cts: timestamp,
      });

      log('Wrote sample', {
        size: data.length,
        isKeyFrame,
        chunkTimestamp: chunk.timestamp,
      });
    } catch (err) {
      const error = new VideoEncoderError(
        'Failed to handle encoded chunk: ' + (err instanceof Error ? err.message : String(err)),
        'CHUNK_HANDLING_FAILED'
      );
      this.onError(error);
      throw error;
    }
    log('handleEncodedChunk() end');
  }

  async encodeFrame(frame: ImageFrame): Promise<void> {
    if (!this.encoder) {
      throw new VideoEncoderError('Encoder is not initialized', 'ENCODER_NOT_INITIALIZED');
    }

    log('encodeFrame() called');
    logMemoryUsage('before encodeFrame');

    try {
      // ブラウザ固有の問題に対する対応
      if ((isWindows && isChrome) || (isWindows && isEdge)) {
        try {
          const clonedFrame = await cloneFrame(frame.bitmap);
          frame.bitmap.close();
          this.encoder.encode(clonedFrame, { keyFrame: true });
          clonedFrame.close();
        } catch (error) {
          logError('Failed to clone frame', error);
          // クローンに失敗した場合は、オリジナルのフレームを使用
          this.encoder.encode(frame.bitmap, { keyFrame: true });
          frame.bitmap.close();
        }
      } else {
        this.encoder.encode(frame.bitmap, { keyFrame: true });
        frame.bitmap.close();
      }
    } catch (error) {
      logError('Failed to encode frame', error);
      throw new VideoEncoderError(
        'Failed to encode frame: ' + (error instanceof Error ? error.message : String(error)),
        'ENCODE_FAILED'
      );
    }

    logMemoryUsage('after encodeFrame');
  }

  async flush(): Promise<void> {
    log('flush() called');
    if (!this.encoder) {
      throw new VideoEncoderError('Encoder is not initialized', 'ENCODER_NOT_INITIALIZED');
    }

    if (this.isFlushing) {
      log('flush() is already in progress, skipping');
      return;
    }
    this.isFlushing = true;

    log('Calling encoder.flush()...');
    try {
      await this.encoder.flush();
      log('encoder.flush() completed');
    } catch (err) {
      logError('encoder.flush() failed', err);
      throw new VideoEncoderError(
        'Failed to flush encoder: ' + (err instanceof Error ? err.message : String(err)),
        'FLUSH_FAILED'
      );
    } finally {
      this.isFlushing = false;
    }
  }

  getBuffer(): MP4ArrayBuffer {
    log('getBuffer() called');
    const buffer = this.outputFile.getBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new VideoEncoderError('No data written to MP4', 'EMPTY_BUFFER');
    }
    log('getBuffer() finished', { bufferLength: buffer.byteLength });
    return buffer;
  }
}

export async function encode(
  width: number,
  height: number,
  numFrames: number,
  framesGenerator: AsyncGenerator<ImageFrame, unknown>,
  progressCallback?: (progress: number) => void,
  fps?: number
): Promise<MP4ArrayBuffer> {
  console.log('encode() start', { width, height, numFrames });
  return new Promise<MP4ArrayBuffer>((resolve, reject) => {
    let manager: MinimalEncoderManager;

    async function handleError(e: any) {
      logError('encode() handleError', e);
      reject(e instanceof VideoEncoderError ? e : new VideoEncoderError(String(e), 'UNKNOWN_ERROR'));
    }

    manager = new MinimalEncoderManager(width, height, handleError, fps);

    manager
      .initialize()
      .then(async () => {
        try {
          // フレームをエンコード
          log('Encoding frames...');
          let encodedFrames = 0;
          for await (const frame of framesGenerator) {
            await manager.encodeFrame(frame);
            encodedFrames++;
            progressCallback?.(encodedFrames / numFrames);
          }

          log('All frames generated and encoded. Now flushing...');
          await manager.flush();

          logMemoryUsage('after flush');

          const buf = manager.getBuffer();
          log('encode() resolve with buffer');
          resolve(buf);
        } catch (error) {
          handleError(error);
        }
      })
      .catch(handleError);
  });
}
