import fnmatch
import io
import os
import zipfile
from datetime import datetime
from typing import List

import orjson

from models import ListeningEvent


# Security limits
MAX_EXTRACTED_SIZE = 1024 * 1024 * 1024  # 1GB max total extracted size
STREAMING_HISTORY_PATTERN = '*Streaming_History_Audio_*.json'


class ParseError(Exception):
    """Raised when parsing fails."""
    pass


def parse_spotify_json(file_content: bytes) -> List[ListeningEvent]:
    """
    Parse a single Spotify extended streaming history JSON file.

    Args:
        file_content: Raw bytes of the JSON file

    Returns:
        List of ListeningEvent objects

    Raises:
        ParseError: If JSON is malformed or data is invalid
    """
    try:
        data = orjson.loads(file_content)
    except orjson.JSONDecodeError as e:
        raise ParseError(f"Invalid JSON: {e}")

    if not isinstance(data, list):
        raise ParseError("Expected JSON array of listening events")

    events = []
    seen = set()  # For deduplication

    for entry in data:
        # Skip entries with missing required fields
        track_name = entry.get('master_metadata_track_name')
        artist_name = entry.get('master_metadata_album_artist_name')
        ms_played = entry.get('ms_played', 0)
        ts = entry.get('ts')

        # Filter out invalid entries
        if track_name is None or artist_name is None:
            continue
        if ms_played < 30000:  # Less than 30 seconds
            continue
        if ts is None:
            continue

        # Parse timestamp (Spotify uses ISO 8601 with Z suffix)
        try:
            timestamp = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            continue  # Skip entries with invalid timestamps

        # Deduplicate by (timestamp, track, artist)
        dedup_key = (ts, track_name, artist_name)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        event = ListeningEvent(
            timestamp=timestamp,
            artist_name=artist_name,
            track_name=track_name,
            ms_played=ms_played,
            spotify_uri=entry.get('spotify_track_uri')
        )
        events.append(event)

    return events


def parse_spotify_zip(zip_bytes: bytes) -> List[ListeningEvent]:
    """
    Parse a Spotify data export ZIP file.

    Args:
        zip_bytes: Raw bytes of the ZIP file

    Returns:
        List of ListeningEvent objects, sorted by timestamp

    Raises:
        ParseError: If ZIP is invalid or contains security issues
    """
    bytes_io = io.BytesIO(zip_bytes)

    if not zipfile.is_zipfile(bytes_io):
        raise ParseError("Invalid ZIP file")

    all_events = []
    total_extracted = 0

    with zipfile.ZipFile(bytes_io, 'r') as zf:
        for info in zf.infolist():
            # Security: skip directories
            if info.is_dir():
                continue

            # Security: check for path traversal
            filename = info.filename
            if '..' in filename or filename.startswith('/'):
                raise ParseError(f"Invalid file path in ZIP: {filename}")

            # Security: check extracted size limit
            total_extracted += info.file_size
            if total_extracted > MAX_EXTRACTED_SIZE:
                raise ParseError("ZIP file too large when extracted")

            # Check if file matches streaming history pattern
            # Handle nested directories by checking just the basename
            basename = os.path.basename(filename)
            if not fnmatch.fnmatch(basename, STREAMING_HISTORY_PATTERN):
                continue

            # Extract and parse the JSON file
            try:
                file_content = zf.read(info.filename)
                events = parse_spotify_json(file_content)
                all_events.extend(events)
            except ParseError:
                # Skip files that fail to parse, continue with others
                continue

    if not all_events:
        raise ParseError("No valid streaming history files found in ZIP")

    # Sort by timestamp ascending
    all_events.sort(key=lambda e: e.timestamp)

    return all_events
