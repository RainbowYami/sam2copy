/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {getFileName} from '@/common/components/options/ShareUtils';
import {
  EncodingCompletedEvent,
  EncodingStateUpdateEvent,
} from '@/common/components/video/VideoWorkerBridge';
import useVideo from '@/common/components/video/editor/useVideo';
import {MP4ArrayBuffer} from 'mp4box';
import {useState} from 'react';

type DownloadingState = 'default' | 'started' | 'encoding' | 'completed';

type State = {
  state: DownloadingState;
  progress: number;
  download: (shouldSave?: boolean) => Promise<MP4ArrayBuffer>;
};

export default function useDownloadVideo(): State {
  const [downloadingState, setDownloadingState] =
    useState<DownloadingState>('default');
  const [progress, setProgress] = useState<number>(0);

  const video = useVideo();

  async function download(shouldSave = true): Promise<MP4ArrayBuffer> {
    return new Promise(resolve => {
      function onEncodingStateUpdate(event: EncodingStateUpdateEvent) {
        setDownloadingState('encoding');
        setProgress(event.progress);
        console.log(event.progress)
      }

      function onEncodingComplete(event: EncodingCompletedEvent) {
        const file = event.file;

        if (shouldSave) {
          saveVideo(file, getFileName());
        }

        video?.removeEventListener('encodingCompleted', onEncodingComplete);
        video?.removeEventListener(
          'encodingStateUpdate',
          onEncodingStateUpdate,
        );
        setDownloadingState('completed');
        resolve(file);
      }

      video?.addEventListener('encodingStateUpdate', onEncodingStateUpdate);
      video?.addEventListener('encodingCompleted', onEncodingComplete);

      if (downloadingState === 'default' || downloadingState === 'completed') {
        setDownloadingState('started');
        video?.pause();
        // 元の動画の音声トラックを取得してエンコードに渡す
        const audioTrack = video?.decodedVideo?.audioTrack;
        console.log('[Download] Audio track details:', {
          exists: !!audioTrack,
          codec: audioTrack?.codec,
          samplesCount: audioTrack?.samples?.length,
          timescale: audioTrack?.timescale,
          duration: audioTrack?.duration,
          firstSample: audioTrack?.samples?.[0] ? {
            size: audioTrack.samples[0].data.byteLength,
            duration: audioTrack.samples[0].duration,
            is_sync: audioTrack.samples[0].is_sync
          } : null,
          lastSample: audioTrack?.samples?.length ? {
            size: audioTrack.samples[audioTrack.samples.length - 1].data.byteLength,
            duration: audioTrack.samples[audioTrack.samples.length - 1].duration,
            is_sync: audioTrack.samples[audioTrack.samples.length - 1].is_sync
          } : null
        });
        
        if (!audioTrack?.samples?.length) {
          console.warn('[Download] No audio samples found in the track');
        }
        
        console.log('[Download] Starting encode with audio track');
        video?.encode(audioTrack);
      }
    });
  }

  function saveVideo(file: MP4ArrayBuffer, fileName: string) {
    const blob = new Blob([file]);
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    document.body.appendChild(a);
    a.setAttribute('href', url);
    a.setAttribute('download', fileName);
    a.setAttribute('target', '_self');
    a.click();
    window.URL.revokeObjectURL(url);
  }

  return {download, progress, state: downloadingState};
}
