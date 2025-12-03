import os
import logging
import sys
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

# Configure logging
logging.basicConfig(
    level=logging.INFO if os.getenv('FLASK_ENV') == 'production' else logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('tasteswipe.log') if os.getenv('FLASK_ENV') == 'production' else logging.NullHandler()
    ]
)
logger = logging.getLogger(__name__)

# Environment detection
IS_PRODUCTION = os.getenv('FLASK_ENV') == 'production'
IS_DEVELOPMENT = os.getenv('FLASK_ENV') == 'development'

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB

# Secure session configuration
app.config.update(
    SECRET_KEY=os.getenv('SECRET_KEY', os.urandom(24)),
    SESSION_COOKIE_SECURE=IS_PRODUCTION,  # HTTPS only in production
    SESSION_COOKIE_HTTPONLY=True,  # Prevent JavaScript access
    SESSION_COOKIE_SAMESITE='Lax',  # CSRF protection
    PERMANENT_SESSION_LIFETIME=timedelta(days=7)
)

logger.info(f"Starting TasteSwipe in {'PRODUCTION' if IS_PRODUCTION else 'DEVELOPMENT'} mode")

# Import Spotify modules
from spotify_auth import init_spotify_routes
from spotify_service import (
    get_recommendations,
    create_daylist_playlist,
    get_user_top_artists
)

# Initialize Spotify OAuth routes
init_spotify_routes(app)

# CORS configuration - Strict in production
if IS_PRODUCTION:
    allowed_origins = os.getenv('ALLOWED_ORIGINS', '').split(',')
    if not allowed_origins or allowed_origins == ['']:
        logger.warning("No ALLOWED_ORIGINS set in production!")
        allowed_origins = []
else:
    allowed_origins = ['http://localhost:8000', 'http://127.0.0.1:8000']

CORS(app, origins=allowed_origins, supports_credentials=True)
logger.info(f"CORS enabled for origins: {allowed_origins}")

# Rate limiting
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per minute"] if IS_DEVELOPMENT else ["100 per minute"],
    storage_uri="memory://"
)

# In-memory session store
sessions = {}

# Security headers middleware
@app.after_request
def set_security_headers(response):
    """Add security headers to all responses"""
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://accounts.spotify.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "connect-src 'self' https://api.spotify.com https://accounts.spotify.com; "
        "font-src 'self' data:; "
        "frame-ancestors 'none';"
    )
    return response

# Error handling
@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors"""
    logger.warning(f"404 error: {request.url}")
    return jsonify({'error': 'Resource not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors"""
    logger.error(f"500 error: {str(error)}", exc_info=True)
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(Exception)
def handle_exception(error):
    """Handle all other exceptions"""
    logger.error(f"Unhandled exception: {str(error)}", exc_info=True)
    return jsonify({'error': 'An unexpected error occurred'}), 500

# Session cleanup settings
SESSION_MAX_AGE = timedelta(hours=1)


# ===========================================================================
# HEALTH & MONITORING ENDPOINTS
# ===========================================================================

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for load balancers and monitoring"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'version': '1.0.0'
    }), 200


@app.route('/ready', methods=['GET'])
def readiness_check():
    """Readiness check - verifies app can handle requests"""
    try:
        # Check if critical services are available
        checks = {
            'sessions': len(sessions) >= 0,  # Session store accessible
            'env_vars': bool(os.getenv('SPOTIFY_CLIENT_ID'))  # Config loaded
        }
        
        if all(checks.values()):
            return jsonify({
                'status': 'ready',
                'checks': checks,
                'timestamp': datetime.utcnow().isoformat()
            }), 200
        else:
            return jsonify({
                'status': 'not_ready',
                'checks': checks,
                'timestamp': datetime.utcnow().isoformat()
            }), 503
    except Exception as e:
        logger.error(f"Readiness check failed: {str(e)}")
        return jsonify({
            'status': 'error',
            'error': str(e)
        }), 503


# ===========================================================================
# SESSION MANAGEMENT
# ===========================================================================

def cleanup_old_sessions():
    """Remove sessions that have been idle longer than SESSION_MAX_AGE."""
    now = datetime.now()
    expired = [
        sid for sid, data in sessions.items()
        if (now - data.get('last_accessed', data.get('created_at', now))).total_seconds() > 3600
    ]
    for sid in expired:
        del sessions[sid]
    if expired:
        logger.info(f"Cleaned up {len(expired)} expired sessions")


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


# ===========================================================================
# SPOTIFY API ENDPOINTS
# ===========================================================================

@app.route('/api/recommendations', methods=['GET'])
@limiter.limit("10 per minute")
def api_get_recommendations():
    """Get 10 personalized song recommendations from Spotify"""
    try:
        tracks = get_recommendations(limit=10)
        
        # Format for frontend
        songs = []
        for track in tracks:
            songs.append({
                'id': track['id'],
                'track': track['name'],
                'artist': ', '.join([artist['name'] for artist in track['artists']]),
                'uri': track['uri'],
                'preview_url': track.get('preview_url'),
                'album_art': track['album']['images'][0]['url'] if track['album'].get('images') else None,
                'genre': []  # Spotify doesn't provide genre per track
            })
        
        return jsonify({'songs': songs})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlist/create', methods=['POST'])
@limiter.limit("5 per hour")
def api_create_playlist():
    """Create a Spotify playlist from liked tracks with AI-generated name"""
    try:
        from ai_service import analyze_music_taste, generate_playlist_name
        
        data = request.json
        liked_tracks = data.get('liked_tracks', [])
        disliked_tracks = data.get('disliked_tracks', [])
        
        if not liked_tracks:
            return jsonify({'error': 'No tracks to add'}), 400
        
        # AI: Analyze taste
        taste_analysis = analyze_music_taste(liked_tracks, disliked_tracks)
        
        # AI: Generate creative playlist name
        ai_playlist_name = generate_playlist_name(liked_tracks, taste_analysis)
        
        # Create playlist with AI name
        from datetime import datetime
        date_str = datetime.now().strftime('%B %d, %Y')
        playlist_description = f"{taste_analysis.get('summary', 'Your daily discoveries')} • {len(liked_tracks)} songs"
        
        # Use spotify_service but override the name
        from spotify_service import create_playlist, add_tracks_to_playlist
        
        playlist = create_playlist(ai_playlist_name, playlist_description, public=False)
        
        # Add tracks
        track_uris = [track['uri'] for track in liked_tracks if track.get('uri')]
        if track_uris:
            add_tracks_to_playlist(playlist['id'], track_uris)
        
        return jsonify({
            'success': True,
            'playlist': {
                'id': playlist['id'],
                'name': playlist['name'],
                'url': playlist['external_urls']['spotify'],
                'track_count': len(track_uris)
            },
            'taste_analysis': taste_analysis
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/taste-analysis', methods=['POST'])
@limiter.limit("20 per minute")
def api_taste_analysis():
    """Get AI analysis of user's music taste"""
    try:
        from ai_service import analyze_music_taste, detect_session_mood
        
        data = request.json
        liked_songs = data.get('liked_songs', [])
        disliked_songs = data.get('disliked_songs', [])
        
        # AI: Analyze taste
        taste_analysis = analyze_music_taste(liked_songs, disliked_songs)
        
        # AI: Detect mood
        mood_analysis = detect_session_mood(liked_songs, disliked_songs)
        
        return jsonify({
            'taste': taste_analysis,
            'mood': mood_analysis
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=os.getenv('FLASK_ENV') == 'development', port=5001)
