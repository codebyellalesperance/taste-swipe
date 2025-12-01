# Spotify Eras — Step-by-Step Build Guide

## PHASE 0: Project Setup

### Step 0.1 — Initialize Project Structure
Create the following folder structure:
```
spotify-eras/
├── backend/
│   ├── __init__.py
│   ├── app.py
│   ├── requirements.txt
│   ├── parser.py
│   ├── segmentation.py
│   ├── llm_service.py
│   ├── playlist_builder.py
│   └── models.py
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── .env.example
└── README.md
```

### Step 0.2 — Define Python Dependencies
Create `requirements.txt` with:
- flask
- flask-cors
- python-dotenv
- orjson (faster JSON parsing for large Spotify exports)
- gunicorn (production WSGI server)
- openai (or anthropic, depending on LLM choice)

### Step 0.2.1 — Create Environment File Template
Create `.env.example` with:
```
OPENAI_API_KEY=your_api_key_here
# Or if using Anthropic:
# ANTHROPIC_API_KEY=your_api_key_here
FLASK_ENV=development
```

### Step 0.3 — Define Data Models
In `models.py`, create these dataclasses:

```python
from dataclasses import dataclass, field
from datetime import datetime, date
from typing import List, Optional, Tuple

@dataclass
class ListeningEvent:
    timestamp: datetime
    artist_name: str
    track_name: str
    ms_played: int
    spotify_uri: Optional[str] = None

@dataclass
class Era:
    id: int
    start_date: date
    end_date: date
    top_artists: List[Tuple[str, int]]  # (artist_name, play_count)
    top_tracks: List[Tuple[str, str, int]]  # (track_name, artist_name, play_count)
    total_ms_played: int
    title: str = ""
    summary: str = ""

@dataclass
class Playlist:
    era_id: int
    tracks: List[dict]  # {track_name, artist_name, uri}
```

---

## PHASE 1: Backend — File Parsing

### Step 1.1 — Create Basic Flask App
In `app.py`:
- Load environment variables: `from dotenv import load_dotenv; load_dotenv()`
- Initialize Flask app
- Set max upload size: `app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB`
- Enable CORS (restrict origins in production): `CORS(app, origins=os.getenv('ALLOWED_ORIGINS', '*').split(','))`
- Create in-memory session store: `sessions = {}`
- Add session cleanup: store `created_at` timestamp with each session, periodically remove sessions older than 1 hour
- Create route `GET /health` that returns `{"status": "ok"}`

### Step 1.2 — Create Upload Endpoint
Create `POST /upload` endpoint that:
- Accepts multipart form data with file(s)
- Validate file exists in request, return `{"error": "No file provided"}` with 400 status if missing
- Validate file type (check both extension AND magic bytes for ZIP files)
- Only after validation: generate unique session_id (use uuid4)
- Store session object: `sessions[session_id] = {"events": [], "eras": [], "playlists": [], "progress": {"stage": "uploading", "percent": 0}, "created_at": datetime.now()}`
- Returns `{"session_id": session_id}`

### Step 1.3 — Parse Single JSON File
In `parser.py`, create function `parse_spotify_json(file_content: bytes) -> List[ListeningEvent]`:
- Wrap parsing in try/except for `orjson.JSONDecodeError`
- Parse JSON content using `orjson.loads()` for better performance
- Spotify's extended history format has these fields:
  - `ts` (ISO 8601 timestamp string, e.g., `"2023-01-15T14:30:00Z"`)
  - `master_metadata_track_name`
  - `master_metadata_album_artist_name`
  - `ms_played`
  - `spotify_track_uri`
- Filter out entries where `ms_played < 30000` (less than 30 seconds = skip)
- Filter out entries where `master_metadata_track_name` is null
- Filter out entries where `master_metadata_album_artist_name` is null
- Parse timestamp: use `datetime.fromisoformat(ts.replace('Z', '+00:00'))` to handle UTC timezone
- Convert each valid entry to a `ListeningEvent`
- Deduplicate by (timestamp, track_name, artist_name) to handle duplicate entries in exports
- Return list of events

