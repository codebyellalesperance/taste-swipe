// ===========================================================================
// SPOTIFY ERAS - COMPLETE FRONTEND APPLICATION
// Premium UI with Apple/Spotify Wrapped-inspired animations
// ===========================================================================

// Configuration
const API_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:5000'
    : '';  // Same origin in production
const MAX_FILE_SIZE_MB = 500;

// Application state
const state = {
    sessionId: null,
    currentView: 'landing',
    selectedFile: null,
    currentEraId: null,
    currentEra: null,
    summary: null,
    eras: []
};

// ===========================================================================
// UTILITY FUNCTIONS
// ===========================================================================

// Fetch wrapper with timeout and error handling
async function apiFetch(url, options = {}) {
    const timeout = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw new Error('Network error. Please check your connection.');
    }
}

// View management with smooth transitions
function showView(viewName) {
    const oldView = document.querySelector('.view:not(.hidden)');
    const newView = document.getElementById(`${viewName}-view`);
    
    // Fade out old view
    if (oldView) {
        oldView.classList.add('view-exit');
        setTimeout(() => {
            oldView.classList.add('hidden');
            oldView.classList.remove('view-exit');
        }, 300);
    }
    
    // Fade in new view
    newView.classList.remove('hidden');
    newView.classList.add('view-enter');
    
    setTimeout(() => {
        newView.classList.remove('view-enter');
    }, 50);
    
    state.currentView = viewName;
    
    // Scroll to top smoothly
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// File size formatting helper
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// Error display helpers
function showError(message) {
    const errorDiv = document.getElementById('error-message');
    const errorText = document.getElementById('error-text');
    errorText.textContent = message;
    errorDiv.classList.remove('hidden');
}

function hideError() {
    const errorDiv = document.getElementById('error-message');
    errorDiv.classList.add('hidden');
}

// ===========================================================================
// PHASE 7: PROCESSING VIEW
// ===========================================================================

// Progress stage display text
const STAGE_TEXT = {
    'uploading': 'Uploading your data...',
    'parsed': 'Reading your listening history...',
    'segmented': 'Detecting your music eras...',
    'naming': 'Generating era descriptions...',
    'named': 'Era descriptions complete...',
    'playlists': 'Building your playlists...',
    'complete': 'Done! Loading your timeline...',
    'error': 'Something went wrong'
};

function getStageText(stage) {
    return STAGE_TEXT[stage] || `Processing: ${stage}`;
}

// SSE connection reference for cleanup
let eventSource = null;
let sseTimeoutId = null;

function startProgressListener(sessionId) {
    // Close any existing connection
    if (eventSource) {
        eventSource.close();
    }
    
    // Clear any existing timeout
    if (sseTimeoutId) {
        clearTimeout(sseTimeoutId);
    }

    const stageText = document.getElementById('stage-text');
    const progressFill = document.getElementById('progress-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressContainer = document.querySelector('.progress-container');
    const processingError = document.getElementById('processing-error');
    const processingErrorText = document.getElementById('processing-error-text');
    const spinner = document.querySelector('.spinner');

    // Set a client-side timeout (5 minutes) in case backend hangs
    sseTimeoutId = setTimeout(() => {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        spinner.classList.add('hidden');
        processingErrorText.textContent = 'Processing timed out. Please try again.';
        processingError.classList.remove('hidden');
    }, 5 * 60 * 1000);

    eventSource = new EventSource(`${API_URL}/progress/${sessionId}`);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const { stage, percent, message } = data;

            // Update stage text with fade animation
            stageText.classList.add('updating');
            setTimeout(() => {
                stageText.textContent = getStageText(stage);
                stageText.classList.remove('updating');
            }, 150);

            // Prevent progress from going backwards
            const currentPercent = parseInt(progressFill.style.width) || 0;
            const newPercent = Math.max(currentPercent, percent || 0);
            progressFill.style.width = `${newPercent}%`;
            progressPercent.textContent = `${newPercent}%`;
            
            // Update ARIA attribute
            progressContainer.setAttribute('aria-valuenow', newPercent);

            // Handle completion
            if (stage === 'complete') {
                clearTimeout(sseTimeoutId);
                eventSource.close();
                eventSource = null;
                spinner.classList.add('hidden');
                loadTimeline();
            }

            // Handle error
            if (stage === 'error') {
                clearTimeout(sseTimeoutId);
                eventSource.close();
                eventSource = null;
                spinner.classList.add('hidden');
                processingErrorText.textContent = message || 'Processing failed. Please try again.';
                processingError.classList.remove('hidden');
            }
        } catch (err) {
            console.error('Failed to parse SSE message:', err);
        }
    };

    eventSource.onerror = (err) => {
        console.error('SSE connection error:', err);

        // Check if connection is permanently closed
        if (eventSource.readyState === EventSource.CLOSED) {
            clearTimeout(sseTimeoutId);
            
            // Only show error if we're still on processing view and no error is already shown
            if (state.currentView === 'processing' && processingError.classList.contains('hidden')) {
                spinner.classList.add('hidden');
                processingErrorText.textContent = 'Connection lost. Please try again.';
                processingError.classList.remove('hidden');
            }
        }
    };
}

