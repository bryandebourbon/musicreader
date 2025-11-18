# eMusicReader Technical Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [MusicXML Processing](#musicxml-processing)
5. [Rendering System](#rendering-system)
6. [Touch Interaction](#touch-interaction)
7. [AI Integration](#ai-integration)
8. [Audio Playback](#audio-playback)
9. [Progressive Web App Features](#progressive-web-app-features)
10. [Data Flow](#data-flow)

---

## Overview

eMusicReader is a browser-based Progressive Web App for reading, analyzing, and interacting with MusicXML sheet music files. The entire application is self-contained in a single HTML file with embedded JavaScript and CSS, requiring no build process or external dependencies beyond CDN-hosted Font Awesome icons.

**Key Features:**
- MusicXML and MXL (compressed) file import
- Touch-based phrase selection with swipe gestures
- AI-powered analysis (Technical, Fingering, Sheet Music Generation)
- Web Audio API playback with polyphonic support
- Offline PWA functionality with service worker caching
- Page-based navigation optimized for mobile devices

---

## Architecture

### Single-Page Application Structure

The app follows a monolithic architecture:
- **index.html** (3,122 lines): Contains all HTML, CSS, and JavaScript
- **jszip.min.js**: Bundled library for decompressing .mxl files
- **service-worker.js**: PWA caching logic
- **manifest.json**: PWA metadata and icons

### Technology Stack

**Frontend:**
- Pure HTML5/CSS3/JavaScript (ES6+)
- CSS Custom Properties for theming
- CSS Grid/Flexbox for layout
- SVG for drawing ties and beams

**APIs:**
- Web Audio API for sound synthesis
- File API for drag-and-drop import
- Service Worker API for offline caching
- Pointer Events API for touch/mouse handling
- OpenAI ChatGPT API for AI features

---

## Core Components

### 1. Global State Management

```javascript
// Musical notation data
let noteSteps = [];          // Array of note letters ['c', 'd', 'e', ...]
let notePitches = [];        // Numeric pitch values for comparison
let pitchSigns = [];         // Direction indicators ['U', 'D', 'S']
let noteElements = [];       // DOM references to rendered notes

// Pattern detection
let detectedPatterns = {};   // Ascending/repeating melodic patterns
let detectedDescending = {}; // Descending melodic patterns
let allDetectedPatterns = {}; // Merged patterns
let winningGroups = [];      // Most significant patterns for display

// Audio state
let musicTimeline = [];      // Timeline for playback
let timelineByMeasure = [];  // Per-measure timeline data
let activeOscillators = [];  // Active Web Audio oscillators
let divisionsPerQuarter = 1; // MusicXML divisions (from file)

// Library/file management
let library = [];            // User's music library (localStorage)
let openFiles = [];          // Currently loaded files
let currentFile = null;      // Active file name

// UI state
let zoomLevel = 1;           // Current zoom (0.5-3.0)
let soundEnabled = true;     // Audio on/off
let aiMode = 'off';          // AI mode: 'off', 'analysis', 'fingering', 'sheetmusic'
let autoFeaturesEnabled = false; // Auto-tie/beam rendering
```

### 2. Initialization Sequence

**init()** function (lines 1013-1039):
1. Registers pointer event handlers for touch/pinch gestures
2. Loads library from localStorage
3. Loads default file (ddd.xml)
4. Sets up UI event listeners

**loadDefaultFile()** (lines 1131-1136):
- Fetches 'ddd.xml' on page load
- Calls `parseAndPopulate()` to render the sheet music

---

## MusicXML Processing

### File Loading Pipeline

#### Step 1: File Input
**fileHandler()** (lines 843-867):
- Accepts .musicxml and .mxl files via file picker or drag-and-drop
- Routes to `loadFile()`

**loadFile()** (lines 869-904):
- For .mxl: Uses JSZip to decompress, extracts container.xml, finds main .musicxml file
- For .musicxml: Reads directly as text
- Calls `parseAndPopulate()`

#### Step 2: XML Parsing
**parseAndPopulate()** (lines 810-841):
- Parses XML string into DOM using DOMParser
- Saves to library (localStorage)
- Calls `populateStaffFromMusicXML()`
- Triggers page setup and UI updates

#### Step 3: Music Notation Extraction
**populateStaffFromMusicXML()** (lines 1582-1638):

Key operations:
1. **Reset global arrays**: Clears previous note data
2. **Parse score metadata**: Extracts key, time signature, clef, dynamics
3. **Build measure structure**:
   - Iterates through all `<part>` elements
   - Calls `parseMeasureNotes()` for each measure
   - Calls `appendInterleavedNotes()` to render notes in timeline order
4. **Build audio timeline**: Creates playback data structure
5. **Pattern detection**: Finds repeated melodic phrases
6. **Auto-features**: Optionally renders ties and beams

**parseMeasureNotes()** (lines 1394-1448):
- Converts MusicXML `<note>` elements into JavaScript objects
- Handles `<chord>` (notes played simultaneously)
- Handles `<forward>` and `<backup>` (timeline adjustments)
- Returns array of note objects with timing information

**appendInterleavedNotes()** (lines 1489-1580):
- Merges notes from multiple parts (e.g., treble + bass clef)
- Sorts notes by time, then by part
- Generates staff block HTML for each note
- Populates `noteSteps`, `notePitches`, `noteElements` arrays
- Handles beams (grouped eighth/sixteenth notes)

---

## Rendering System

### Staff Generation

**genStaffBlock()** (lines 2644-2664):
- Clones template staff from `.assets` section
- Clones template note element
- Calls `plotStaffBlock()` to position note

**plotStaffBlock()** (lines 2666-2715):
- Finds correct pitch position (e.g., `.e4`, `.g5`)
- Handles ledger lines (notes above/below staff)
- Applies note type class (`.whole`, `.half`, `.quarter`, `.eighth`, `.sixteenth`)
- Sets data attributes (`data-pitch`, `data-index`)
- Returns staff block DOM element

### Note Rendering Classes

CSS note system (lines 364-573):
- **`.note`**: Base note container
- **`.head`**: Note head (rotated ellipse)
- **`.stem`**: Vertical stem line
- **`.flag`**: Flag for eighth/sixteenth notes
- **`.whole`, `.half`**: Hollow note heads with CSS pseudo-elements
- **`.stem-up`, `.stem-down`**: Stem direction

### Ties and Beams

**tieify()** (lines 1187-1239):
- Finds notes with `data-tie` attributes (from MusicXML `<tied>` elements)
- Draws curved arcs between tied notes using absolutely positioned divs
- Uses CSS `border-radius` to create tie curves

**beamify()** (lines 1243-1308):
- Groups notes within `.beam` containers
- Draws SVG lines connecting note flags
- Adjusts stem heights to meet beam line
- Removes individual flags

### Visual Effects

**Dark Mode** (lines 76-103):
- CSS custom properties for theming
- Inverts colors (`--space-color`, `--line-color`, `--note-color`)
- Detects system preference via `prefers-color-scheme`

**Zoom** (lines 1097-1118):
- CSS `transform: scale()` on `#zoomContainer`
- Inversely adjusts container width to maintain full viewport
- Range: 0.5x to 3.0x

---

## Touch Interaction

### Pinch-to-Zoom Gesture

**Pointer Event Handlers** (lines 1040-1085):

**pointerdownHandler()**: Caches touch/pointer events
**pointermoveHandler()**:
- Calculates distance between two pointers using `Math.hypot()`
- Compares to previous distance to detect pinch in/out
- Calls `setZoomLevel()` to adjust zoom

**pointerupHandler()**: Removes pointer from cache

### Swipe Selection

**Swipe Detection** (lines 2718-2869):

**touchStartHandler()**:
- Records initial touch position
- Sets `touchStartIndex` from note's `data-index`

**touchMoveHandler()**:
- Identifies notes under current touch position
- Expands selection range (`touchStartIndex` to `touchEndIndex`)
- Highlights notes in range with `.phrase-highlight` class
- Draws bounding box around selection

**touchEndHandler()**:
- Finalizes selection
- Triggers AI analysis if mode is active
- Calls `queryChatGPT()` for selected phrase

### Page Navigation

**Page System** (lines 2922-3012):
- Disables vertical scrolling to prevent gesture conflicts
- Calculates pages based on viewport height
- Previous/Next buttons scroll by exact page increments
- Uses `scrollIntoView()` for smooth transitions

---

## AI Integration

### OpenAI ChatGPT Communication

**queryChatGPT()** (lines 906-979):

**Request Structure:**
```javascript
{
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userQuery }
  ]
}
```

**System Prompts by Mode:**

1. **Technical Analysis**:
   - "Analyze this musical passage: [note sequence]"
   - Returns music theory insights (harmony, rhythm, form)

2. **Fingering**:
   - "Provide piano fingering for: [note sequence]"
   - Returns "1 2 3 4 5" digit sequence
   - Parsed by regex `/[1-5]/g`
   - Applied to notes as `.finger` span elements

3. **Sheet Music Generation**:
   - "Generate complete MusicXML for: [song name]"
   - Returns full MusicXML document
   - Sanitized by `sanitizeAndExtractXML()` (lines 2379-2457)
   - Auto-loaded into the reader

**API Key Storage**:
- Stored in localStorage as `chatgpt-api-key`
- Prompted via settings modal if missing

### Fingering Number Display

**applyFingeringNumbers()** (lines 985-1000):
- Extracts digits 1-5 from AI response
- Creates `<span class="finger">` elements above notes
- Positioned via CSS (`.note .finger` at lines 393-402)

---

## Audio Playback

### Web Audio API Architecture

**AudioContext Management** (lines 817-821):
- Single global `audioCtx` instance
- Lazy initialization on first play
- Handles iOS suspended state with `.resume()`

### Sound Synthesis

**playFreqWithDuration()** (lines 2215-2274):

**Synthesis Pipeline:**
1. Creates OscillatorNode (triangle wave for pleasant tone)
2. Creates GainNode for volume envelope
3. Chains: Oscillator → Gain → Destination (speakers)
4. Applies ADSR envelope:
   - **Attack**: 5ms fade-in
   - **Sustain**: 0.2 volume level
   - **Release**: 10% of note duration

**noteToFreq()** (lines 2203-2213):
- Converts note name (e.g., "a4") to frequency (Hz)
- Uses equal temperament formula: `440 * 2^((midi - 69) / 12)`

### Polyphonic Playback

**playCompleteTimeline()** (lines 2624-2642):
- Schedules all notes from `musicTimeline` array
- Uses Web Audio API's scheduled start times
- Limits concurrent oscillators to 100 to prevent browser crash
- Cleanup function removes finished oscillators

**Oscillator Lifecycle**:
1. Created at note start time
2. Added to `activeOscillators` array
3. `.onended` event removes from array
4. Manual cleanup via `cleanupFinishedOscillators()` at 80% capacity

### Visual Playback Feedback

**Measure Highlighting** (lines 2620-2622):
- Adds `.playing` class to staff blocks
- Orange outline indicates current playing note

---

## Progressive Web App Features

### Service Worker (service-worker.js)

**Cache Strategy:**
```javascript
const CACHE_NAME = 'music-reader-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/jszip.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];
```

**Lifecycle:**
1. **Install**: Caches core assets
2. **Activate**: Deletes old caches
3. **Fetch**: Cache-first strategy with network fallback

### Web Manifest (manifest.json)

```json
{
  "name": "eMusicReader",
  "short_name": "eMusicReader",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**Installation:**
- iOS: Add to Home Screen from Safari share menu
- Android: Install prompt appears automatically
- Desktop: Chrome/Edge show install button in address bar

---

## Pattern Detection System

### Melodic Pattern Recognition

**detectPatternsFromSteps()** (lines 2871-2915):

**Algorithm:**
1. Iterate through note sequence with sliding window (length 3-26)
2. For each window, create string key from note letters (e.g., "cdedc")
3. Track positions where pattern appears
4. Filter out patterns with <2 occurrences
5. Remove overlapping occurrences (greedy algorithm)

**Example:**
```
Notes:  c d e d c | g a b a g | c d e d c
Steps:  "cdedc"   "gabag"     "cdedc"
Result: { "cdedc": { length: 5, positions: [0, 10] } }
```

**detectDescendingPatterns()** (lines 1998-2023):
- Same algorithm but using pitch direction signs
- Creates patterns from 'U' (up), 'D' (down), 'S' (same)
- Example: "UDDDSU" = up, three downs, same, up

### Pattern Grouping

**groupSimilarPhrases()** (lines 2066-2082):
- Uses Levenshtein distance algorithm
- Groups patterns within 30% edit distance
- Consolidates similar melodies (e.g., "cde" and "cdedc")

**findWinningPatterns()** (lines 2084-2097):
- Selects longest pattern from each group
- Limits to max 20 notes for display clarity
- Stores in `winningGroups` array

### Visual Pattern Display

**showWinningBoxes()** (lines 2099-2107):
- Draws dashed boxes around detected patterns
- Green border for "winning" (most significant) patterns
- Updates on zoom, file load, or detection re-run

---

## Data Flow

### Complete App Lifecycle

```
1. INITIALIZATION
   └─ init()
      ├─ Register pointer events
      ├─ Load library from localStorage
      └─ loadDefaultFile()

2. FILE LOADING
   └─ fileHandler() or drag-and-drop
      └─ loadFile()
         ├─ Decompress .mxl (if needed)
         └─ parseAndPopulate()
            └─ populateStaffFromMusicXML()
               ├─ parseMeasureNotes() × N measures
               ├─ appendInterleavedNotes()
               │  ├─ genStaffBlock() × N notes
               │  ├─ Build noteElements[] array
               │  └─ Render to #zoomContainer
               ├─ buildCompleteTimeline()
               ├─ detectPatternsFromSteps()
               └─ (optional) tieify() + beamify()

3. USER INTERACTION
   ├─ Touch/swipe
   │  └─ touchMoveHandler()
   │     ├─ Highlight notes
   │     └─ (if aiMode active) queryChatGPT()
   │        └─ applyFingeringNumbers() or displayAnalysis()
   │
   ├─ Play button
   │  └─ playCompleteTimeline()
   │     └─ playFreqWithDuration() × N notes
   │
   └─ AI Sheet Music Generation
      └─ queryChatGPT('sheetmusic')
         ├─ sanitizeAndExtractXML()
         └─ parseAndPopulate() [loops back to #2]

4. PERSISTENCE
   └─ saveToLibrary()
      └─ localStorage.setItem('eMusicReader-library')
```

---

## Key Algorithms

### Timeline Building (buildCompleteTimeline - lines 1686-1731)

Converts measure-relative timing to global timeline:

```javascript
// For each measure:
let globalTime = 0;
for (let measureIdx = 0; measureIdx < timelineByMeasure.length; measureIdx++) {
  // Add measure notes to global timeline
  timelineByMeasure[measureIdx].forEach(note => {
    musicTimeline.push({
      globalTime: globalTime + note.time,
      duration: note.duration,
      pitch: note.pitch,
      noteElement: note.noteElement
    });
  });
  
  // Advance global clock by measure duration
  globalTime += measureDuration;
}
```

### Duration Conversion (getDurationFromNoteType - lines 1733-1752)

Maps MusicXML note types to beat durations:
- `whole` → 4 beats
- `half` → 2 beats
- `quarter` → 1 beat
- `eighth` → 0.5 beats
- `sixteenth` → 0.25 beats

Uses `stayTime` input (default 1 second per whole note) to convert to absolute time.

---

## Performance Optimizations

### 1. DOM Recycling
- Template elements stored in `.assets` section
- Cloned with `cloneNode(true)` to avoid repeated HTML parsing

### 2. RequestAnimationFrame Batching
- Tie/beam rendering deferred until layout is stable
- Prevents forced synchronous layout (layout thrashing)

### 3. Oscillator Management
- Hard limit of 100 concurrent oscillators
- Automatic cleanup at 80% capacity
- Prevents memory leaks and browser crashes

### 4. Event Debouncing
- Pinch zoom updates throttled to animation frames
- Pattern detection only runs after file load

### 5. Lazy Loading
- AudioContext created only when first playing audio
- AI API calls only when modes are activated

---

## Browser Compatibility

### Required Features
- ES6+ JavaScript (arrow functions, template literals, `async`/`await`)
- CSS Custom Properties
- Pointer Events API
- Web Audio API
- Service Workers (for PWA)
- IndexedDB / localStorage

### Tested Browsers
- ✅ Chrome/Edge 90+ (desktop and mobile)
- ✅ Safari 14+ (iOS and macOS)
- ✅ Firefox 88+
- ❌ Internet Explorer (not supported)

### iOS Specific Handling
- AudioContext suspended by default (requires user gesture)
- Pinch-zoom gesture conflicts resolved
- Meta tags for home screen installation
- `touch-action: pan-y` to prevent scroll bounce

---

## Storage and Limits

### LocalStorage Schema

**Library Entry:**
```javascript
{
  name: "Song Name",
  data: "<?xml version...",  // Raw MusicXML string
  steps: ['c', 'd', 'e', ...] // Note sequence for search
}
```

**API Key:**
```javascript
localStorage.getItem('chatgpt-api-key') // Encrypted user API key
```

### Size Limits
- **localStorage**: ~5-10MB (browser-dependent)
- **MusicXML files**: Typically 50KB-500KB per song
- **Estimated capacity**: 20-100 songs before hitting storage limits

---

## Security Considerations

1. **API Key Storage**: Stored in localStorage (not secure for production - should use backend proxy)
2. **XML Parsing**: Uses DOMParser (built-in XSS protection)
3. **CSP**: No Content-Security-Policy headers (should add for production)
4. **HTTPS**: Required for Service Worker registration
5. **CORS**: ChatGPT API requires CORS headers (OpenAI allows browser requests)

---

## Future Enhancements (from TODO comments)

### Planned Features (lines 2-24)
- [ ] Dotted note support
- [ ] Rest symbols
- [ ] Accidentals (sharp, flat, natural)
- [ ] Clef rendering
- [ ] Key signature display
- [ ] Lyrics below staff
- [ ] Chord symbols above staff
- [ ] Real-time MIDI note listening
- [ ] File save/export
- [ ] Font size editor

### Potential Improvements
- Backend API proxy for ChatGPT (hide API keys)
- MIDI file export
- Multi-voice rendering improvements
- Collaborative annotation features
- Tempo control for playback
- Loop selection for practice mode
- Audio recording/export
- Database backend for unlimited library size

---

## Deployment

### Static Hosting
The app can be deployed to any static host:
- GitHub Pages
- Netlify
- Vercel
- Replit (current setup)
- AWS S3 + CloudFront

### Replit Configuration
- **server.js**: Simple Express static file server
- **Run command**: `node server.js`
- **Port**: 5000 (required for Replit webview)
- **Deployment type**: Autoscale (recommended)

### Production Checklist
- [ ] Add Content-Security-Policy headers
- [ ] Configure cache headers for static assets
- [ ] Minify CSS/JavaScript (optional - already single-file)
- [ ] Add error tracking (e.g., Sentry)
- [ ] Set up backend API proxy for ChatGPT
- [ ] Add user authentication for library sync
- [ ] Configure CDN for global distribution

---

## Code Organization

### File Structure
```
/
├── index.html              # Main application (3,122 lines)
│   ├── Lines 1-574:       CSS styles and assets
│   ├── Lines 575-743:     HTML structure
│   ├── Lines 745-3122:    JavaScript application logic
├── jszip.min.js           # ZIP decompression library
├── service-worker.js      # PWA caching logic
├── manifest.json          # PWA metadata
├── server.js              # Development server (Replit)
├── ddd.xml                # Default demo song
├── icons/
│   ├── icon-192.png       # PWA icon (small)
│   └── icon-512.png       # PWA icon (large)
└── docs/
    └── MusicXML_4.1_Schema.xsd  # MusicXML reference
```

### JavaScript Structure (logical sections)
1. **Global Variables** (745-810)
2. **File Loading** (843-904)
3. **AI Integration** (906-1011)
4. **Initialization** (1013-1086)
5. **Zoom Controls** (1087-1129)
6. **Rendering** (1148-1392, 2644-2715)
7. **MusicXML Parsing** (1394-1638)
8. **Audio Timeline** (1640-1752)
9. **Audio Playback** (2203-2642)
10. **Touch Gestures** (2718-2869)
11. **Pattern Detection** (2871-3012)
12. **UI Controls** (2129-2573)
13. **Page Navigation** (2914-3012)
14. **Library Management** (3014-3122)

---

## Summary

eMusicReader demonstrates how a complete music notation application can be built using only web platform APIs. The monolithic architecture prioritizes simplicity and offline functionality over modularity, making it ideal for a PWA that works seamlessly across devices without requiring a backend server or build tools.

The app's key innovation is its touch-first interaction model combined with AI-powered musical analysis, creating an educational tool for musicians to study, practice, and understand sheet music on mobile devices.