### Step 1.4 — Handle ZIP Upload
Create function `parse_spotify_zip(zip_bytes: bytes) -> List[ListeningEvent]`:
- Use in-memory extraction with `io.BytesIO(zip_bytes)` — do NOT extract to disk
- Validate ZIP file: `zipfile.is_zipfile(bytes_io)`
- Security: validate each filename doesn't contain path traversal (`..` or absolute paths)
- Security: limit total extracted size to prevent zip bombs (e.g., 1GB max)
- Use `fnmatch.fnmatch(name, '*Streaming_History_Audio_*.json')` to find matching files
- Handle nested directories: Spotify sometimes puts files in a subfolder like `my_spotify_data/`
- Call `parse_spotify_json` on each matching file's bytes
- Combine all events into single list
- Sort by timestamp ascending
- Return combined list

### Step 1.5 — Integrate Parsing into Upload
Update `POST /upload` to:
- Detect file type by checking magic bytes: ZIP files start with `PK\x03\x04`
- Also check extension as fallback (`.zip` or `.json`)
- Call appropriate parser, wrapped in try/except
- On parse error: return `{"error": "Failed to parse file: <message>"}` with 400 status
- On success: store parsed events in `sessions[session_id]["events"]`
- Update progress to `{"stage": "parsed", "percent": 20}`
- Process synchronously for MVP (blocking call) — async can be added later with threading or Celery

### Step 1.6 — Create Progress Endpoint
Create `GET /progress/<session_id>` as Server-Sent Events (SSE):
- Return 404 JSON error if session_id not found
- Use `stream_with_context` from Flask for proper generator handling
- Set required headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
- Yield current progress state from `sessions[session_id]["progress"]`
- Format: `data: {"stage": "...", "percent": ...}\n\n`
- Send keepalive comment every 15 seconds: `: keepalive\n\n`
- Poll internal state every 500ms
- Continue until stage is "complete" or "error"
- Set a timeout (e.g., 5 minutes max) to prevent hung connections

---

## PHASE 2: Backend — Era Segmentation

### Step 2.0 — Add WeekBucket to Models
In `models.py`, add the `WeekBucket` dataclass:

```python
from collections import Counter

@dataclass
class WeekBucket:
    week_key: Tuple[int, int]  # (year, week_number) to handle year boundaries
    week_start: date
    artists: Counter  # Counter of artist_name -> play_count
    tracks: Counter   # Counter of (track_name, artist_name) -> play_count
    total_ms: int
```

### Step 2.1 — Create Weekly Aggregates
In `segmentation.py`, create function `aggregate_by_week(events: List[ListeningEvent]) -> List[WeekBucket]`:
- Return empty list if events is empty
- Group events by ISO week using `event.timestamp.isocalendar()` — returns `(year, week, weekday)`
- Use `(year, week)` tuple as week key to handle year boundary edge cases
- Calculate `week_start` as the Monday of that ISO week
- For each week:
  - Count artist plays: `Counter[artist_name] -> int`
  - Count track plays: `Counter[(track_name, artist_name)] -> int` (tuple to preserve artist association)
  - Sum `ms_played` for total_ms
- Return list of WeekBuckets sorted by week_start

### Step 2.2 — Calculate Artist Similarity Between Weeks
Create function `calculate_similarity(week_a: WeekBucket, week_b: WeekBucket) -> float`:
- Get top N artists from each week (N = min(20, number of artists in smaller week))
- Extract just the artist names as sets
- Handle edge case: if union is empty, return 0.0 to avoid division by zero
- Calculate Jaccard similarity: `len(A & B) / len(A | B)`
- Return float between 0.0 and 1.0

### Step 2.3 — Detect Era Boundaries
Create function `detect_era_boundaries(weeks: List[WeekBucket], threshold: float = 0.3) -> List[int]`:
- If weeks is empty, return empty list
- If only 1 week, return `[0]`
- Always include index 0 as first boundary
- Compare each consecutive pair of weeks:
  - Calculate gap: `(weeks[i].week_start - weeks[i-1].week_start).days`
  - If gap > 28 days (4 weeks), mark index i as boundary (listening gap)
  - Else if `calculate_similarity(weeks[i-1], weeks[i]) < threshold`, mark as boundary
