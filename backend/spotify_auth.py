"""
Spotify OAuth 2.0 Authentication
Handles login, callback, and token management
"""

import os
import base64
import secrets
import requests
from urllib.parse import urlencode
from flask import redirect, request, jsonify, session
from dotenv import load_dotenv

load_dotenv()

# Spotify OAuth Configuration
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET')
SPOTIFY_REDIRECT_URI = os.getenv('SPOTIFY_REDIRECT_URI')

SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize'
SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'
SPOTIFY_API_BASE = 'https://api.spotify.com/v1'

# Required scopes for TasteSwipe
SCOPES = [
    'user-top-read',           # Read user's top artists/tracks
    'user-read-private',       # Read user profile
    'playlist-modify-public',  # Create/modify public playlists
    'playlist-modify-private'  # Create/modify private playlists
]


def get_auth_url():
    """Generate Spotify authorization URL"""
    state = secrets.token_urlsafe(16)
    
    params = {
        'client_id': SPOTIFY_CLIENT_ID,
        'response_type': 'code',
        'redirect_uri': SPOTIFY_REDIRECT_URI,
        'scope': ' '.join(SCOPES),
        'state': state,
        'show_dialog': False
    }
    
    auth_url = f"{SPOTIFY_AUTH_URL}?{urlencode(params)}"
    return auth_url, state


def exchange_code_for_token(code):
    """Exchange authorization code for access token"""
    auth_header = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()
    
    headers = {
        'Authorization': f'Basic {auth_header}',
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': SPOTIFY_REDIRECT_URI
    }
    
    response = requests.post(SPOTIFY_TOKEN_URL, headers=headers, data=data)
    
    if response.status_code != 200:
        raise Exception(f"Token exchange failed: {response.text}")
    
    return response.json()


def refresh_access_token(refresh_token):
    """Request a new access token using refresh token"""
    auth_header = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()
    
    headers = {
        'Authorization': f'Basic {auth_header}',
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    
    data = {
        'grant_type': 'refresh_token',
        'refresh_token': refresh_token
    }
    
    response = requests.post(SPOTIFY_TOKEN_URL, headers=headers, data=data)
    
    if response.status_code != 200:
        raise Exception(f"Token refresh failed: {response.text}")
    
    return response.json()


def get_user_profile(access_token):
    """Get current user's profile"""
    headers = {'Authorization': f'Bearer {access_token}'}
    response = requests.get(f"{SPOTIFY_API_BASE}/me", headers=headers)
    
    if response.status_code != 200:
        raise Exception(f"Failed to get user profile: {response.text}")
    
    return response.json()


# Flask route handlers (to be imported in app.py)

def init_spotify_routes(app):
    """Initialize Spotify OAuth routes"""
    
    @app.route('/auth/login')
    def spotify_login():
        """Initiate Spotify OAuth flow"""
        auth_url, state = get_auth_url()
        session['oauth_state'] = state
        return redirect(auth_url)
    
    @app.route('/auth/callback')
    def spotify_callback():
        """Handle Spotify OAuth callback"""
        # Verify state to prevent CSRF
        state = request.args.get('state')
        if state != session.get('oauth_state'):
            return jsonify({'error': 'Invalid state parameter'}), 400
        
        # Check for errors
        error = request.args.get('error')
        if error:
            return redirect(f'/?error={error}')
        
        # Exchange code for token
        code = request.args.get('code')
        try:
            token_data = exchange_code_for_token(code)
            
            # Store tokens in session
            session['access_token'] = token_data['access_token']
            session['refresh_token'] = token_data['refresh_token']
            session['token_expires_at'] = token_data['expires_in']
            
            # Get user profile
            user_profile = get_user_profile(token_data['access_token'])
            session['user_id'] = user_profile['id']
            session['display_name'] = user_profile.get('display_name', 'User')
            
            # Redirect back to frontend (not backend!)
            frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:8000')
            return redirect(f'{frontend_url}/?logged_in=true')
            
        except Exception as e:
            frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:8000')
            return redirect(f'{frontend_url}/?error=auth_failed&message={str(e)}')
    
    @app.route('/auth/me')
    def get_current_user():
        """Get current authenticated user"""
        access_token = session.get('access_token')
        if not access_token:
            return jsonify({'logged_in': False}), 401
        
        try:
            profile = get_user_profile(access_token)
            return jsonify({
                'logged_in': True,
                'user': {
                    'id': profile['id'],
                    'display_name': profile.get('display_name'),
                    'email': profile.get('email'),
                    'image': profile.get('images', [{}])[0].get('url') if profile.get('images') else None
                }
            })
        except Exception as e:
            return jsonify({'error': str(e)}), 401
    
    @app.route('/auth/logout')
    def logout():
        """Clear session and logout"""
        session.clear()
        frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:8000')
        return redirect(frontend_url)
