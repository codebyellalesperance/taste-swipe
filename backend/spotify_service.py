"""
Spotify API Service
Handles recommendations, playlists, and user data
"""

import requests
from flask import session
from backend.spotify_auth import get_valid_token

SPOTIFY_API_BASE = 'https://api.spotify.com/v1'


def get_spotify_headers():
    """Get auth headers with access token"""
    access_token = get_valid_token()
    if not access_token:
        raise Exception('Not authenticated')
    
    return {'Authorization': f'Bearer {access_token}'}


def get_user_top_artists(limit=5, time_range='medium_term'):
    """
    Get user's top artists
    time_range: short_term (4 weeks), medium_term (6 months), long_term (years)
    """
    headers = get_spotify_headers()
    params = {'limit': limit, 'time_range': time_range}
    
    response = requests.get(
        f"{SPOTIFY_API_BASE}/me/top/artists",
        headers=headers,
        params=params
    )
    
    if response.status_code != 200:
        raise Exception(f"Failed to get top artists: {response.text}")
    
    return response.json()['items']


def get_user_top_tracks(limit=5, time_range='medium_term'):
    """Get user's top tracks"""
    headers = get_spotify_headers()
    params = {'limit': limit, 'time_range': time_range}
    
    response = requests.get(
        f"{SPOTIFY_API_BASE}/me/top/tracks",
        headers=headers,
        params=params
    )
    
    if response.status_code != 200:
        raise Exception(f"Failed to get top tracks: {response.text}")
    
    return response.json()['items']


def get_recommendations(seed_artists=None, seed_tracks=None, limit=10):
    """
    Get track recommendations based on seeds
    """
    headers = get_spotify_headers()
    
    # If no seeds provided, use user's top artists/tracks
    if not seed_artists and not seed_tracks:
        try:
            top_artists = get_user_top_artists(limit=3)
            top_tracks = get_user_top_tracks(limit=2)
            
            seed_artists = [artist['id'] for artist in top_artists]
            seed_tracks = [track['id'] for track in top_tracks]
        except:
            # Fallback to popular seed if user has no history
            seed_artists = ['06HL4z0CvFAxyc27GXpf02']  # Taylor Swift as fallback
    
    params = {
        'limit': limit,
        'seed_artists': ','.join(seed_artists[:5]) if seed_artists else None,
        'seed_tracks': ','.join(seed_tracks[:5]) if seed_tracks else None
    }
    
    # Remove None values
    params = {k: v for k, v in params.items() if v is not None}
    
    response = requests.get(
        f"{SPOTIFY_API_BASE}/recommendations",
        headers=headers,
        params=params
    )
    
    if response.status_code != 200:
        raise Exception(f"Failed to get recommendations: {response.text}")
    
    return response.json()['tracks']


def create_playlist(name, description, public=True):
    """Create a new playlist for the user"""
    headers = get_spotify_headers()
    headers['Content-Type'] = 'application/json'
    
    user_id = session.get('user_id')
    if not user_id:
        raise Exception('User ID not found')
    
    data = {
        'name': name,
        'description': description,
        'public': public
    }
    
    response = requests.post(
        f"{SPOTIFY_API_BASE}/users/{user_id}/playlists",
        headers=headers,
        json=data
    )
    
    if response.status_code not in [200, 201]:
        raise Exception(f"Failed to create playlist: {response.text}")
    
    return response.json()


def add_tracks_to_playlist(playlist_id, track_uris):
    """Add tracks to a playlist"""
    headers = get_spotify_headers()
    headers['Content-Type'] = 'application/json'
    
    data = {'uris': track_uris}
    
    response = requests.post(
        f"{SPOTIFY_API_BASE}/playlists/{playlist_id}/tracks",
        headers=headers,
        json=data
    )
    
    if response.status_code not in [200, 201]:
        raise Exception(f"Failed to add tracks: {response.text}")
    
    return response.json()


def create_daylist_playlist(liked_tracks):
    """
    Create a TasteSwipe daylist playlist from liked tracks
    """
    from datetime import datetime
    
    # Generate playlist name with date
    date_str = datetime.now().strftime('%B %d, %Y')
    playlist_name = f"TasteSwipe Daylist - {date_str}"
    playlist_description = f"My daily music discoveries from TasteSwipe • {len(liked_tracks)} songs I loved"
    
    # Create playlist
    playlist = create_playlist(playlist_name, playlist_description, public=False)
    
    # Add tracks
    track_uris = [track['uri'] for track in liked_tracks if track.get('uri')]
    if track_uris:
        add_tracks_to_playlist(playlist['id'], track_uris)
    
    return {
        'id': playlist['id'],
        'name': playlist['name'],
        'url': playlist['external_urls']['spotify'],
        'track_count': len(track_uris)
    }