function stopProgressListener() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (sseTimeoutId) {
        clearTimeout(sseTimeoutId);
        sseTimeoutId = null;
    }
}

async function loadTimeline() {
    try {
        // Fetch summary and eras in parallel using apiFetch for timeout handling
        const [summaryRes, erasRes] = await Promise.all([
            apiFetch(`${API_URL}/session/${state.sessionId}/summary`),
            apiFetch(`${API_URL}/session/${state.sessionId}/eras`)
        ]);

        if (!summaryRes.ok || !erasRes.ok) {
            throw new Error('Failed to load timeline data');
        }

        const summary = await summaryRes.json();
        const eras = await erasRes.json();

        // Store in state for use by timeline view
        state.summary = summary;
        state.eras = eras;

        // Transition to timeline
        showView('timeline');
        renderTimeline();

    } catch (err) {
        console.error('Failed to load timeline:', err);
        // Show error in processing view
        const processingError = document.getElementById('processing-error');
        const processingErrorText = document.getElementById('processing-error-text');
        const spinner = document.querySelector('.spinner');
        
        spinner.classList.add('hidden');
        processingErrorText.textContent = err.message || 'Failed to load your timeline. Please try again.';
        processingError.classList.remove('hidden');
    }
}

// Clean up SSE connection if user leaves or refreshes
window.addEventListener('beforeunload', () => {
    stopProgressListener();
});

// ===========================================================================
// PHASE 8: TIMELINE VIEW
// ===========================================================================

// Formatting helpers
function formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1000) {
        return `${(hours / 1000).toFixed(1)}k`;
    }
    return hours.toLocaleString();
}

function formatDateRange(startDate, endDate) {
    const options = { month: 'short', year: 'numeric' };
    const start = new Date(startDate).toLocaleDateString('en-US', options);
    const end = new Date(endDate).toLocaleDateString('en-US', options);
    return `${start} - ${end}`;
}

function formatEraDuration(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.round((end - start) / (1000 * 60 * 60 * 24));

    if (days < 14) {
        return `${days} days`;
    } else if (days < 60) {
        const weeks = Math.round(days / 7);
        return `${weeks} week${weeks !== 1 ? 's' : ''}`;
    } else {
        const months = Math.round(days / 30);
        return `${months} month${months !== 1 ? 's' : ''}`;
    }
}

// HTML escaping for safety
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Animate number counting (Spotify Wrapped style)
function animateNumber(element, finalValue, duration = 1000) {
    const start = 0;
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function (ease-out cubic)
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = Math.floor(start + (finalValue - start) * easeOut);
        
        element.textContent = typeof finalValue === 'string' ? finalValue : current.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = typeof finalValue === 'string' ? finalValue : finalValue.toLocaleString();
        }
    }
    
    requestAnimationFrame(update);
}

function renderTimeline() {
    const { summary, eras } = state;

    // Update stats with animated numbers
    const hoursElement = document.getElementById('stat-hours');
    const erasElement = document.getElementById('stat-eras');
    const artistsElement = document.getElementById('stat-artists');
    
    const totalHours = formatDuration(summary.total_listening_time_ms);
    
    // Animate numbers (parse first if string contains formatting)
    setTimeout(() => {
        const hoursNum = parseInt(totalHours.replace(/,/g, ''));
        if (!isNaN(hoursNum)) {
            animateNumber(hoursElement, hoursNum, 1200);
        } else {
            hoursElement.textContent = totalHours;
        }
        
        animateNumber(erasElement, summary.total_eras, 1000);
        animateNumber(artistsElement, summary.total_artists, 1400);
    }, 200); // Delay to let view transition complete
    
    document.getElementById('stat-date-range').textContent =
        `${formatDateRange(summary.date_range.start, summary.date_range.end)}`;

    // Render era cards
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '';

    if (eras.length === 0) {
        timeline.innerHTML = '<p class="empty-state">No eras found in your listening history.</p>';
        return;
    }

    eras.forEach(era => {
        const card = createEraCard(era);
        timeline.appendChild(card);
    });
}

