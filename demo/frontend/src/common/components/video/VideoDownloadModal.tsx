import React from 'react';

interface VideoDownloadModalProps {
  url: string;
  onClose: () => void;
}

export const VideoDownloadModal: React.FC<VideoDownloadModalProps> = ({ 
  url, 
  onClose 
}: VideoDownloadModalProps) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-lg max-w-lg w-full">
        <h2 className="text-xl font-bold mb-4">動画の処理が完了しました</h2>
        <div className="mb-4">
          <p className="mb-2">以下のURLから動画をダウンロードできます：</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 break-all"
          >
            {url}
          </a>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
            type="button"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
