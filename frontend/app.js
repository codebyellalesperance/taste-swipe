// ===========================================================================
// TASTESWIPE - Music Discovery App
// Tinder-style swipe interface for daily music discovery
// ===========================================================================

// Sample song database (will be replaced with Spotify API later)
const SAMPLE_SONGS = [
    { id: 1, track: "Anti-Hero", artist: "Taylor Swift", genre: ["Pop"] },
    { id: 2, track: "Blinding Lights", artist: "The Weeknd", genre: ["Pop", "Synth"] },
    { id: 3, track: "As It Was", artist: "Harry Styles", genre: ["Pop Rock"] },
    { id: 4, track: "Heat Waves", artist: "Glass Animals", genre: ["Indie"] },
    { id: 5, track: "Levitating", artist: "Dua Lipa", genre: ["Pop", "Disco"] },
    { id: 6, track: "good 4 u", artist: "Olivia Rodrigo", genre: ["Pop Punk"] },
    { id: 7, track: "Stay", artist: "The Kid LAROI, Justin Bieber", genre: ["Pop"] },
    { id: 8, track: "Montero", artist: "Lil Nas X", genre: ["Hip Hop"] },
    { id: 9, track: "Peaches", artist: "Justin Bieber", genre: ["R&B"] },
    { id: 10, track: "drivers license", artist: "Olivia Rodrigo", genre: ["Pop"] }
];

// Application state
const state = {
    currentView: 'landing',
    currentSongIndex: 0,
    swipeCount: 0,
    maxSwipes: 10,
    likedSongs: [],
    dislikedSongs: [],
    streak: 1,
    dailySongs: [],
    isLoggedIn: false,
    user: null,
    // Phase 4: Polish
    lastSessionDate: null,
    totalSessions: 0,
    totalLikes: 0,
    allTimeLikedSongs: [],
    showOnboarding: false
};

// ===========================================================================
// UTILITY FUNCTIONS
// ===========================================================================

function showView(viewName) {
    console.log('Showing view:', viewName);

    const oldView = document.querySelector('.view:not(.hidden)');
    const newView = document.getElementById(`${viewName}-view`);

    if (!newView) {
        console.error(`View not found: ${viewName}-view`);
        return;
    }

    console.log('New view found:', newView);

    if (oldView) {
        oldView.classList.add('view-exit');
        setTimeout(() => {
            oldView.classList.add('hidden');
            oldView.classList.remove('view-exit');
        }, 300);
    }

    newView.classList.remove('hidden');
    newView.classList.add('view-enter');

    setTimeout(() => {
        newView.classList.remove('view-enter');
    }, 50);

    state.currentView = viewName;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    console.log('View transition complete');
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// ===========================================================================
// PHASE 4: PERSISTENCE & STATS
// ===========================================================================

function loadUserData() {
    /**Load persisted user data from localStorage*/
    try {
        const saved = localStorage.getItem('tasteswipe_data');
        if (saved) {
            const data = JSON.parse(saved);
            state.streak = data.streak || 1;
            state.lastSessionDate = data.lastSessionDate;
            state.totalSessions = data.totalSessions || 0;
            state.totalLikes = data.totalLikes || 0;
            state.allTimeLikedSongs = data.allTimeLikedSongs || [];
            state.showOnboarding = data.showOnboarding !== false; // Default true for new users

            // Check if streak should reset  
            if (state.lastSessionDate) {
                const lastDate = new Date(state.lastSessionDate);
                const today = new Date();
                const daysDiff = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));

                if (daysDiff > 1) {
                    // Streak broken
                    state.streak = 1;
                } else if (daysDiff === 1) {
                    // Continue streak (don't increment yet, wait for session completion)
                }
            }
        }
    } catch (error) {
        console.error('Failed to load user data:', error);
    }
}

function saveUserData() {
    /**Persist user data to localStorage*/
    try {
        const data = {
            streak: state.streak,
            lastSessionDate: state.lastSessionDate,
            totalSessions: state.totalSessions,
            totalLikes: state.totalLikes,
            allTimeLikedSongs: state.allTimeLikedSongs,
            showOnboarding: state.showOnboarding
        };
        localStorage.setItem('tasteswipe_data', JSON.stringify(data));
    } catch (error) {
        console.error('Failed to save user data:', error);
    }
}

