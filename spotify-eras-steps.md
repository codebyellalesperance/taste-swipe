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

### Step 3.1 — Create LLM Service Setup
In `llm_service.py`:
- Load API key from environment variable
- Create function to initialize client

### Step 3.2 — Create Era Naming Prompt
Create function `build_era_prompt(era: Era) -> str`:
- Include: date range, duration, top 5 artists with play counts, top 10 tracks
- Prompt should ask for:
  - A creative 2-5 word title (evocative, not generic)
  - A 2-3 sentence summary describing the vibe/mood
- Specify JSON output format: `{"title": "...", "summary": "..."}`
- Include instruction: "Do not use generic titles like 'Musical Journey' or 'Eclectic Mix'"

### Step 3.3 — Call LLM for Single Era
Create function `name_era(era: Era) -> dict`:
- Build prompt using build_era_prompt
- Call LLM API with temperature ~0.7
- Parse JSON response
- Return `{"title": str, "summary": str}`
- Handle errors gracefully — return fallback title if API fails

### Step 3.4 — Validate LLM Response
Create function `validate_era_name(response: dict) -> dict`:
- Check title length (2-50 chars)
- Check summary length (20-500 chars)
- Strip any quotes or special formatting
- Return cleaned response or fallback

### Step 3.5 — Process All Eras
Create function `name_all_eras(eras: List[Era], progress_callback) -> List[Era]`:
- For each era:
  - Call name_era
  - Validate response
  - Update era.title and era.summary
  - Call progress_callback with percent complete
- Return updated eras list

### Step 3.6 — Integrate LLM into Pipeline
Update main processing:
- After segmentation, call name_all_eras
- Update progress incrementally from 40% to 70%
- Store updated eras in session

---

## PHASE 4: Backend — Playlist Generation

### Step 4.1 — Select Playlist Tracks
In `playlist_builder.py`, create function `build_playlist(era: Era, target_count: int = 40) -> Playlist`:
- Start with era's top_tracks
- If fewer than target_count, that's okay
- Cap at 50 tracks maximum
- Create Playlist object with track list

### Step 4.2 — Format Track Objects
Create function `format_track(track_name: str, artist_name: str, uri: Optional[str]) -> dict`:
- Return `{"track_name": track_name, "artist_name": artist_name, "uri": uri}`

### Step 4.3 — Build All Playlists
Create function `build_all_playlists(eras: List[Era]) -> List[Playlist]`:
- For each era, call build_playlist
- Return list of Playlist objects

### Step 4.4 — Integrate Playlists into Pipeline
Update main processing:
- After LLM naming, call build_all_playlists
- Store playlists in session
- Update progress to `{"stage": "complete", "percent": 100}`

---

## PHASE 5: Backend — API Endpoints

### Step 5.1 — Create Summary Endpoint
Create `GET /session/<session_id>/summary`:
- Return JSON with:
  - total_eras: count
  - date_range: {start, end}
  - total_listening_time_ms
  - total_tracks
  - total_artists

### Step 5.2 — Create Eras List Endpoint
Create `GET /session/<session_id>/eras`:
- Return JSON array of era summaries:
  - id, title, start_date, end_date, top_artists (top 3 only), track_count

### Step 5.3 — Create Era Detail Endpoint
Create `GET /session/<session_id>/eras/<era_id>`:
- Return full Era object as JSON
- Include associated playlist

### Step 5.4 — Add Error Handling
For all endpoints:
- Return 404 if session_id not found
- Return 404 if era_id not found
- Return appropriate error messages as JSON

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
