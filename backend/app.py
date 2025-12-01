import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from uuid import uuid4
from flask import Flask, jsonify, request
from flask_cors import CORS

from parser import parse_spotify_json, parse_spotify_zip, ParseError

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB

# CORS configuration
allowed_origins = os.getenv('ALLOWED_ORIGINS', '*').split(',')
CORS(app, origins=allowed_origins)

# In-memory session store
sessions = {}

# Session cleanup settings
SESSION_MAX_AGE = timedelta(hours=1)


def cleanup_old_sessions():
    """Remove sessions older than SESSION_MAX_AGE."""
    now = datetime.now()
    expired = [
        sid for sid, data in sessions.items()
        if now - data.get('created_at', now) > SESSION_MAX_AGE
    ]
    for sid in expired:
        del sessions[sid]


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
        "progress": {"stage": "uploading", "percent": 0},
        "created_at": datetime.now()
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


if __name__ == '__main__':
    app.run(debug=os.getenv('FLASK_ENV') == 'development', port=5000)
