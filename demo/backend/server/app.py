# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import logging
import os
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
        request = PropagateInVideoRequest(
            type="propagate_in_video",
            session_id=session_id,
            start_frame_index=start_frame_index,
        )

        for chunk in inference_api.propagate_in_video(request=request):
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