function completeSession() {
    /**Mark session as complete and update stats*/
    const today = new Date().toDateString();

    // Update session count
    state.totalSessions++;
    state.totalLikes += state.likedSongs.length;

    // Add to all-time likes
    state.likedSongs.forEach(song => {
        if (!state.allTimeLikedSongs.find(s => s.id === song.id)) {
            state.allTimeLikedSongs.push(song);
        }
    });

    // Update streak
    if (state.lastSessionDate !== today) {
        const lastDate = state.lastSessionDate ? new Date(state.lastSessionDate) : null;
        const todayDate = new Date(today);

        if (lastDate) {
            const daysDiff = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
            if (daysDiff === 1) {
                state.streak++; // Consecutive day
            }
        }

        state.lastSessionDate = today;
    }

    saveUserData();
}

// ===========================================================================
// AUTHENTICATION & SPOTIFY API
// ===========================================================================

async function checkAuthStatus() {
    /**Check if user is logged in with Spotify*/
    try {
        const response = await fetch('/auth/me', {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            if (data.logged_in) {
                state.isLoggedIn = true;
                state.user = data.user;
                updateUIForLoggedInUser();
                return true;
            }
        }
    } catch (error) {
        console.error('Auth check failed:', error);
    }

    state.isLoggedIn = false;
    updateUIForLoggedOutUser();
    return false;
}

function updateUIForLoggedInUser() {
    /**Update UI when user is logged in*/
    const loginSection = document.getElementById('login-section');
    const userProfile = document.getElementById('user-profile');
    const startBtn = document.getElementById('start-swiping-btn');

    console.log('Updating UI for logged in user:', state.user);

    if (loginSection) loginSection.classList.add('hidden');
    if (userProfile) {
        userProfile.classList.remove('hidden');

        const userName = document.getElementById('user-name');
        if (userName && state.user) {
            userName.textContent = state.user.display_name || state.user.name || 'Music Lover';
        }

        const avatar = document.getElementById('user-avatar');
        if (avatar && state.user) {
            if (state.user.image) {
                avatar.src = state.user.image;
            } else {
                // Create placeholder with first letter
                const initial = (state.user.display_name || state.user.name || 'U')[0].toUpperCase();
                avatar.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="28" fill="%231DB954"/><text x="28" y="38" text-anchor="middle" fill="white" font-size="24" font-weight="bold">${initial}</text></svg>`;
            }
            avatar.style.display = 'block';
        }
    }

    if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
    }
}

function updateUIForLoggedOutUser() {
    /**Update UI when user is logged out*/
    const loginSection = document.getElementById('login-section');
    const userProfile = document.getElementById('user-profile');
    const startBtn = document.getElementById('start-swiping-btn');

    if (loginSection) loginSection.classList.remove('hidden');
    if (userProfile) userProfile.classList.add('hidden');
    if (startBtn) startBtn.disabled = true;
}

async function fetchSpotifyRecommendations() {
    /**Fetch real recommendations from Spotify API*/
    try {
        const response = await fetch('/api/recommendations', {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch recommendations');
        }

        const data = await response.json();
        return data.songs || [];
    } catch (error) {
        console.error('Failed to get Spotify recommendations:', error);
        // Fallback to sample songs
        return SAMPLE_SONGS;
    }
}

async function savePlaylistToSpotify(liked_tracks, disliked_tracks = []) {
    /**Create Spotify playlist from liked songs*/
    try {
        const response = await fetch('/api/playlist/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                liked_tracks,
                disliked_tracks
            })
        });

        if (!response.ok) {
            throw new Error('Failed to create playlist');
        }

        const data = await response.json();
        return data.playlist;
    } catch (error) {
        console.error('Failed to save playlist:', error);
        throw error;
    }
}

// ===========================================================================
// SWIPE LOGIC
// ===========================================================================

async function initializeDailySongs() {
    // Get recommendations from Spotify if logged in
    if (state.isLoggedIn) {
        state.dailySongs = await fetchSpotifyRecommendations();
    } else {
        // Fallback to sample songs
        state.dailySongs = shuffleArray(SAMPLE_SONGS).slice(0, state.maxSwipes);
    }

    state.currentSongIndex = 0;
    state.swipeCount = 0;
    state.likedSongs = [];
    state.dislikedSongs = [];
}

function createSongCard(song) {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.dataset.songId = song.id;

    const genreTags = song.genre.map(g => `<span class="genre-tag">${g}</span>`).join('');

    card.innerHTML = `
        <div class="album-art">${song.emoji}</div>
        <div class="track-name">${song.track}</div>
        <div class="artist-name">${song.artist}</div>
        <div class="genre-tags">${genreTags}</div>
    `;

    return card;
}

function renderCards() {
    const cardStack = document.getElementById('card-stack');
    cardStack.innerHTML = '';

    // Render next 3 cards for depth effect
    for (let i = 0; i < Math.min(3, state.dailySongs.length - state.currentSongIndex); i++) {
        const songIndex = state.currentSongIndex + i;
        if (songIndex < state.dailySongs.length) {
            const card = createSongCard(state.dailySongs[songIndex]);
            cardStack.appendChild(card);

            // Only add swipe listeners to the top card
            if (i === 0) {
                addSwipeListeners(card);
            }
        }
    }

    updateSwipeProgress();
}

function updateSwipeProgress() {
    document.getElementById('swipe-count').textContent = state.swipeCount;
    document.getElementById('streak-count').textContent = state.streak;
}

// ===========================================================================
// SWIPE GESTURE DETECTION
// ===========================================================================

function addSwipeListeners(card) {
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let currentY = 0;
    let isDragging = false;

    // Mouse/Touch start
    const handleStart = (e) => {
        isDragging = true;
        card.classList.add('swiping');

        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;
    };

    // Mouse/Touch move
    const handleMove = (e) => {
        if (!isDragging) return;

        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        currentX = touch.clientX - startX;
        currentY = touch.clientY - startY;

        // Apply transform
        const rotation = currentX / 20;
        card.style.transform = `translateX(${currentX}px) translateY(${currentY}px) rotate(${rotation}deg)`;

        // Visual feedback
        const opacity = Math.abs(currentX) / 100;
        if (currentX > 0) {
            card.style.borderColor = `rgba(29, 185, 84, ${Math.min(opacity, 0.5)})`;
        } else {
            card.style.borderColor = `rgba(226, 33, 52, ${Math.min(opacity, 0.5)})`;
        }
    };

    // Mouse/Touch end
    const handleEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('swiping');

        const threshold = 100;

        if (Math.abs(currentX) > threshold) {
            // Swipe detected
            if (currentX > 0) {
                swipeRight(card);
            } else {
                swipeLeft(card);
            }
        } else {
            // Return to center
            card.style.transform = '';
            card.style.borderColor = '';
        }

        currentX = 0;
        currentY = 0;
    };

    // Add listeners
    card.addEventListener('mousedown', handleStart);
    card.addEventListener('touchstart', handleStart);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('touchmove', handleMove, { passive: false });

    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchend', handleEnd);
}

function swipeRight(card) {
    const song = state.dailySongs[state.currentSongIndex];
    state.likedSongs.push(song);
    animateSwipe(card, 'right');
}

function swipeLeft(card) {
    const song = state.dailySongs[state.currentSongIndex];
    state.dislikedSongs.push(song);
    animateSwipe(card, 'left');
}

function animateSwipe(card, direction) {
    card.classList.add(`swiped-${direction}`);

    setTimeout(() => {
        state.currentSongIndex++;
        state.swipeCount++;

        if (state.swipeCount >= state.maxSwipes) {
            showResults();
        } else {
            renderCards();
        }
    }, 400);
}

// ===========================================================================
// RESULTS VIEW
// ===========================================================================

function showResults() {
    showView('results');

    // Complete session and save stats
    completeSession();

    // Animate stats
    setTimeout(() => {
        animateNumber(document.getElementById('likes-count'), state.likedSongs.length, 800);
        animateNumber(document.getElementById('dislikes-count'), state.dislikedSongs.length, 900);
        animateNumber(document.getElementById('total-swipes'), state.swipeCount, 1000);
    }, 200);

    // Fetch AI taste analysis
    if (state.isLoggedIn && state.likedSongs.length > 0) {
        fetchTasteAnalysis();
    }

    // Render liked songs
    const likedSongsList = document.getElementById('liked-songs-list');
    likedSongsList.innerHTML = '';

    if (state.likedSongs.length === 0) {
        likedSongsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">😅</div>
                <p>You didn't like any songs today!</p>
                <p>Try again tomorrow for new recommendations</p>
            </div>
        `;
    } else {
        state.likedSongs.forEach((song, index) => {
            const songItem = document.createElement('div');
            songItem.className = 'song-item';
            songItem.style.animationDelay = `${index * 0.05}s`;
            songItem.innerHTML = `
                <div class="song-emoji">${song.emoji || '🎵'}</div>
                <div class="song-info">
                    <div class="song-info-track">${song.track}</div>
                    <div class="song-info-artist">${song.artist}</div>
                </div>
            `;
            likedSongsList.appendChild(songItem);
        });
    }
}

async function fetchTasteAnalysis() {
    /**Fetch AI-powered taste analysis*/
    try {
        const response = await fetch('/api/taste-analysis', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                liked_songs: state.likedSongs,
                disliked_songs: state.dislikedSongs
            })
        });

        if (response.ok) {
            const data = await response.json();
            displayTasteAnalysis(data);
        }
    } catch (error) {
        console.error('Failed to get taste analysis:', error);
    }
}