function createEraCard(era) {
    const card = document.createElement('div');
    card.className = 'era-card';
    card.dataset.eraId = era.id;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View details for ${era.title} era`);

    const dateRange = formatDateRange(era.start_date, era.end_date);
    const duration = formatEraDuration(era.start_date, era.end_date);

    const artistTags = era.top_artists
        .map(a => `<span class="artist-tag">${escapeHtml(a.name)}</span>`)
        .join('');

    card.innerHTML = `
        <div class="era-card-header">
            <div>
                <h3 class="era-title">${escapeHtml(era.title)}</h3>
                <p class="era-dates">${dateRange}</p>
            </div>
            <span class="era-duration">${duration}</span>
        </div>
        <div class="artist-tags">${artistTags}</div>
        <p class="era-track-count">${era.playlist_track_count} tracks</p>
    `;

    // Click handler to view era details
    const handleActivate = () => {
        viewEraDetail(era.id);
    };

    card.addEventListener('click', handleActivate);
    
    // Keyboard navigation - Enter or Space activates
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleActivate();
        }
    });

    return card;
}

async function viewEraDetail(eraId) {
    state.currentEraId = eraId;

    // Show detail view first
    showView('detail');
    
    // Show loading, hide content
    const loadingEl = document.getElementById('detail-loading');
    const contentEl = document.getElementById('detail-content');
    const errorEl = document.getElementById('detail-error');
    
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    errorEl.classList.add('hidden');

    try {
        const response = await apiFetch(`${API_URL}/session/${state.sessionId}/eras/${eraId}`);

        if (!response.ok) {
            throw new Error('Failed to load era details');
        }

        const eraDetail = await response.json();
        state.currentEra = eraDetail;

        // Hide loading, show content
        loadingEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
        
        renderEraDetail();

    } catch (err) {
        console.error('Failed to load era detail:', err);
        
        // Hide loading, show error
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
        document.getElementById('detail-error-text').textContent = 
            err.message || 'Failed to load era details. Please try again.';
    }
}

// ===========================================================================
// PHASE 9: DETAIL VIEW
// ===========================================================================

function renderEraDetail() {
    const era = state.currentEra;

    // Update header
    document.getElementById('detail-title').textContent = era.title;
    document.getElementById('detail-dates').textContent = formatDateRange(era.start_date, era.end_date);
    document.getElementById('detail-summary').textContent = era.summary || '';

    // Update stats
    const hours = Math.floor(era.total_ms_played / 3600000);
    document.getElementById('detail-hours').textContent = hours.toLocaleString();
    document.getElementById('detail-track-count').textContent = era.top_tracks.length;

    // Render artists
    const artistList = document.getElementById('detail-artists');
    artistList.innerHTML = era.top_artists.map(artist => `
        <li>
            <span class="artist-name">${escapeHtml(artist.name)}</span>
            <span class="artist-plays">${artist.plays.toLocaleString()} plays</span>
        </li>
    `).join('');

    // Render tracks
    const trackList = document.getElementById('detail-tracks');
    trackList.innerHTML = era.top_tracks.map(track => `
        <li>
            <div class="track-info">
                <div class="track-name">${escapeHtml(track.track)}</div>
                <div class="track-artist">${escapeHtml(track.artist)}</div>
            </div>
            <span class="track-plays">${track.plays} plays</span>
        </li>
    `).join('');
}

// Toast timeout reference for cleanup
let toastTimeout = null;

function showToast(message, duration = 2000) {
    const toast = document.getElementById('toast');
    
    // Clear any existing timeout
    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }
    
    // Remove any existing visible state
    toast.classList.remove('visible');
    
    // Small delay to allow CSS transition reset
    setTimeout(() => {
        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('visible');

        toastTimeout = setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => {
                toast.classList.add('hidden');
                toastTimeout = null;
            }, 300);  // Wait for fade out transition
        }, duration);
    }, 50);
}

// ===========================================================================
// DOM EVENT HANDLERS (Inside DOMContentLoaded)
// ===========================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Get DOM elements
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    const fileInfo = document.getElementById('file-info');
    const fileName = document.getElementById('file-name');
    const fileSize = document.getElementById('file-size');
    const clearFileBtn = document.getElementById('clear-file');
    const analyzeBtn = document.getElementById('analyze-btn');

    // Drag counter to prevent flicker
    let dragCounter = 0;

    // Upload area click handler
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });

    // Drag and drop handlers
    uploadArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    uploadArea.addEventListener('dragleave', () => {
        dragCounter--;
        if (dragCounter === 0) {
            uploadArea.classList.remove('drag-over');
        }
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        uploadArea.classList.remove('drag-over');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    // File input change handler
    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    // File selection handler
    function handleFileSelect(file) {
        hideError();

        // Validate file extension
        const validExtensions = ['.json', '.zip'];
        const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
        if (!validExtensions.includes(fileExtension)) {
            showError('Invalid file type. Please upload a .json or .zip file');
            return;
        }

        // Validate file size
        const maxSize = MAX_FILE_SIZE_MB * 1024 * 1024;
        if (file.size > maxSize) {
            showError(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`);
            return;
        }

        // Store file and update UI
        state.selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = formatFileSize(file.size);
        fileInfo.classList.remove('hidden');
        analyzeBtn.disabled = false;
        analyzeBtn.focus();
    }

    // Clear file handler
    function clearFile() {
        state.selectedFile = null;
        fileInput.value = '';
        fileInfo.classList.add('hidden');
        analyzeBtn.disabled = true;
        hideError();
    }

    clearFileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearFile();
    });

    // Analyze button handler
    analyzeBtn.addEventListener('click', async () => {
        if (!state.selectedFile) return;

        // Save original button state
        const originalText = analyzeBtn.textContent;
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = 'Uploading...';
        hideError();

        try {
            // Step 1: Upload file
            const formData = new FormData();
            formData.append('file', state.selectedFile);

            const uploadResponse = await apiFetch(`${API_URL}/upload`, {
                method: 'POST',
                body: formData
            });

            if (!uploadResponse.ok) {
                const data = await uploadResponse.json();
                throw new Error(data.error || 'Upload failed');
            }

            const { session_id } = await uploadResponse.json();
            state.sessionId = session_id;

            // Step 2: Transition to processing view
            showView('processing');

            // Step 3: Start processing (non-blocking)
            fetch(`${API_URL}/process/${session_id}`, { method: 'POST' })
                .catch(err => console.error('Process request failed:', err));

            // Step 4: Start listening for progress
            startProgressListener(session_id);

        } catch (err) {
            // Reset UI to allow retry
            showError(err.message);
            analyzeBtn.disabled = false;
            analyzeBtn.textContent = originalText;
        }
    });

    // Processing view retry button
    document.getElementById('retry-btn').addEventListener('click', () => {
        // Stop any active SSE connections to prevent race conditions
        stopProgressListener();
        
        // Reset processing view state
        const processingError = document.getElementById('processing-error');
        const spinner = document.querySelector('.spinner');
        const stageText = document.getElementById('stage-text');
        const progressFill = document.getElementById('progress-fill');
        const progressPercent = document.getElementById('progress-percent');
        const progressContainer = document.querySelector('.progress-container');

        processingError.classList.add('hidden');
        spinner.classList.remove('hidden');
        stageText.textContent = 'Starting...';
        progressFill.style.width = '0%';
        progressPercent.textContent = '0%';
        progressContainer.setAttribute('aria-valuenow', '0');

        // Go back to landing to re-upload
        showView('landing');

        // Reset landing view state
        clearFile();
        analyzeBtn.textContent = 'Analyze My Music';

        // Clear session and state
        state.sessionId = null;
        state.summary = null;
        state.eras = [];
    });

    // Timeline view start over button
    document.getElementById('start-over-btn').addEventListener('click', () => {
        // Reset all state
        state.sessionId = null;
        state.summary = null;
        state.eras = [];
        state.currentEraId = null;
        state.currentEra = null;

        // Reset landing view
        clearFile();
        analyzeBtn.textContent = 'Analyze My Music';

        // Go to landing
        showView('landing');
    });

    // Detail view back button
    document.getElementById('back-btn').addEventListener('click', () => {
        state.currentEraId = null;
        state.currentEra = null;
        showView('timeline');
    });

    // Detail view copy playlist button
    document.getElementById('copy-playlist-btn').addEventListener('click', async () => {
        const era = state.currentEra;
        if (!era || !era.top_tracks) return;

        // Format tracks as "Artist - Track" list
        const trackList = era.top_tracks
            .map((track, i) => `${i + 1}. ${track.artist} - ${track.track}`)
            .join('\n');

        const header = `${era.title}\n${formatDateRange(era.start_date, era.end_date)}\n\n`;
        const textToCopy = header + trackList;

        try {
            // Modern clipboard API
            await navigator.clipboard.writeText(textToCopy);
            showToast('Copied to clipboard!');
        } catch (err) {
            // Fallback for older browsers
            try {
                const textarea = document.createElement('textarea');
                textarea.value = textToCopy;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                const successful = document.execCommand('copy');
                document.body.removeChild(textarea);
                
                if (successful) {
                    showToast('Copied to clipboard!');
                } else {
                    throw new Error('Copy command failed');
                }
            } catch (fallbackErr) {
                console.error('Failed to copy:', fallbackErr);
                showToast('Failed to copy. Please copy manually.');
            }
        }
    });
});
