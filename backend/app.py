import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from uuid import uuid4
import time
import orjson
from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from parser import parse_spotify_json, parse_spotify_zip, ParseError
from segmentation import segment_listening_history, calculate_aggregate_stats
from llm_service import name_all_eras
from playlist_builder import build_all_playlists
from models import Era, Playlist
from typing import Optional, Tuple

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB

# CORS configuration
allowed_origins = os.getenv('ALLOWED_ORIGINS', '*').split(',')
CORS(app, origins=allowed_origins)

# Rate limiting
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["100 per minute"],
    storage_uri="memory://"
)

# In-memory session store
sessions = {}

# Session cleanup settings
SESSION_MAX_AGE = timedelta(hours=1)


def cleanup_old_sessions():
    """Remove sessions that have been idle longer than SESSION_MAX_AGE."""
    now = datetime.now()
    expired = [
        sid for sid, data in sessions.items()
        if (now - data.get('last_accessed', data.get('created_at', now))).total_seconds() > 3600
    ]
    for sid in expired:
        del sessions[sid]


def validate_session_ready(session_id: str) -> Tuple[Optional[dict], Optional[Tuple[dict, int]]]:
    """
    Validate session exists and processing is complete.

    Returns:
        (session, None) if valid and ready
        (None, (error_dict, status_code)) if invalid
    """
    if session_id not in sessions:
        return None, ({"error": "Session not found"}, 404)

    session = sessions[session_id]

    # Update last accessed time for TTL
    session["last_accessed"] = datetime.now()

    if session["progress"]["stage"] == "error":
        return None, ({"error": session["progress"].get("message", "Processing failed")}, 400)

    if session["progress"]["stage"] != "complete":
        return None, ({"error": "Processing not complete", "stage": session["progress"]["stage"]}, 425)

    return session, None


def serialize_era_summary(era: Era) -> dict:
    """Serialize era for list view (minimal data)."""
    return {
        "id": era.id,
        "title": era.title,
        "start_date": era.start_date.isoformat(),
        "end_date": era.end_date.isoformat(),
        "top_artists": [{"name": name, "plays": count} for name, count in era.top_artists[:3]],
        "playlist_track_count": len(era.top_tracks)
    }


def serialize_era_detail(era: Era, playlist: Optional[Playlist]) -> dict:
    """Serialize era for detail view (full data)."""
    return {
        "id": era.id,
        "title": era.title,
        "summary": era.summary,
        "start_date": era.start_date.isoformat(),
        "end_date": era.end_date.isoformat(),
        "total_ms_played": era.total_ms_played,
        "top_artists": [{"name": name, "plays": count} for name, count in era.top_artists],
        "top_tracks": [{"track": track, "artist": artist, "plays": count} for track, artist, count in era.top_tracks],
        "playlist": {
            "era_id": playlist.era_id,
            "tracks": playlist.tracks
        } if playlist else None
    }


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})


# ZIP magic bytes
ZIP_MAGIC = b'PK\x03\x04'


def is_zip_file(file_bytes):
    """Check if file is a ZIP by magic bytes."""
    return file_bytes[:4] == ZIP_MAGIC


def is_valid_file_type(file_bytes, filename):
    """Check if file is a valid ZIP or JSON file."""
    is_zip = is_zip_file(file_bytes)
    is_json_ext = filename.lower().endswith('.json')
    is_zip_ext = filename.lower().endswith('.zip')
    return is_zip or is_json_ext or is_zip_ext


@app.route('/upload', methods=['POST'])
@limiter.limit("10 per minute")
def upload():
    cleanup_old_sessions()

    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400

    file_bytes = file.read()

    if not is_valid_file_type(file_bytes, file.filename):
        return jsonify({"error": "Invalid file type. Please upload a .json or .zip file"}), 400

    session_id = str(uuid4())
    sessions[session_id] = {
        "events": [],
        "eras": [],
        "playlists": [],
        "stats": {},
        "progress": {"stage": "uploading", "percent": 0},
        "created_at": datetime.now(),
        "last_accessed": datetime.now()
    }

    # Parse the file
    try:
        if is_zip_file(file_bytes):
            events = parse_spotify_zip(file_bytes)
        else:
            events = parse_spotify_json(file_bytes)
    except ParseError as e:
        del sessions[session_id]
        return jsonify({"error": f"Failed to parse file: {e}"}), 400

    if not events:
        del sessions[session_id]
        return jsonify({"error": "No listening history found in file"}), 400

    sessions[session_id]["events"] = events
    sessions[session_id]["progress"] = {"stage": "parsed", "percent": 20}

    return jsonify({"session_id": session_id})


# SSE settings
SSE_POLL_INTERVAL = 0.5  # seconds
SSE_KEEPALIVE_INTERVAL = 15  # seconds
SSE_TIMEOUT = 300  # 5 minutes max