function displayTasteAnalysis(data) {
    /**Display AI taste analysis results*/
    const tasteSection = document.getElementById('taste-analysis');
    const summaryEl = document.getElementById('taste-summary');
    const vibeBadge = document.getElementById('vibe-badge');
    const moodBadge = document.getElementById('mood-badge');

    if (data.taste) {
        summaryEl.textContent = data.taste.summary;
        vibeBadge.textContent = `✨ ${data.taste.vibe}`;
    }

    if (data.mood) {
        moodBadge.textContent = `${data.mood.mood}`;
        moodBadge.style.borderColor = data.mood.color;
        moodBadge.style.background = `${data.mood.color}20`;
    }

    tasteSection.classList.remove('hidden');
}

function animateNumber(element, finalValue, duration = 1000) {
    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = Math.floor(start + (finalValue - start) * easeOut);

        element.textContent = current;

        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = finalValue;
        }
    }

    requestAnimationFrame(update);
}

// ===========================================================================
// EVENT HANDLERS
// ===========================================================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded');

    // Load persisted user data
    loadUserData();

    // Check if user is logged in
    await checkAuthStatus();

    // Handle OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('logged_in') === 'true') {
        // Remove query params from URL
        window.history.replaceState({}, document.title, '/');
        await checkAuthStatus();
    }

    // Spotify login button
    const loginBtn = document.getElementById('spotify-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            console.log('Redirecting to Spotify login...');
            window.location.href = '/auth/login';
        });
    }

    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await fetch('/auth/logout', { credentials: 'include' });
            state.isLoggedIn = false;
            state.user = null;
            updateUIForLoggedOutUser();
        });
    }

    // Start Swiping button
    document.getElementById('start-swiping-btn').addEventListener('click', async () => {
        console.log('Start Swiping button clicked');
        await initializeDailySongs();
        console.log('Daily songs initialized:', state.dailySongs);
        showView('swipe');
        renderCards();
        console.log('Cards rendered');
    });

    // Manual action buttons (in swipe view)
    const likeBtn = document.getElementById('like-btn');
    const dislikeBtn = document.getElementById('dislike-btn');

    if (likeBtn) {
        likeBtn.addEventListener('click', () => {
            const topCard = document.querySelector('.song-card');
            if (topCard) {
                swipeRight(topCard);
            }
        });
    }

    if (dislikeBtn) {
        dislikeBtn.addEventListener('click', () => {
            const topCard = document.querySelector('.song-card');
            if (topCard) {
                swipeLeft(topCard);
            }
        });
    }


    // Save to Spotify button (in results view)
    const saveToSpotifyBtn = document.getElementById('save-to-spotify-btn');
    if (saveToSpotifyBtn) {
        saveToSpotifyBtn.addEventListener('click', async () => {
            if (!state.isLoggedIn) {
                alert('Please login with Spotify first!');
                return;
            }

            if (state.likedSongs.length === 0) {
                alert('You need to like at least one song!');
                return;
            }

            // Show loading state
            saveToSpotifyBtn.disabled = true;
            saveToSpotifyBtn.textContent = 'Creating playlist...';

            try {
                const playlist = await savePlaylistToSpotify(state.likedSongs, state.dislikedSongs);

                // Show success
                saveToSpotifyBtn.textContent = '✅ Saved to Spotify!';

                // Show playlist details with AI insights
                setTimeout(() => {
                    let message = `Playlist "${playlist.name}" created!`;
                    if (playlist.taste_analysis) {
                        message += `\n\n${playlist.taste_analysis.summary}`;
                    }
                    message += '\n\nOpen in Spotify?';

                    if (confirm(message)) {
                        window.open(playlist.url, '_blank');
                    }
                    saveToSpotifyBtn.textContent = 'Save to Spotify';
                    saveToSpotifyBtn.disabled = false;
                }, 1000);

            } catch (error) {
                alert('Failed to save playlist: ' + error.message);
                saveToSpotifyBtn.textContent = 'Save to Spotify';
                saveToSpotifyBtn.disabled = false;
            }
        });
    }

    // Share button (in results view)
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            const message = `I just discovered ${state.likedSongs.length} new songs on TasteSwipe! 🎵✨`;

            if (navigator.share) {
                navigator.share({
                    title: 'My TasteSwipe Daylist',
                    text: message
                }).catch(() => { });
            } else {
                // Fallback: copy to clipboard
                navigator.clipboard.writeText(message).then(() => {
                    alert('✅ Copied to clipboard!');
                });
            }
        });
    }

    // Come back tomorrow button (in results view)
    const comebackBtn = document.getElementById('comeback-btn');
    if (comebackBtn) {
        comebackBtn.addEventListener('click', () => {
            showView('landing');
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (state.currentView !== 'swipe') return;

        const topCard = document.querySelector('.song-card');
        if (!topCard) return;

        switch (e.key) {
            case 'ArrowRight':
            case 'l':
            case 'L':
                e.preventDefault();
                swipeRight(topCard);
                break;
            case 'ArrowLeft':
            case 'h':
            case 'H':
                e.preventDefault();
                swipeLeft(topCard);
                break;
            case ' ':
            case 'ArrowDown':
                e.preventDefault();
                swipeLeft(topCard); // Space = skip
                break;
        }
    });
});

