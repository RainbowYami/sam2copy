#!/usr/bin/env python
# -*- coding: utf-8 -*-
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import logging
import os
import subprocess
import uuid
from typing import Any, Generator

from app_conf import (
    GALLERY_PATH,
    GALLERY_PREFIX,
    POSTERS_PATH,
    POSTERS_PREFIX,
    UPLOADS_PATH,
    UPLOADS_PREFIX,
)
from data.loader import preload_data
from data.schema import schema
from data.store import set_videos
from flask import Flask, make_response, Request, request, Response, send_from_directory
from flask_cors import CORS
from inference.data_types import PropagateDataResponse, PropagateInVideoRequest
from inference.multipart import MultipartResponseBuilder
from inference.predictor import InferenceAPI
from strawberry.flask.views import GraphQLView

import time
import requests
import io
from urllib.parse import urlparse  # blobUrlからのblobName抽出で使用

# Azure Blobアップロード用のインポート
try:
    from azure.storage.blob import BlobServiceClient
except ImportError:
    # インストールされていない場合にはエラーとなります
    pass

logger = logging.getLogger(__name__)

app = Flask(__name__)
cors = CORS(app, supports_credentials=True)

videos = preload_data()
set_videos(videos)

inference_api = InferenceAPI()


@app.route("/healthy")
def healthy() -> Response:
    return make_response("OK", 200)


def send_file_partial(path: str) -> Response:
    range_header = request.headers.get('Range', None)
    try:
        with open(path, 'rb') as f:
            size = os.path.getsize(path)
            if range_header:
                try:
                    bytes_range = range_header.replace('bytes=', '').split('-')
                    if bytes_range[0]:
                        # Handle "bytes=1000-" or "bytes=1000-2000" format
                        start = max(int(bytes_range[0]), 0)
                        if len(bytes_range) > 1 and bytes_range[1]:
                            end = min(int(bytes_range[1]), size - 1)
                        else:
                            # If no end is specified, return up to 1MB from the start position
                            end = min(start + 1024 * 1024 - 1, size - 1)
                    else:
                        # Handle "bytes=-500" format (last N bytes)
                        start = max(size - int(bytes_range[1]), 0) if bytes_range[1] else 0
                        end = size - 1
                except (ValueError, IndexError):
                    # If range header is malformed, return the full file
                    return Response(
                        f.read(),
                        200,
                        mimetype='video/mp4',
                        content_type='video/mp4',
                        direct_passthrough=True
                    )
                if start >= size:
                    return Response(status=416)
                # Use a smaller chunk size (1MB) to match decoder timing
                chunk_size = min(end - start + 1, 1024 * 1024)
                if chunk_size <= 0:
                    return Response(status=416)
                f.seek(start)
                actual_end = start + chunk_size - 1
                data = f.read(chunk_size)
                rv = Response(
                    data,
                    206,
                    mimetype='video/mp4',
                    content_type='video/mp4',
                    direct_passthrough=True
                )
                rv.headers.add('Content-Range', f'bytes {start}-{actual_end}/{size}')
                rv.headers.add('Accept-Ranges', 'bytes')
                rv.headers.add('Content-Length', str(chunk_size))
                return rv
            # When no range is requested, return the full file with proper headers
            data = f.read()
            rv = Response(
                data,
                200,
                mimetype='video/mp4',
                content_type='video/mp4',
                direct_passthrough=True
            )
            rv.headers.add('Accept-Ranges', 'bytes')
            rv.headers.add('Content-Length', str(size))
            return rv
    except:
        raise ValueError("resource not found")


@app.route(f"/{GALLERY_PREFIX}/<path:path>", methods=["GET"])
def send_gallery_video(path: str) -> Response:
    try:
        full_path = os.path.join(GALLERY_PATH, path)
        return send_file_partial(full_path)
    except:
        raise ValueError("resource not found")


@app.route(f"/{POSTERS_PREFIX}/<path:path>", methods=["GET"])
def send_poster_image(path: str) -> Response:
    try:
        return send_from_directory(
            POSTERS_PATH,
            path,
        )
    except:
        raise ValueError("resource not found")


