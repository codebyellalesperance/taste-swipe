from typing import List

from models import Era, Playlist


def build_playlist(era: Era) -> Playlist:
    """
    Build a playlist from an era's top tracks.

    Args:
        era: Era object with top_tracks data

    Returns:
        Playlist object with formatted track list
    """
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


def build_all_playlists(eras: List[Era]) -> List[Playlist]:
    """
    Build playlists for all eras.

    Args:
        eras: List of Era objects

    Returns:
        List of Playlist objects, one per era
    """
    return [build_playlist(era) for era in eras]