// ===========================================================================
// CELEBRATION EFFECTS
// ===========================================================================

function createConfetti() {
    const colors = ['#1db954', '#ffffff', '#15803d', '#1ed760'];
    const confettiCount = 50;

    for (let i = 0; i < confettiCount; i++) {
        const confetti = document.createElement('div');
        confetti.style.position = 'fixed';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.top = '-10px';
        confetti.style.width = '10px';
        confetti.style.height = '10px';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
        confetti.style.opacity = '0.8';
        confetti.style.zIndex = '9999';
        confetti.style.pointerEvents = 'none';

        document.body.appendChild(confetti);

        const duration = 2000 + Math.random() * 1000;
        const xMovement = (Math.random() - 0.5) * 200;

        confetti.animate([
            {
                transform: 'translateY(0) translateX(0) rotate(0deg)',
                opacity: 0.8
            },
            {
                transform: `translateY(${window.innerHeight}px) translateX(${xMovement}px) rotate(${Math.random() * 360}deg)`,
                opacity: 0
            }
        ], {
            duration: duration,
            easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'
        }).onfinish = () => {
            confetti.remove();
        };
    }
}

// Add confetti when showing results only if user liked something
const originalShowResults = showResults;
showResults = function () {
    originalShowResults();

    if (state.likedSongs.length > 0) {
        setTimeout(() => {
            createConfetti();
        }, 500);
    }
};

