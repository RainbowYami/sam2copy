import { AudioTrackData, ImageFrame } from '@/common/codecs/VideoDecoder';
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
  private videoTrackID: number | null = null;
  private audioTrackID: number | null = null;
  private isFlushing = false;
  private fps: number;

  constructor(
    private width: number,
    private height: number,
    private onError: (err: any) => void,
    fps?: number,
    private audioTrack?: AudioTrackData
  ) {
    log('MinimalEncoderManager constructor called', { 
      width, 
      height, 
      fps,
      hasAudioTrack: !!audioTrack,
      audioTrackDetails: audioTrack ? {
        codec: audioTrack.codec,
        samplesCount: audioTrack.samples?.length,
        timescale: audioTrack.timescale,
        firstSample: audioTrack.samples?.[0] ? {
          size: audioTrack.samples[0].data.byteLength,
          duration: audioTrack.samples[0].duration,
          is_sync: audioTrack.samples[0].is_sync
        } : null
      } : null
    });
    this.outputFile = createFile();
    this.fps = fps || 30; // デフォルトは30fps
  }

  private createTracksIfNeeded(decoderConfig?: VideoDecoderConfig): void {
    log('createTracksIfNeeded called', { decoderConfig });
    
    // ビデオトラックの作成
    if (this.videoTrackID === null) {
      log('Creating video track in MP4Box');

      let avcDecoderConfigRecord: ArrayBuffer | undefined = undefined;
      if (decoderConfig?.description) {
        if (decoderConfig.description instanceof ArrayBuffer) {
          avcDecoderConfigRecord = decoderConfig.description;
        } else if (ArrayBuffer.isView(decoderConfig.description)) {
          avcDecoderConfigRecord = decoderConfig.description.buffer;
        }
      }

      this.videoTrackID = this.outputFile.addTrack({
        width: this.width,
        height: this.height,
        timescale: 90000,
        avcDecoderConfigRecord,
      });

      if (this.videoTrackID == null) {
        throw new VideoEncoderError('Failed to add video track', 'TRACK_CREATION_FAILED');
      }
      log('Video track created', { trackID: this.videoTrackID });
    }

    // 音声トラックの作成
    if (this.audioTrack && this.audioTrackID === null) {
      log('Creating audio track in MP4Box');
      console.log('[AudioTrack] Creating with:', {
        timescale: this.audioTrack.timescale,
        codec: this.audioTrack.codec,
        samplesCount: this.audioTrack.samples.length,
        hasValidSamples: this.audioTrack.samples.some(s => s && s.data && s.data.byteLength > 0)
      });
      
      const audioTrackConfig = {
        timescale: this.audioTrack.timescale,
        codec: this.audioTrack.codec,
        language: 'und',
        duration: this.audioTrack.duration,
        samplerate: this.audioTrack.samples[0]?.timescale || this.audioTrack.timescale,
        channel_count: 2, // ステレオを想定
        width: 0,
        height: 0,
        hdlr: 'soun',  // 音声トラックであることを明示
        type: this.audioTrack.codec.split('.')[0]  // 例：'mp4a'
      };
      console.log('[AudioTrack] Adding track with config:', audioTrackConfig);
      
      this.audioTrackID = this.outputFile.addTrack(audioTrackConfig);

      if (this.audioTrackID == null) {
        throw new VideoEncoderError('Failed to add audio track', 'TRACK_CREATION_FAILED');
      }
      log('Audio track created', { trackID: this.audioTrackID });

      // 音声サンプルの追加
      let validSamplesCount = 0;
      let invalidSamplesCount = 0;
      for (const sample of this.audioTrack.samples) {
        if (sample && sample.data && sample.data.byteLength > 0) {
          validSamplesCount++;
          // タイムスケールの変換を確認
          const sampleTimescale = sample.timescale || this.audioTrack.timescale;
          const outputTimescale = this.audioTrack.timescale;
          
          const duration = sample.duration * (outputTimescale / sampleTimescale);
          const dts = sample.dts * (outputTimescale / sampleTimescale);
          const cts = sample.cts * (outputTimescale / sampleTimescale);

          console.log('[AudioTrack] Adding sample:', {
            inputTimescale: sampleTimescale,
            outputTimescale: outputTimescale,
            originalDuration: sample.duration,
            convertedDuration: duration,
            originalDts: sample.dts,
            convertedDts: dts,
            originalCts: sample.cts,
            convertedCts: cts
          });

          this.outputFile.addSample(this.audioTrackID, sample.data, {
            duration: Math.round(duration),
            dts: Math.round(dts),
            cts: Math.round(cts),
            is_sync: sample.is_sync
          });
        } else {
          invalidSamplesCount++;
        }
      }
      console.log('[AudioTrack] Added samples:', {
        totalCount: this.audioTrack.samples.length,
        validCount: validSamplesCount,
        invalidCount: invalidSamplesCount,
        hasValidSamples: validSamplesCount > 0,
        firstSample: this.audioTrack.samples[0] ? {
          size: this.audioTrack.samples[0].data.byteLength,
          duration: this.audioTrack.samples[0].duration,
          dts: this.audioTrack.samples[0].dts,
          cts: this.audioTrack.samples[0].cts,
          is_sync: this.audioTrack.samples[0].is_sync,
          isValid: !!(this.audioTrack.samples[0] && this.audioTrack.samples[0].data && this.audioTrack.samples[0].data.byteLength > 0)
        } : null,
        lastSample: this.audioTrack.samples[this.audioTrack.samples.length - 1] ? {
          size: this.audioTrack.samples[this.audioTrack.samples.length - 1].data.byteLength,
          duration: this.audioTrack.samples[this.audioTrack.samples.length - 1].duration,
          dts: this.audioTrack.samples[this.audioTrack.samples.length - 1].dts,
          cts: this.audioTrack.samples[this.audioTrack.samples.length - 1].cts,
          is_sync: this.audioTrack.samples[this.audioTrack.samples.length - 1].is_sync,
          isValid: !!(this.audioTrack.samples[this.audioTrack.samples.length - 1] && this.audioTrack.samples[this.audioTrack.samples.length - 1].data && this.audioTrack.samples[this.audioTrack.samples.length - 1].data.byteLength > 0)
        } : null
      });
    }
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
        this.createTracksIfNeeded(meta.decoderConfig);
      } else {
        this.createTracksIfNeeded(undefined);
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      const isKeyFrame = chunk.type === 'key';
      
      // マイクロ秒からタイムスケール90kHzに変換
      const duration = chunk.duration ? Math.round((chunk.duration * 90000) / 1_000_000) : 0;
      const timestamp = Math.round((chunk.timestamp * 90000) / 1_000_000);
      
      this.outputFile.addSample(this.videoTrackID!, data, {
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

    // 音声トラックの状態を確認
    if (this.audioTrack && this.audioTrackID !== null) {
      const track = this.outputFile.getTrackById(this.audioTrackID);
      if (track) {
        console.log('[MP4Box] Audio track info:', {
          id: this.audioTrackID,
          track: {
            nb_samples: track.samples?.length,
            codec: track.codec,
            language: track.language,
            alternate_group: track.alternate_group,
            created: track.created,
            modified: track.modified,
            movie_duration: track.movie_duration,
            movie_timescale: track.movie_timescale,
            layer: track.layer,
            volume: track.volume,
            track_width: track.track_width,
            track_height: track.track_height,
            timescale: track.timescale,
            duration: track.duration,
            bitrate: track.bitrate,
            sample_description_index: track.sample_description_index,
            samples_duration: track.samples_duration,
            samples_size: track.samples_size
          }
        });

        // トラックの設定を更新
        track.movie_duration = track.duration;
        track.movie_timescale = track.timescale;
      }
    }

    // ファイルをファイナライズ
    this.outputFile.flush();

    // トラックの期間を設定
    if (this.audioTrack && this.audioTrackID !== null) {
      const track = this.outputFile.getTrackById(this.audioTrackID);
      if (track) {
        // 音声トラックの期間を設定
        const trak = this.outputFile.moov.traks.find(t => t.tkhd.track_id === this.audioTrackID);
        if (trak) {
          trak.tkhd.duration = track.samples_duration;
          trak.mdia.mdhd.duration = track.samples_duration;
        }
      }
    }

    // ビデオトラックの期間を設定
    if (this.videoTrackID !== null) {
      const track = this.outputFile.getTrackById(this.videoTrackID);
      if (track) {
        const trak = this.outputFile.moov.traks.find(t => t.tkhd.track_id === this.videoTrackID);
        if (trak) {
          trak.tkhd.duration = track.samples_duration;
          trak.mdia.mdhd.duration = track.samples_duration;
        }
      }
    }

    // ムービーの期間を設定
    const movieDuration = Math.max(
      ...[this.videoTrackID, this.audioTrackID]
        .filter(id => id !== null)
        .map(id => {
          const track = this.outputFile.getTrackById(id!);
          const trak = this.outputFile.moov.traks.find(t => t.tkhd.track_id === id);
          if (track && trak) {
            return track.samples_duration * (this.outputFile.moov.mvhd.timescale / trak.mdia.mdhd.timescale);
          }
          return 0;
        })
    );
    this.outputFile.moov.mvhd.duration = movieDuration;

    const buffer = this.outputFile.getBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new VideoEncoderError('No data written to MP4', 'EMPTY_BUFFER');
    }
    
    // MP4ファイルの情報を確認
    const info = this.outputFile.getInfo();
    console.log('[MP4Box] Final file info:', {
      duration: info.duration,
      timescale: info.timescale,
      hasAudioTrack: info.audioTracks?.length > 0,
      audioTrackDetails: info.audioTracks?.[0] ? {
        id: info.audioTracks[0].id,
        codec: info.audioTracks[0].codec,
        duration: info.audioTracks[0].duration,
        timescale: info.audioTracks[0].timescale,
        sampleCount: info.audioTracks[0].nb_samples,
        language: info.audioTracks[0].language,
        bitrate: info.audioTracks[0].bitrate
      } : null
    });
    
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
  fps?: number,
  audioTrack?: AudioTrackData
): Promise<MP4ArrayBuffer> {
  console.log('[VideoEncoder] Starting encode:', { 
    width, 
    height, 
    numFrames,
    hasAudioTrack: !!audioTrack,
    audioTrackDetails: audioTrack ? {
      codec: audioTrack.codec,
      samplesCount: audioTrack.samples?.length,
      timescale: audioTrack.timescale,
      firstSample: audioTrack.samples?.[0] ? {
        size: audioTrack.samples[0].data.byteLength,
        duration: audioTrack.samples[0].duration,
        is_sync: audioTrack.samples[0].is_sync
      } : null,
      lastSample: audioTrack.samples?.length ? {
        size: audioTrack.samples[audioTrack.samples.length - 1].data.byteLength,
        duration: audioTrack.samples[audioTrack.samples.length - 1].duration,
        is_sync: audioTrack.samples[audioTrack.samples.length - 1].is_sync
      } : null
    } : null
  });
  return new Promise<MP4ArrayBuffer>((resolve, reject) => {
    let manager: MinimalEncoderManager;

    async function handleError(e: any) {
      logError('encode() handleError', e);
      reject(e instanceof VideoEncoderError ? e : new VideoEncoderError(String(e), 'UNKNOWN_ERROR'));
    }

    manager = new MinimalEncoderManager(width, height, handleError, fps, audioTrack);

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
