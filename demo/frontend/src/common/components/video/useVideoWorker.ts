
import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import VideoWorkerBridge from './VideoWorkerBridge';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';

type Options = {
  createVideoWorker?: () => Worker;
  createWorkerBridge?: CreateWorkerBridgeFunction;
};

type WorkerFactory = () => Worker;

type CreateWorkerBridgeFunction = (
  workerFactory: WorkerFactory,
) => VideoWorkerBridge;

const DEFAULT_OPTIONS: Options = {
  createVideoWorker: () =>
    new Worker(new URL('./VideoWorker', import.meta.url), {
      type: 'module',
    }),
};

/**
 * useVideoWorker フック
 * @param src - 動画ソースURL
 * @param canvasRef - レンダリング先コンテナのref
 * @param options - VideoWorker生成オプション
 *
 * @returns { bridge, encodedAzureUrl }
 *   bridge: VideoWorkerBridge のインスタンス（addEventListener などを呼ぶ主体）
 *   encodedAzureUrl: エンコード処理後に Azure Blob Storage にアップロードした際の URL
 */
export default function useVideoWorker(
  src: string,
  canvasRef: RefObject<HTMLCanvasElement>,
  options: Options = {},
) {
  const isControlTransferredToOffscreenRef = useRef(false);

  // 例として、エンコード完了後の Azure Blob URL を表示する用途に利用
  const [encodedAzureUrl, setEncodedAzureUrl] = useState<string | null>(null);

  // 入力されたオプションにデフォルトをマージ
  const mergedOptions = useMemo(() => {
    const definedProps = (o: Options) =>
      Object.fromEntries(
        Object.entries(o).filter(([_k, v]) => v !== undefined),
      );
    return Object.assign(
      DEFAULT_OPTIONS,
      definedProps(options),
    ) as Required<Options>;
  }, [options]);

  // VideoWorkerBridge インスタンスを生成
  const bridge = useMemo(() => {
    if (mergedOptions.createWorkerBridge) {
      return mergedOptions.createWorkerBridge(mergedOptions.createVideoWorker);
    }
    return VideoWorkerBridge.create(mergedOptions.createVideoWorker);
  }, [mergedOptions]);

  // Canvas の Offscreen 化を実行
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas == null) {
      return;
    }
    if (isControlTransferredToOffscreenRef.current) {
      return;
    }

    isControlTransferredToOffscreenRef.current = true;
    bridge.setCanvas(canvas);

    return () => {
      // Cannot terminate worker in DEV mode
      // bridge.terminate();
    };
  }, [canvasRef, bridge]);

  // ソース変更時に再読み込み
  useEffect(() => {
    bridge.setSource(src);
  }, [src, bridge]);

  // Worker からのエンコード完了イベントを受け取り、
  // メインスレッドで Azure へアップロードする際に、先にバックエンドでコンテナ作成を実行するように変更
  useEffect(() => {
    const handleEncodingCompleted = async (event: any) => {
      const blobFromWorker = event.file as Blob;
      if (!blobFromWorker) {
        console.error('No blob received from encode event');
        return;
      }

      // 事前にバックエンドでコンテナ存在確認＆作成
      // (フロントで createIfNotExists を呼び出すと CORS エラーになるため)
      try {
        const containerCreateRes = await fetch('http://localhost:7263/create_container_if_not_exists', {
          method: 'POST',
        });
        if (!containerCreateRes.ok) {
          console.error('Failed to create container from backend:', containerCreateRes.status);
        }
      } catch (err) {
        console.error('Error calling create_container_if_not_exists:', err);
      }

      // ここでバックエンドから SAS URL を取得
      let sasUrl: string | null = null;
      try {
        const response = await fetch('http://localhost:7263/sas'); // "/sas" エンドポイントを使って取得
        if (!response.ok) {
          console.error('Failed to get SAS token from backend');
          return;
        }
        const data = await response.json();
        if (!data.sasUrl) {
          console.error('No sasUrl found in response');
          return;
        }
        sasUrl = data.sasUrl;
      } catch (error) {
        console.error('Error fetching SAS URL from backend:', error);
        return;
      }

      if (!sasUrl) {
        console.error('SAS URL is null or undefined');
        return;
      }

      try {
        // コネクションストリングは使わず、バックエンド発行の SAS URL を使ってアップロード
        const containerClient = new ContainerClient(sasUrl);
        // フロントからの createIfNotExists は撤廃された
        // await containerClient.createIfNotExists(); => 削除 (CORS回避)

        // 一意の blobName を生成
        const blobName = `mainthread_upload_${crypto.randomUUID()}.mp4`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(blobFromWorker, {
          blobHTTPHeaders: { blobContentType: 'video/mp4' },
        });

        const uploadedBlobUrl = blockBlobClient.url;
        setEncodedAzureUrl(uploadedBlobUrl);
        console.log('Uploaded to Azure Blob Storage URL =>', uploadedBlobUrl);

        // ここでバックエンドにbloburlを渡す
        // /upload_encoded_video
        try {
          const uploadEncodedRes = await fetch('http://localhost:7263/upload_encoded_video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blobUrl: uploadedBlobUrl }),
          });
          if (!uploadEncodedRes.ok) {
            console.error('Failed to call /upload_encoded_video, status:', uploadEncodedRes.status);
            return;
          }
          const uploadEncodedData = await uploadEncodedRes.json();
          if (!uploadEncodedData.downloadUrl) {
            console.error('No downloadUrl returned from /upload_encoded_video');
            return;
          }
          setEncodedAzureUrl(uploadEncodedData.downloadUrl);
          console.log('Final processed video from backend =>', uploadEncodedData.downloadUrl);
        } catch (err) {
          console.error('Error calling /upload_encoded_video:', err);
        }
      } catch (error) {
        console.error('Failed to upload to Azure Blob Storage:', error);
      }
    };

    // "encodingCompleted" イベント リスナーを登録
    bridge.addEventListener('encodingCompleted', handleEncodingCompleted);

    // cleanup
    return () => {
      bridge.removeEventListener('encodingCompleted', handleEncodingCompleted);
    };
  }, [bridge]);

  // フックの戻り値として、VideoWorkerBridge インスタンス と アップロード完了URL をオブジェクト形式で返す
  return {
    bridge,
    encodedAzureUrl,
  };
}