// ===========================================================================
// PHASE 4: PROFILE & ONBOARDING
// ===========================================================================

function showProfile() {
    /**Display user profile with stats*/
    showView('profile');

    // Update stats
    document.getElementById('profile-sessions').textContent = state.totalSessions;
    document.getElementById('profile-likes').textContent = state.totalLikes;
    document.getElementById('profile-streak').textContent = state.streak;

    // Show recent likes
    const recentList = document.getElementById('recent-songs-list');
    recentList.innerHTML = '';

    const recentSongs = state.allTimeLikedSongs.slice(-10).reverse();
    recentSongs.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = 'song-item';
        item.style.animationDelay = `${index * 0.05}s`;
        item.innerHTML = `
            <div class="song-info">
                <div class="song-info-track">${song.track}</div>
                <div class="song-info-artist">${song.artist}</div>
            </div>
        `;
        recentList.appendChild(item);
    });
}

function showOnboarding() {
    /**Show onboarding modal for new users*/
    document.getElementById('onboarding-modal').classList.remove('hidden');
}

function hideOnboarding() {
    /**Hide onboarding modal*/
    document.getElementById('onboarding-modal').classList.add('hidden');
    state.showOnboarding = false;
    saveUserData();
}

// Check if onboarding should show
if (state.showOnboarding && state.totalSessions === 0) {
    setTimeout(() => showOnboarding(), 500);
}
