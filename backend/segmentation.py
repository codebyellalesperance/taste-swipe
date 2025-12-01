from collections import Counter
from datetime import date, timedelta
from typing import List

from models import ListeningEvent, WeekBucket, Era


def aggregate_by_week(events: List[ListeningEvent]) -> List[WeekBucket]:
    """
    Group listening events by ISO week.

    Args:
        events: List of ListeningEvent objects

    Returns:
        List of WeekBucket objects sorted by week_start
    """
    if not events:
        return []

    # Group events by (year, week)
    weeks_data = {}

    for event in events:
        iso_cal = event.timestamp.isocalendar()
        week_key = (iso_cal[0], iso_cal[1])  # (year, week)

        if week_key not in weeks_data:
            # Calculate Monday of this ISO week
            # ISO week 1 contains Jan 4, and weeks start on Monday
            jan4 = date(iso_cal[0], 1, 4)
            week_start = jan4 - timedelta(days=jan4.weekday()) + timedelta(weeks=iso_cal[1] - 1)

            weeks_data[week_key] = {
                'week_start': week_start,
                'artists': Counter(),
                'tracks': Counter(),
                'total_ms': 0
            }

        weeks_data[week_key]['artists'][event.artist_name] += 1
        weeks_data[week_key]['tracks'][(event.track_name, event.artist_name)] += 1
        weeks_data[week_key]['total_ms'] += event.ms_played

    # Convert to WeekBucket objects
    buckets = [
        WeekBucket(
            week_key=week_key,
            week_start=data['week_start'],
            artists=data['artists'],
            tracks=data['tracks'],
            total_ms=data['total_ms']
        )
        for week_key, data in weeks_data.items()
    ]

    # Sort by week_start
    buckets.sort(key=lambda b: b.week_start)

    return buckets


def calculate_similarity(week_a: WeekBucket, week_b: WeekBucket) -> float:
    """
    Calculate Jaccard similarity between two weeks based on top artists.

    Args:
        week_a: First week bucket
        week_b: Second week bucket

    Returns:
        Float between 0.0 and 1.0 representing similarity
    """
    # Get top N artists from each week
    n = min(20, len(week_a.artists), len(week_b.artists))

    if n == 0:
        return 0.0

    # Extract artist names from top N
    top_a = set(artist for artist, _ in week_a.artists.most_common(n))
    top_b = set(artist for artist, _ in week_b.artists.most_common(n))

    # Calculate Jaccard similarity
    intersection = len(top_a & top_b)
    union = len(top_a | top_b)

    if union == 0:
        return 0.0

    return intersection / union


def detect_era_boundaries(weeks: List[WeekBucket], threshold: float = 0.3) -> List[int]:
    """
    Detect boundaries between eras based on listening pattern changes.

    Args:
        weeks: List of WeekBucket objects sorted by week_start
        threshold: Similarity threshold below which a new era starts (0.0-1.0)
                   Lower = more eras, Higher = fewer eras

    Returns:
        List of week indices where new eras start (always includes 0)
    """
    if not weeks:
        return []

    if len(weeks) == 1:
        return [0]

    boundaries = [0]  # First week is always a boundary

    for i in range(1, len(weeks)):
        # Check for gap in listening (more than 4 weeks)
        gap_days = (weeks[i].week_start - weeks[i - 1].week_start).days
        if gap_days > 28:  # More than 4 weeks gap
            boundaries.append(i)
            continue

        # Check similarity with previous week
        similarity = calculate_similarity(weeks[i - 1], weeks[i])
        if similarity < threshold:
            boundaries.append(i)

    return boundaries


def build_eras(weeks: List[WeekBucket], boundaries: List[int]) -> List[Era]:
    """
    Build Era objects from week buckets and boundaries.

    Args:
        weeks: List of WeekBucket objects sorted by week_start
        boundaries: List of week indices where eras start

    Returns:
        List of Era objects with sequential IDs starting at 1
    """
    if not weeks or not boundaries:
        return []

    eras = []

    for i, start_idx in enumerate(boundaries):
        # Determine end index (exclusive)
        if i + 1 < len(boundaries):
            end_idx = boundaries[i + 1]
        else:
            end_idx = len(weeks)

        # Get weeks for this era
        era_weeks = weeks[start_idx:end_idx]
        if not era_weeks:
            continue

        # Combine artist counts
        combined_artists = sum(
            (week.artists for week in era_weeks),
            Counter()
        )

        # Combine track counts
        combined_tracks = sum(
            (week.tracks for week in era_weeks),
            Counter()
        )

        # Calculate total listening time
        total_ms = sum(week.total_ms for week in era_weeks)

        # Get top 10 artists as List[Tuple[str, int]]
        top_artists = combined_artists.most_common(10)

        # Get top 20 tracks as List[Tuple[str, str, int]]
        # Track keys are (track_name, artist_name), values are counts
        top_tracks = [
            (track_name, artist_name, count)
            for (track_name, artist_name), count in combined_tracks.most_common(20)
        ]

        # Calculate dates
        start_date = era_weeks[0].week_start
        end_date = era_weeks[-1].week_start + timedelta(days=6)

        era = Era(
            id=i + 1,  # 1-indexed
            start_date=start_date,
            end_date=end_date,
            top_artists=top_artists,
            top_tracks=top_tracks,
            total_ms_played=total_ms,
            title="",
            summary=""
        )
        eras.append(era)

    return eras


def filter_eras(eras: List[Era], min_weeks: int = 2, min_ms: int = 3600000) -> List[Era]:
    """
    Filter out insignificant eras and renumber remaining ones.

    Args:
        eras: List of Era objects
        min_weeks: Minimum number of weeks for an era to be kept (default 2)
        min_ms: Minimum total listening time in milliseconds (default 1 hour)

    Returns:
        Filtered list of Era objects with renumbered IDs
    """
    filtered = []

    for era in eras:
        # Calculate weeks in era
        weeks_in_era = ((era.end_date - era.start_date).days // 7) + 1

        # Apply filters
        if weeks_in_era < min_weeks:
            continue
        if era.total_ms_played < min_ms:
            continue

        filtered.append(era)

    # Renumber IDs sequentially
    for i, era in enumerate(filtered):
        era.id = i + 1

    return filtered


def calculate_aggregate_stats(events: List[ListeningEvent]) -> dict:
    """
    Calculate aggregate statistics from listening events.
    Call this before deleting events to preserve stats for API.

    Args:
        events: List of ListeningEvent objects

    Returns:
        Dict with total_tracks, total_artists, total_ms, and date_range
    """
    if not events:
        return {
            "total_tracks": 0,
            "total_artists": 0,
            "total_ms": 0,
            "date_range": {"start": None, "end": None}
        }

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


def segment_listening_history(events: List[ListeningEvent]) -> List[Era]:
    """
    Main entry point for era segmentation.

    Args:
        events: List of ListeningEvent objects

    Returns:
        List of Era objects (may be empty)
    """
    weeks = aggregate_by_week(events)
    boundaries = detect_era_boundaries(weeks)
    eras = build_eras(weeks, boundaries)
    filtered = filter_eras(eras)
    return filtered