- Threshold 0.3 is tunable — lower = more eras, higher = fewer eras
- Return list of week indices where new eras start

### Step 2.4 — Build Era Objects
Create function `build_eras(weeks: List[WeekBucket], boundaries: List[int]) -> List[Era]`:
- If weeks is empty, return empty list
- For each era (from boundary[i] to boundary[i+1], or to end for last era):
  - Combine all weeks' artist Counters using `sum(counters, Counter())`
  - Combine all weeks' track Counters similarly
  - Sum total_ms_played from all weeks
  - Get top 10 artists as `List[Tuple[str, int]]` using `.most_common(10)`
  - Get top 20 tracks as `List[Tuple[str, str, int]]` — unpack the (track, artist) key and add count
  - Set start_date = first week's `week_start`
  - Set end_date = last week's `week_start + timedelta(days=6)` (end of that week)
  - Leave title and summary as empty strings (filled by LLM later)
- Return list of Era objects with sequential IDs starting at 1

### Step 2.5 — Filter Insignificant Eras
Create function `filter_eras(eras: List[Era], min_weeks: int = 2, min_ms: int = 3600000) -> List[Era]`:
- Calculate weeks in era: `((era.end_date - era.start_date).days // 7) + 1`
- Remove eras shorter than min_weeks
- Remove eras with less than min_ms (1 hour = 3600000ms default)
- If all eras filtered out, return empty list (don't error)
- Re-number remaining era IDs sequentially starting at 1
- Return filtered list

### Step 2.6 — Integrate Segmentation into Pipeline
Create function `segment_listening_history(events: List[ListeningEvent]) -> List[Era]`:
- Call aggregate_by_week
- Call detect_era_boundaries
- Call build_eras
- Call filter_eras
- Return final era list (may be empty)

In `app.py`, create a new endpoint `POST /process/<session_id>`:
- Validate session exists, return 404 if not
- Validate session has events, return 400 if not
- Wrap processing in try/except
- Call segment_listening_history with session events
- On error: set progress to `{"stage": "error", "message": str(e), "percent": 0}`
- On success with no eras: set progress to `{"stage": "error", "message": "No distinct eras found", "percent": 0}`
- On success: store eras in session, update progress to `{"stage": "segmented", "percent": 40}`
- Optionally: delete `sessions[session_id]["events"]` after segmentation to free memory
- Return `{"status": "ok"}` or error JSON

---

## PHASE 3: Backend — LLM Naming & Summarization

### Step 3.0 — Update Environment Configuration
Add to `.env.example`:
```
# LLM Configuration
LLM_PROVIDER=openai  # or anthropic
LLM_MODEL=gpt-4o-mini  # or claude-3-haiku-20240307
LLM_TIMEOUT=30  # seconds per request
```

### Step 3.1 — Create LLM Service Setup
In `llm_service.py`:
- Import required libraries: `os`, `time`, `re`, `json`
- Load configuration from environment:
  - `LLM_PROVIDER` (default: "openai")
  - `LLM_MODEL` (default: "gpt-4o-mini" for OpenAI, "claude-3-haiku-20240307" for Anthropic)
  - `LLM_TIMEOUT` (default: 30 seconds)
- Create `get_client()` function that initializes the appropriate client based on provider
- Raise clear error if API key is missing: `raise ValueError("OPENAI_API_KEY not set")`
- Create retry decorator with exponential backoff:
  - Max 3 retries
  - Delays: 1s, 2s, 4s
  - Retry on rate limit errors and transient failures

### Step 3.2 — Create Era Naming Prompt
Create function `build_era_prompt(era: Era) -> str`:
- Format date range as human-readable: "March 2021 - August 2021"
- Calculate and format duration: `(end_date - start_date).days` → "5 months" or "12 weeks"
- Format listening time: `total_ms_played // 3600000` → "47 hours"
- Format top 5 artists with play counts: "1. Taylor Swift (156 plays)"
- Format top 10 tracks: "1. Anti-Hero by Taylor Swift (45 plays)"
- Prompt template:
```
You are analyzing someone's music listening history. Based on this era's data, create a creative title and summary.

Era: {formatted_date_range} ({duration})
Total listening time: {hours} hours

Top Artists:
{formatted_artists}

Top Tracks:
{formatted_tracks}

Create a JSON response with:
- "title": A creative, evocative 2-5 word title that captures the mood/vibe. Avoid generic titles like "Musical Journey", "Eclectic Mix", or "Summer Vibes".
- "summary": A 2-3 sentence summary describing the musical mood, themes, or story of this era.

Respond ONLY with valid JSON: {"title": "...", "summary": "..."}
```

### Step 3.3 — Call LLM for Single Era
Create function `name_era(era: Era) -> dict`:
- Build prompt using `build_era_prompt(era)`
- Call LLM API with:
  - `temperature=0.7`
  - `max_tokens=300`
  - Timeout from `LLM_TIMEOUT` env var
- Parse JSON response with fallback:
  - Try `json.loads(response)` first
  - If fails, try regex: `re.search(r'\{.*\}', response, re.DOTALL)` to extract JSON
  - If still fails, return fallback
- Fallback title format: `"Era {era.id}: {month} {year}"` (e.g., "Era 1: March 2021")
- Fallback summary: `"A {duration} period featuring {top_artist} and more."`
- Return `{"title": str, "summary": str}`

### Step 3.4 — Validate LLM Response
Create function `validate_era_name(response: dict, era: Era) -> dict`:
- Check "title" key exists and is non-empty string
- Check "summary" key exists and is non-empty string
- Clean title:
  - Strip leading/trailing whitespace and quotes
  - Remove newlines
  - Truncate to 50 chars if longer
  - If empty after cleaning, use fallback
- Clean summary:
  - Strip leading/trailing whitespace and quotes
  - Collapse multiple spaces/newlines to single space
  - Truncate to 500 chars if longer
  - If < 20 chars after cleaning, use fallback
- Return cleaned `{"title": str, "summary": str}` or fallback values

### Step 3.5 — Process All Eras
Create function `name_all_eras(eras: List[Era], progress_callback: Callable[[int], None]) -> List[Era]`:
- `progress_callback` signature: takes single int (percent 0-100), returns None
- For each era (index i):
  - Try to call `name_era(era)`
  - Validate with `validate_era_name(response, era)`
  - Update `era.title` and `era.summary`
  - Calculate progress: `40 + int((i + 1) / len(eras) * 30)` (40% to 70%)
  - Call `progress_callback(progress_percent)`
  - On exception: log error, use fallback, continue to next era
- Return updated eras list (all eras will have titles, either from LLM or fallback)

### Step 3.6 — Integrate LLM into Pipeline
Extend the `/process/<session_id>` endpoint in `app.py`:
- After segmentation succeeds (eras stored, progress at 40%):
- Create progress callback that updates `session["progress"]["percent"]`
- Call `name_all_eras(eras, progress_callback)`
- Update session with named eras
- Update progress to `{"stage": "named", "percent": 70}`
- Continue to next phase (playlist generation)

---

## PHASE 4: Backend — Playlist Generation

Note: URIs are not available in Era.top_tracks (lost during aggregation). Playlists will contain track/artist names only. Future Spotify API integration would need to search for tracks by name.

### Step 4.1 — Create Playlist Builder Module
Create `playlist_builder.py` with imports:
```python
from typing import List
from models import Era, Playlist
```

### Step 4.2 — Build Playlist Function
Create function `build_playlist(era: Era) -> Playlist`:
- Extract tracks from era.top_tracks (already limited to 20 in segmentation)
- Format each track as dict: `{"track_name": name, "artist_name": artist, "play_count": count}`
- Note: URI is None since it's not preserved through aggregation
- Create and return Playlist object with era_id and track list

```python
def build_playlist(era: Era) -> Playlist:
    tracks = [
        {
            "track_name": track_name,
            "artist_name": artist_name,
            "play_count": count,
            "uri": None  # Not available after aggregation
        }
        for track_name, artist_name, count in era.top_tracks
    ]
    return Playlist(era_id=era.id, tracks=tracks)
```

### Step 4.3 — Build All Playlists
Create function `build_all_playlists(eras: List[Era]) -> List[Playlist]`:
- Iterate through eras and call build_playlist for each
- Return list of Playlist objects

```python
def build_all_playlists(eras: List[Era]) -> List[Playlist]:
    return [build_playlist(era) for era in eras]
```

### Step 4.4 — Integrate Playlists into Pipeline
Update `/process/<session_id>` in `app.py`:
- Import `build_all_playlists` from `playlist_builder`
- After LLM naming completes (progress at 70%):
- Update progress to `{"stage": "playlists", "percent": 80}`
- Call `build_all_playlists(eras)`
- Store playlists in session: `session["playlists"] = playlists`
- Update progress to `{"stage": "complete", "percent": 100}`
- Wrap in try/except - on failure, still mark complete but with empty playlists

---

## PHASE 5: Backend — API Endpoints

### Step 5.0 — Store Aggregate Stats Before Deleting Events
Before deleting events in Step 2.6, calculate and store aggregate statistics that will be needed by the API:

In `segmentation.py`, create function `calculate_aggregate_stats(events: List[ListeningEvent]) -> dict`:
```python
def calculate_aggregate_stats(events: List[ListeningEvent]) -> dict:
    unique_tracks = set((e.track_name, e.artist_name) for e in events)
    unique_artists = set(e.artist_name for e in events)
    return {
        "total_tracks": len(unique_tracks),
        "total_artists": len(unique_artists),
        "total_ms": sum(e.ms_played for e in events),
        "date_range": {
            "start": min(e.timestamp for e in events).date().isoformat(),
            "end": max(e.timestamp for e in events).date().isoformat()
        }
    }
```

Update `/process/<session_id>` to call this before segmentation and store in `session["stats"]`.

### Step 5.1 — Create Session Validation Helper
Create helper function to validate session state before returning data:

```python
def validate_session_ready(session_id: str) -> Tuple[dict, Optional[Tuple[dict, int]]]:
    """Returns (session, None) if valid, or (None, error_response) if invalid."""
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
```

### Step 5.2 — Create Serialization Helpers
Create functions to convert dataclasses to JSON-serializable dicts:

```python
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
```

### Step 5.3 — Create Summary Endpoint
Create `GET /session/<session_id>/summary`:
- Call `validate_session_ready()`, return error if invalid
- Return JSON with data from `session["stats"]` and eras:

```python
@app.route('/session/<session_id>/summary')
def get_summary(session_id):
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
```

### Step 5.4 — Create Eras List Endpoint
Create `GET /session/<session_id>/eras`:
- Call `validate_session_ready()`, return error if invalid
- Return JSON array of era summaries sorted by start_date:

```python
@app.route('/session/<session_id>/eras')
def get_eras(session_id):
    session, error = validate_session_ready(session_id)
    if error:
        return jsonify(error[0]), error[1]

    eras = sorted(session["eras"], key=lambda e: e.start_date)
    return jsonify([serialize_era_summary(era) for era in eras])
```

### Step 5.5 — Create Era Detail Endpoint
Create `GET /session/<session_id>/eras/<era_id>`:
- Call `validate_session_ready()`, return error if invalid
- Validate `era_id` is an integer, return 400 if not
- Find era by ID, return 404 if not found
- Find associated playlist by `era_id`
- Return full serialized era with playlist:

```python
@app.route('/session/<session_id>/eras/<era_id>')
def get_era_detail(session_id, era_id):
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
```

### Step 5.6 — Update Session Cleanup for Activity-Based TTL
Update the session cleanup logic from Step 1.1 to use last access time instead of creation time:

```python
# In session creation (Step 1.2), store both timestamps:
sessions[session_id] = {
    "events": [],
    "eras": [],
    "playlists": [],
    "stats": {},
    "progress": {"stage": "uploading", "percent": 0},
    "created_at": datetime.now(),
    "last_accessed": datetime.now()
}

# In cleanup, check last_accessed instead of created_at:
def cleanup_expired_sessions():
    now = datetime.now()
    expired = [
        sid for sid, session in sessions.items()
        if (now - session["last_accessed"]).total_seconds() > 3600  # 1 hour idle
    ]
    for sid in expired:
        del sessions[sid]
```

### Step 5.7 — Add Rate Limiting (Production)
Install `flask-limiter` and add rate limiting to prevent abuse:

```python
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["100 per minute"]
)

# Apply stricter limits to expensive endpoints
@app.route('/process/<session_id>', methods=['POST'])
@limiter.limit("5 per minute")
def process_session(session_id):
    ...
```

Add `flask-limiter` to `requirements.txt`.

### Step 5.8 — Error Response Consistency
All error responses must follow this format:
```json
{
    "error": "Human-readable error message"
}
```

HTTP status codes:
- `400` — Bad request (invalid input, invalid era_id format)
- `404` — Not found (session or era doesn't exist)
- `425` — Too Early (processing not complete)
- `429` — Too Many Requests (rate limited)
- `500` — Internal Server Error (unexpected failures)

---

## PHASE 6: Frontend — Landing Page

### Step 6.1 — Create HTML Structure
In `index.html`:
- Title: "Spotify Eras"
- Subtitle: "Discover your personal music timeline"
- File upload area (drag-and-drop + click)
- Brief instructions on getting Spotify data export
- Privacy note: "Your data is processed in-memory and never stored"
- Footer with credits

### Step 6.2 — Style Landing Page
In `styles.css`:
- Dark theme (similar to Spotify aesthetic)
- Colors: background #121212, accent #1DB954 (Spotify green), text #FFFFFF
- Centered layout, max-width 600px
- Upload area: dashed border, hover state
- Clean, minimal typography (system fonts or Inter)

### Step 6.3 — Implement File Upload Handler
In `app.js`:
- Add drag-and-drop listeners to upload area
- Add click-to-upload fallback
- Accept .json and .zip files only
- On file select: show file name, enable "Analyze" button
- On submit: POST to /upload endpoint

---

## PHASE 7: Frontend — Processing Screen

### Step 7.1 — Create Processing View HTML
Add processing section to HTML (hidden by default):
- Progress bar (0-100%)
- Stage indicator text
- Animated loading indicator
- Cancel button (optional for v1)

### Step 7.2 — Define Progress Stages Display
Map backend stages to user-friendly text:
- "uploading" → "Uploading your data..."
- "parsed" → "Reading your listening history..."
- "segmented" → "Detecting your music eras..."
- "naming" → "Generating era descriptions..."
- "complete" → "Done! Loading your timeline..."

### Step 7.3 — Implement SSE Progress Listener
In `app.js`:
- After upload response, connect to `/progress/<session_id>` SSE
- On each message: update progress bar and stage text
- On "complete": redirect to timeline view
- On "error": show error message with retry option

---

## PHASE 8: Frontend — Timeline View

### Step 8.1 — Create Timeline HTML Structure
Add timeline section:
- Header with summary stats
- Vertical timeline container
- Era cards arranged chronologically

### Step 8.2 — Design Era Card Component
Each era card shows:
- Title (large, bold)
- Date range (e.g., "Mar 2021 - Aug 2021")
- Top 3 artists as pills/tags
- Track count
- Click target (entire card)

### Step 8.3 — Style Timeline
CSS for timeline:
- Vertical line connecting eras (left side)
- Era cards offset to right of line
- Alternating subtle background shades (optional)
- Smooth scroll
- Cards have hover state

### Step 8.4 — Implement Timeline Data Loading
In `app.js`:
- On timeline view load: GET `/session/<id>/eras`
- Render era cards from response
- Add click handlers to each card

### Step 8.5 — Add Timeline Header Stats
Fetch and display:
- Total listening time (format as hours)
- Number of eras
- Date range of history
- "Your music journey" as header

---

## PHASE 9: Frontend — Era Detail View

### Step 9.1 — Create Era Detail HTML Structure
Add era detail section (modal or separate view):
- Back button
- Era title (large)
- Era date range
- Summary paragraph
- Stats section (total time, track count)
- Top artists list
- Playlist/track list

### Step 9.2 — Design Track List Component
Track list shows:
- Track number
- Track name
- Artist name
- Optional: Spotify link icon (if URI available)

### Step 9.3 — Add Copy Playlist Feature
- "Copy Track List" button
- On click: format tracks as "Artist - Track" list
- Copy to clipboard
- Show toast: "Copied to clipboard!"

### Step 9.4 — Implement Era Detail Loading
In `app.js`:
- On era card click: GET `/session/<id>/eras/<era_id>`
- Render era detail view with full data
- Handle back button navigation

---

## PHASE 10: Shareable Cards

### Step 10.1 — Design Share Card Layout
Create a visually distinct "card" view of each era:
- Fixed dimensions (1080x1080 or 1200x630)
- Era title prominently displayed
- Date range
- Top 5 artists
- Spotify Eras branding/watermark
- Visually appealing background

### Step 10.2 — Add Screenshot Hint
- Add "📸 Screenshot to share!" text below card
- Or add "Share" button that highlights the card area

### Step 10.3 — (Optional) Generate Image
If time permits:
- Use html2canvas library
- "Download as Image" button
- Generate PNG of era card

---

## PHASE 11: Polish & Error Handling

### Step 11.1 — Add Loading States
- Skeleton loaders for timeline
- Spinner for era detail load
- Disabled states for buttons during actions

### Step 11.2 — Add Error States
- Upload error: "Could not read file. Please try again."
- Processing error: "Something went wrong. Please try again."
- Empty data: "No listening history found in this file."
- Network error: "Connection lost. Please check your internet."

### Step 11.3 — Add Empty States
- No eras detected: "We couldn't detect distinct eras in your history. Try uploading more data."

### Step 11.4 — Mobile Responsiveness
- Test at 375px width
- Stack elements vertically
- Adjust font sizes
- Ensure tap targets are 44px+

### Step 11.5 — Add Privacy Note
- On landing: "Your data is processed temporarily and never stored permanently."
- Link to brief privacy explanation (optional)

---

## PHASE 12: Testing & Validation

### Step 12.1 — Test with Sample Data
- Create mock Spotify export JSON
- Test parsing with edge cases:
  - Missing fields
  - Null track names
  - Very short plays
  - Unicode characters in artist/track names

### Step 12.2 — Test Era Detection
- Verify reasonable era boundaries
- Test with sparse data (gaps in listening)
- Test with very consistent listening (should still segment)

### Step 12.3 — Test LLM Integration
- Verify titles are creative, not generic
- Verify summaries make sense given artists
- Test fallback when LLM fails

### Step 12.4 — End-to-End Test
- Upload real Spotify data
- Verify full flow works
- Time the total processing (target: <90 seconds)

---

## Summary Checklist

- [ ] Phase 0: Project structure created
- [ ] Phase 1: File parsing works for JSON and ZIP
- [ ] Phase 2: Era segmentation produces reasonable results
- [ ] Phase 3: LLM generates creative names and summaries
- [ ] Phase 4: Playlists generated for each era
- [ ] Phase 5: All API endpoints functional
- [ ] Phase 6: Landing page with upload working
- [ ] Phase 7: Processing screen shows real progress
- [ ] Phase 8: Timeline displays all eras
- [ ] Phase 9: Era detail view shows full info
- [ ] Phase 10: Shareable cards look good
- [ ] Phase 11: Error handling complete
- [ ] Phase 12: Tested with real data