@app.route('/progress/<session_id>', methods=['GET'])
def progress(session_id):
    if session_id not in sessions:
        return jsonify({"error": "Session not found"}), 404

    def generate():
        start_time = time.time()
        last_keepalive = start_time

        while True:
            # Check timeout
            elapsed = time.time() - start_time
            if elapsed > SSE_TIMEOUT:
                yield f"data: {orjson.dumps({'stage': 'error', 'message': 'Timeout'}).decode()}\n\n"
                break

            # Check if session still exists
            if session_id not in sessions:
                yield f"data: {orjson.dumps({'stage': 'error', 'message': 'Session expired'}).decode()}\n\n"
                break

            # Get current progress
            session = sessions[session_id]
            progress_data = session.get("progress", {"stage": "unknown", "percent": 0})

            # Send progress update
            yield f"data: {orjson.dumps(progress_data).decode()}\n\n"

            # Check if complete or error
            if progress_data.get("stage") in ("complete", "error"):
                break

            # Send keepalive if needed
            current_time = time.time()
            if current_time - last_keepalive >= SSE_KEEPALIVE_INTERVAL:
                yield ": keepalive\n\n"
                last_keepalive = current_time

            time.sleep(SSE_POLL_INTERVAL)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'  # Disable nginx buffering
        }
    )


@app.route('/process/<session_id>', methods=['POST'])
@limiter.limit("5 per minute")
def process(session_id):
    """Trigger era segmentation and LLM naming for a session."""
    if session_id not in sessions:
        return jsonify({"error": "Session not found"}), 404

    session = sessions[session_id]

    if not session.get("events"):
        return jsonify({"error": "No events to process"}), 400

    try:
        # Calculate aggregate stats before processing (needed for API)
        session["stats"] = calculate_aggregate_stats(session["events"])

        # Phase 1: Segmentation
        eras = segment_listening_history(session["events"])

        if not eras:
            session["progress"] = {
                "stage": "error",
                "message": "No distinct eras found in your listening history",
                "percent": 0
            }
            return jsonify({"error": "No distinct eras found"}), 400

        # Store eras and update progress
        session["eras"] = eras
        session["progress"] = {"stage": "segmented", "percent": 40}

        # Free memory by removing raw events (stats already preserved)
        del session["events"]

        # Phase 2: LLM Naming
        def update_progress(percent):
            session["progress"] = {"stage": "naming", "percent": percent}

        name_all_eras(eras, update_progress)
        session["progress"] = {"stage": "named", "percent": 70}

        # Phase 3: Playlist Generation
        session["progress"] = {"stage": "playlists", "percent": 80}
        try:
            playlists = build_all_playlists(eras)
            session["playlists"] = playlists
        except Exception:
            # Playlist generation failed, continue with empty playlists
            session["playlists"] = []

        session["progress"] = {"stage": "complete", "percent": 100}

        return jsonify({"status": "ok", "era_count": len(eras)})

    except Exception as e:
        session["progress"] = {
            "stage": "error",
            "message": str(e),
            "percent": 0
        }
        return jsonify({"error": f"Processing failed: {e}"}), 500


@app.route('/session/<session_id>/summary', methods=['GET'])
def get_summary(session_id):
    """Get summary statistics for a completed session."""
    session, error = validate_session_ready(session_id)
    if error:
        return jsonify(error[0]), error[1]

    stats = session["stats"]
    eras = session["eras"]

    return jsonify({
        "total_eras": len(eras),
        "date_range": stats["date_range"],
        "total_listening_time_ms": stats["total_ms"],
        "total_tracks": stats["total_tracks"],
        "total_artists": stats["total_artists"]
    })


@app.route('/session/<session_id>/eras', methods=['GET'])
def get_eras(session_id):
    """Get list of all eras for a completed session."""
    session, error = validate_session_ready(session_id)
    if error:
        return jsonify(error[0]), error[1]

    eras = sorted(session["eras"], key=lambda e: e.start_date)
    return jsonify([serialize_era_summary(era) for era in eras])


@app.route('/session/<session_id>/eras/<era_id>', methods=['GET'])
def get_era_detail(session_id, era_id):
    """Get detailed information for a specific era."""
    session, error = validate_session_ready(session_id)
    if error:
        return jsonify(error[0]), error[1]

    # Validate era_id format
    try:
        era_id = int(era_id)
    except ValueError:
        return jsonify({"error": "Invalid era_id format"}), 400

    # Find era
    era = next((e for e in session["eras"] if e.id == era_id), None)
    if not era:
        return jsonify({"error": "Era not found"}), 404

    # Find associated playlist
    playlist = next((p for p in session["playlists"] if p.era_id == era_id), None)

    return jsonify(serialize_era_detail(era, playlist))


if __name__ == '__main__':
    app.run(debug=os.getenv('FLASK_ENV') == 'development', port=5000)
