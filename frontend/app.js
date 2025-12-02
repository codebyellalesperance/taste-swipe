// ===========================================================================
// TASTESWIPE - Music Discovery App
// Tinder-style swipe interface for daily music discovery
// ===========================================================================

// Sample song database (will be replaced with Spotify API later)
const SAMPLE_SONGS = [
    { id: 1, track: "Anti-Hero", artist: "Taylor Swift", genre: ["Pop"], emoji: "🎤" },
    { id: 2, track: "Blinding Lights", artist: "The Weeknd", genre: ["Pop", "Synth"], emoji: "✨" },
    { id: 3, track: "As It Was", artist: "Harry Styles", genre: ["Pop Rock"], emoji: "🎸" },
    { id: 4, track: "Heat Waves", artist: "Glass Animals", genre: ["Indie"], emoji: "🌊" },
    { id: 5, track: "Levitating", artist: "Dua Lipa", genre: ["Pop", "Disco"], emoji: "💫" },
    { id: 6, track: "good 4 u", artist: "Olivia Rodrigo", genre: ["Pop Punk"], emoji: "🎭" },
    { id: 7, track: "Stay", artist: "The Kid LAROI, Justin Bieber", genre: ["Pop"], emoji: "💔" },
    { id: 8, track: "Montero", artist: "Lil Nas X", genre: ["Hip Hop"], emoji: "👑" },
    { id: 9, track: "Peaches", artist: "Justin Bieber", genre: ["R&B"], emoji: "🍑" },
    { id: 10, track: "drivers license", artist: "Olivia Rodrigo", genre: ["Pop"], emoji: "🚗" }
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
    dailySongs: []
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
// SWIPE LOGIC
// ===========================================================================

function initializeDailySongs() {
    // Shuffle songs for today
    state.dailySongs = shuffleArray(SAMPLE_SONGS).slice(0, state.maxSwipes);
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

    // Animate stats
    setTimeout(() => {
        animateNumber(document.getElementById('likes-count'), state.likedSongs.length, 800);
        animateNumber(document.getElementById('dislikes-count'), state.dislikedSongs.length, 900);
        animateNumber(document.getElementById('total-swipes'), state.swipeCount, 1000);
    }, 200);

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
                <div class="song-emoji">${song.emoji}</div>
                <div class="song-info">
                    <div class="song-info-track">${song.track}</div>
                    <div class="song-info-artist">${song.artist}</div>
                </div>
            `;
            likedSongsList.appendChild(songItem);
        });
    }
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

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded');
    console.log('Start button:', document.getElementById('start-swiping-btn'));

    // Start Swiping button
    document.getElementById('start-swiping-btn').addEventListener('click', () => {
        console.log('Start Swiping button clicked');
        initializeDailySongs();
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
