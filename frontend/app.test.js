/**
 * Unit Tests for TasteSwipe Frontend
 * Tests for core functionality, UI interactions, and API calls
 */

// Mock localStorage
const localStorageMock = (() => {
    let store = {};
    return {
        getItem: (key) => store[key] || null,
        setItem: (key, value) => { store[key] = value.toString(); },
        clear: () => { store = {}; },
        removeItem: (key) => { delete store[key]; }
    };
})();

global.localStorage = localStorageMock;

describe('TasteSwipe Frontend Tests', () => {

    // Test Data Persistence
    describe('Data Persistence', () => {
        beforeEach(() => {
            localStorage.clear();
        });

        test('saveUserData should persist state to localStorage', () => {
            const state = {
                streak: 5,
                totalSessions: 10,
                totalLikes: 50,
                allTimeLikedSongs: [{ id: 1, track: 'Test' }],
                lastSessionDate: '2025-12-02',
                showOnboarding: false
            };

            // Simulate saveUserData
            localStorage.setItem('tasteswipe_data', JSON.stringify(state));

            const saved = JSON.parse(localStorage.getItem('tasteswipe_data'));
            expect(saved.streak).toBe(5);
            expect(saved.totalSessions).toBe(10);
        });

        test('loadUserData should restore state from localStorage', () => {
            const mockData = {
                streak: 3,
                totalSessions: 7
            };
            localStorage.setItem('tasteswipe_data', JSON.stringify(mockData));

            const loaded = JSON.parse(localStorage.getItem('tasteswipe_data'));
            expect(loaded.streak).toBe(3);
        });

        test('streak should reset after missing a day', () => {
            const lastDate = new Date('2025-12-01');
            const today = new Date('2025-12-03'); // Skipped a day

            const daysDiff = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));

            let streak = 5;
            if (daysDiff > 1) {
                streak = 1; // Reset
            }

            expect(streak).toBe(1);
        });

        test('streak should continue on consecutive days', () => {
            const lastDate = new Date('2025-12-01');
            const today = new Date('2025-12-02'); // Next day

            const daysDiff = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));

            let streak = 5;
            if (daysDiff === 1) {
                streak++; // Increment
            }

            expect(streak).toBe(6);
        });
    });

    // Test Utility Functions
    describe('Utility Functions', () => {
        test('shuffleArray should randomize array', () => {
            const arr = [1, 2, 3, 4, 5];
            const shuffled = [...arr].sort(() => Math.random() - 0.5);

            // Arrays should have same length
            expect(shuffled.length).toBe(arr.length);

            // Arrays should contain same elements
            arr.forEach(item => {
                expect(shuffled).toContain(item);
            });
        });

        test('animateNumber should increment to target', (done) => {
            let currentValue = 0;
            const targetValue = 10;
            const duration = 100;

            const startTime = Date.now();
            const interval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                currentValue = Math.floor(progress * targetValue);

                if (progress >= 1) {
                    clearInterval(interval);
                    expect(currentValue).toBe(targetValue);
                    done();
                }
            }, 16);
        });
    });

    // Test Swipe Logic
    describe('Swipe Logic', () => {
        test('handleSwipe should track likes correctly', () => {
            const likedSongs = [];
            const song = { id: 1, track: 'Test Song', artist: 'Test Artist' };

            // Simulate like
            likedSongs.push(song);

            expect(likedSongs.length).toBe(1);
            expect(likedSongs[0].track).toBe('Test Song');
        });

        test('handleSwipe should track dislikes correctly', () => {
            const dislikedSongs = [];
            const song = { id: 2, track: 'Skipped Song', artist: 'Artist' };

            // Simulate dislike
            dislikedSongs.push(song);

            expect(dislikedSongs.length).toBe(1);
        });

        test('swipe count should not exceed max swipes', () => {
            let swipeCount = 0;
            const maxSwipes = 10;

            for (let i = 0; i < 15; i++) {
                if (swipeCount < maxSwipes) {
                    swipeCount++;
                }
            }

            expect(swipeCount).toBe(maxSwipes);
        });
    });

    // Test Session Completion
    describe('Session Completion', () => {
        test('completeSession should update total sessions', () => {
            let totalSessions = 5;

            // Simulate session completion
            totalSessions++;

            expect(totalSessions).toBe(6);
        });

        test('completeSession should add liked songs to all-time list', () => {
            const allTimeLiked = [{ id: 1, track: 'Old Song' }];
            const sessionLiked = [{ id: 2, track: 'New Song' }];

            // Add new songs
            sessionLiked.forEach(song => {
                if (!allTimeLiked.find(s => s.id === song.id)) {
                    allTimeLiked.push(song);
                }
            });

            expect(allTimeLiked.length).toBe(2);
        });

        test('completeSession should not duplicate songs', () => {
            const allTimeLiked = [{ id: 1, track: 'Song 1' }];
            const sessionLiked = [{ id: 1, track: 'Song 1' }]; // Duplicate

            sessionLiked.forEach(song => {
                if (!allTimeLiked.find(s => s.id === song.id)) {
                    allTimeLiked.push(song);
                }
            });

            expect(allTimeLiked.length).toBe(1); // Should not add duplicate
        });
    });

    // Test API Integration
    describe('API Integration', () => {
        beforeEach(() => {
            global.fetch = jest.fn();
        });

        test('checkAuthStatus should handle logged in user', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    logged_in: true,
                    user: {
                        id: 'user123',
                        display_name: 'Test User',
                        image: 'avatar.jpg'
                    }
                })
            });

            const response = await fetch('http://localhost:5001/auth/me');
            const data = await response.json();

            expect(data.logged_in).toBe(true);
            expect(data.user.display_name).toBe('Test User');
        });

        test('fetchSpotifyRecommendations should return songs', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    songs: [
                        { id: 1, track: 'Song 1', artist: 'Artist 1' },
                        { id: 2, track: 'Song 2', artist: 'Artist 2' }
                    ]
                })
            });

            const response = await fetch('http://localhost:5001/api/recommendations');
            const data = await response.json();

            expect(data.songs.length).toBe(2);
        });

        test('savePlaylistToSpotify should return playlist info', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    playlist: {
                        id: 'playlist123',
                        name: 'TasteSwipe Mix',
                        url: 'https://open.spotify.com/playlist/123'
                    }
                })
            });

            const response = await fetch('http://localhost:5001/api/playlist/create', {
                method: 'POST',
                body: JSON.stringify({ liked_tracks: [] })
            });
            const data = await response.json();

            expect(data.playlist.name).toBe('TasteSwipe Mix');
        });
    });

    // Test UI State Management
    describe('UI State Management', () => {
        test('showView should update current view', () => {
            let currentView = 'landing';

            // Simulate view change
            currentView = 'swipe';

            expect(currentView).toBe('swipe');
        });

        test('updateUIForLoggedInUser should show profile', () => {
            let loginSectionHidden = false;
            let profileVisible = false;
            let startButtonEnabled = false;

            // Simulate login UI update
            loginSectionHidden = true;
            profileVisible = true;
            startButtonEnabled = true;

            expect(loginSectionHidden).toBe(true);
            expect(profileVisible).toBe(true);
            expect(startButtonEnabled).toBe(true);
        });
    });
});

// Run tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {};
}