@app.route(f"/{UPLOADS_PREFIX}/<path:path>", methods=["GET"])
def send_uploaded_video(path: str):
    try:
        full_path = os.path.join(UPLOADS_PATH, path)
        return send_file_partial(full_path)
    except:
        raise ValueError("resource not found")


# TOOD: Protect route with ToS permission check
@app.route("/propagate_in_video", methods=["POST"])
def propagate_in_video() -> Response:
    data = request.json
    args = {
        "session_id": data["session_id"],
        "start_frame_index": data.get("start_frame_index", 0),
    }

    boundary = "frame"
    frame = gen_track_with_mask_stream(boundary, **args)
    return Response(frame, mimetype="multipart/x-savi-stream; boundary=" + boundary)


def gen_track_with_mask_stream(
    boundary: str,
    session_id: str,
    start_frame_index: int,
) -> Generator[bytes, None, None]:
    with inference_api.autocast_context():
        request_obj = PropagateInVideoRequest(
            type="propagate_in_video",
            session_id=session_id,
            start_frame_index=start_frame_index,
        )

        for chunk in inference_api.propagate_in_video(request=request_obj):
            yield MultipartResponseBuilder.build(
                boundary=boundary,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Frame-Current": "-1",
                    # Total frames minus the reference frame
                    "Frame-Total": "-1",
                    "Mask-Type": "RLE[]",
                },
                body=chunk.to_json().encode("UTF-8"),
            ).get_message()


class MyGraphQLView(GraphQLView):
    def get_context(self, request: Request, response: Response) -> Any:
        return {"inference_api": inference_api}


# Add GraphQL route to Flask app.
app.add_url_rule(
    "/graphql",
    view_func=MyGraphQLView.as_view(
        "graphql_view",
        schema=schema,
        # Disable GET queries
        # https://strawberry.rocks/docs/operations/deployment
        # https://strawberry.rocks/docs/integrations/flask
        allow_queries_via_get=False,
        # Strawberry recently changed multipart request handling, which now
        # requires enabling support explicitly for views.
        # https://github.com/strawberry-graphql/strawberry/issues/3655
        multipart_uploads_enabled=True,
    ),
)


@app.route("/upload_encoded_video", methods=["POST"])
def upload_encoded_video():
    print("[DEBUG] upload_encoded_video called")
    try:
        data = request.json
        print("[DEBUG] received request.json =>", data)
        if not data or 'blobUrl' not in data:
            print("[DEBUG] 'blobUrl' not found in request")
            return make_response("No 'blobUrl' found in request", 400)

        # 今回は"blobUrl"を受け取り、そこからblobNameをパースする
        blob_url = data['blobUrl']
        print("[DEBUG] blob_url =>", blob_url)

        # urlparseを使ってblobNameを抽出する
        parsed = urlparse(blob_url)  # 例: scheme=http, netloc=127.0.0.1:10000, path=/devstoreaccount1/test-container/...mp4
        path_part = parsed.path  # "/devstoreaccount1/test-container/mainthread_upload_....mp4"
        blob_name = path_part.split('/')[-1]  # ...mp4 の部分だけ抜き出す
        print("[DEBUG] extracted blob_name =>", blob_name)

        container_name = os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "test-container")
        account_name = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME", "")
        account_key = os.environ.get("AZURE_STORAGE_ACCOUNT_KEY", "")
        print(f"[DEBUG] container_name={container_name}, account_name={account_name},account_key={account_key}")

        if not account_name or not account_key:
            print("[DEBUG] account_name or account_key is empty")
            return make_response("Storage account name or key not configured properly.", 500)
        
        connection_string = f"DefaultEndpointsProtocol=http;AccountName={account_name};AccountKey={account_key};BlobEndpoint=http://azurite:10000/{account_name};"

        from azure.storage.blob import BlobServiceClient

        # ローカルAzurite想定のaccount_url
        # BlobServiceClientの作成
        blob_service_client = BlobServiceClient.from_connection_string(connection_string)

        # コンテナクライアントの取得
        container_client = blob_service_client.get_container_client(container_name)

        # ブロブクライアントの取得
        blob_client = container_client.get_blob_client(blob_name)

        temp_filename = "upload_tmp_" + str(uuid.uuid4()) + ".mp4"
        temp_filepath = os.path.join(UPLOADS_PATH, temp_filename)
        print(f"[DEBUG] Downloading the blob to => {temp_filepath}")

        with open(temp_filepath, 'wb') as f:
            download_stream = blob_client.download_blob()
            download_stream.readinto(f)
        print("[DEBUG] Blob downloaded successfully!")

        # ffmpegでコピー
        output_filename = "copied_" + str(uuid.uuid4()) + ".mp4"
        output_filepath = os.path.join(UPLOADS_PATH, output_filename)
        print(f"[DEBUG] Running ffmpeg copy => {output_filepath}")

        subprocess.run([
            "ffmpeg",
            "-i", temp_filepath,
            "-movflags", "+faststart",
            "-c", "copy",
            output_filepath
        ], check=True)
        print("[DEBUG] ffmpeg copy finished successfully")

        os.remove(temp_filepath)
        print("[DEBUG] Removed temp file =>", temp_filepath)

        # コピー結果を再度 Azure Blob へアップロード
        connection_str = os.environ.get("VITE_AZURE_STORAGE_CONNECTION_STRING") or os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
        container_name = os.environ.get("VITE_AZURE_STORAGE_CONTAINER_NAME") or os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "test-container")

        print("[DEBUG] Attempting re-upload => container_name:", container_name)

        new_blob_name = "processed_" + str(uuid.uuid4()) + ".mp4"
        new_blob_client = container_client.get_blob_client(new_blob_name)
        print("[DEBUG] new_blob_name =>", new_blob_name)

        with open(output_filepath, 'rb') as datafile:
            new_blob_client.upload_blob(datafile, overwrite=True)
            print("[DEBUG] uploaded file successfully")

        os.remove(output_filepath)
        print("[DEBUG] removed output file =>", output_filepath)

        processed_blob_url = new_blob_client.url
        print("[DEBUG] processed_blob_url =>", processed_blob_url)

        return make_response({"downloadUrl": processed_blob_url}, 200)

    except subprocess.CalledProcessError as e:
        print("[DEBUG] CalledProcessError =>", e)
        return make_response(f"ffmpeg copy failed: {e}", 500)
    except Exception as e:
        print("[DEBUG] Exception =>", e)
        logger.exception("An error occurred in upload_encoded_video.")
        return make_response(f"error: {str(e)}", 500)


# 新規追加: SASトークンを生成して返すエンドポイント(既存)
@app.route("/sas", methods=["GET"])
def get_sas():
    try:
        from azure.storage.blob import generate_container_sas, ContainerSasPermissions
    except:
        return make_response("azure-storage-blob is not installed or not imported", 500)

    container_name = os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "test-container")
    account_name = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME", "")
    account_key = os.environ.get("AZURE_STORAGE_ACCOUNT_KEY", "")

    if not account_name or not account_key:
        return make_response("Storage account name or key not configured properly.", 500)

    from datetime import datetime, timedelta

    sas_token = generate_container_sas(
        account_name=account_name,
        container_name=container_name,
        account_key=account_key,
        permission=ContainerSasPermissions(read=True, write=True, create=True, add=True, list=True),
        expiry=datetime.utcnow() + timedelta(hours=1)
    )

    # Azurite用のローカルエンドポイントを使用
    sas_url = f"http://127.0.0.1:10000/devstoreaccount1/{container_name}?{sas_token}"
    return make_response({"sasUrl": sas_url}, 200)


# 新規追加: コンテナ作成をフロントではなくバックエンドで行うエンドポイント
@app.route("/create_container_if_not_exists", methods=["POST"])
def create_container_if_not_exists():
    connection_str = os.environ.get("VITE_AZURE_STORAGE_CONNECTION_STRING") or os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    container_name = os.environ.get("VITE_AZURE_STORAGE_CONTAINER_NAME") or os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "test-container")

    if not connection_str:
        return make_response("AZURE_STORAGE_CONNECTION_STRING is not set", 500)

    try:
        from azure.storage.blob import BlobServiceClient
    except:
        return make_response("azure-storage-blob is not installed or not imported", 500)

    blob_service_client = BlobServiceClient.from_connection_string(connection_str)
    container_client = blob_service_client.get_container_client(container_name)

    try:
        container_client.create_container()
    except:
        pass

    return make_response({"message": "Container created or already exists"}, 200)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
