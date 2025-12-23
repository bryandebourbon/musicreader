# eMusicReader

## Overview

eMusicReader is a browser-based music notation reader and editor that allows users to import, view, and interact with MusicXML sheet music files. The application is built as a Progressive Web App (PWA) that runs entirely client-side, enabling offline functionality and mobile installation. Key features include touch-based phrase selection, AI-powered musical analysis and fingering suggestions via ChatGPT integration, page-based navigation, and Web Audio API-based playback.

## Recent Changes

**December 23, 2025**
- Added server-side file storage with validation for security
- Files are validated before storage to prevent corrupt or malicious content:
  - MusicXML: Validates XML structure, required elements, scans for scripts/malicious entities
  - PDF: Validates header, scans for JavaScript, auto-actions, embedded files
- Files stored permanently in Replit Object Storage (Google Cloud Storage)
- Database tracks all uploads with metadata (filename, type, size, SHA256 hash, status)
- Added mobile-friendly bottom navigation bar for iPhone/mobile devices
- Bottom bar features 6 buttons: Dark Mode, Play, Zoom, Open, Search, Menu
- Created slide-up hamburger menu with all additional controls organized in grid layout
- Top toolbar hidden on mobile (under 600px), bottom bar shown instead
- Mobile buttons sync with desktop controls for consistent state
- Added safe-area-inset support for iPhone notch/home indicator

**November 18, 2025**
- Created comprehensive technical documentation (DOCUMENTATION.md)
- Documented complete architecture, data flow, and algorithms
- Added detailed explanations of MusicXML processing, rendering, AI integration, and audio playback
- Fixed toolbar to stay in single horizontal row with horizontal scrolling
- Added swipe selection toggle button with red glow indicator
- Fixed sheet music scrolling to vertical-only (no horizontal scrolling)
- Centered sheet music content and aligned edges with viewport boundaries
- Removed bottom padding to maximize visible sheet music area
- Changed swipe selection to be disabled by default (must be manually enabled)

**November 16, 2025**
- Cloned repository from GitHub (bryandebourbon/eMusicReader)
- Set up Express web server for Replit hosting
- Configured workflow to serve app on port 5000
- Verified all features working (MusicXML loading, UI controls, sheet music rendering)

## User Preferences

Preferred communication style: Simple, everyday language.
GitHub repository: https://github.com/bryandebourbon/eMusicReader

## System Architecture

### Frontend Architecture

**Single-Page Static Application**
- The entire application is contained in `index.html` with embedded JavaScript and CSS
- No build process or bundler required - pure HTML/CSS/JS architecture
- All processing happens client-side in the browser with no backend server required (Express server is only for local development)

**Progressive Web App (PWA)**
- Service worker (`service-worker.js`) caches core assets for offline functionality
- Web manifest (`manifest.json`) enables installation on mobile and desktop devices
- Cache-first strategy for assets with fallback to network requests
- Provides native app-like experience on mobile devices

**Touch-Optimized Interface**
- Swipe gestures for phrase selection across musical staffs
- Page-based navigation with arrow controls (scrolling disabled to prevent gesture conflicts)
- Each page spans exactly one screen height for consistent viewing
- Viewport locked to prevent pinch-zoom (user-scalable=no)

### Music File Processing

**MusicXML Import**
- Supports both `.musicxml` (uncompressed XML) and `.mxl` (compressed/zipped) formats
- JSZip library (`jszip.min.js`) bundled locally to handle decompression of `.mxl` files in-browser
- Drag-and-drop or file picker interface for importing scores
- All parsing and rendering happens client-side without server round-trips

**Planned Feature Support** (per TODO comments)
- Dotted notes, rests, accidentals (natural, sharps, flats)
- Clefs and key signatures
- Note playback via Web Audio API
- Lyrics display below staff
- Chord symbols above staff
- Real-time note listening and plotting

### AI Integration

**ChatGPT Modes**
- Multiple AI analysis modes selectable via dropdown interface: Technical analysis, Fingering advice, Sheet Music generation, or Off
- Visual feedback via color-changing icon based on selected mode
- Selected passages sent to ChatGPT API for context-aware responses

**Fingering Mode**
- Analyzes selected musical passages
- Returns fingering numbers that appear above notes in the score

**Technical Mode**
- Provides musical insights and music theory analysis for selected passages

**Sheet Music Generation Mode**
- Simple text input interface for song names (e.g., "Twinkle Twinkle Little Star")
- AI generates MusicXML representation of requested song
- Automatically loads generated MusicXML into the reader

### Audio Playback

**Web Audio API Integration**
- Safari iOS compatible playback implementation
- Handles suspended AudioContext state (common on iOS - requires user gesture to resume)
- Play button automatically resumes audio context if needed before playback

### Responsive Design

**Mobile-First Approach**
- Touch gesture support as primary interaction method
- Apple mobile web app meta tags for iOS home screen installation
- Theme color and status bar styling for native app appearance
- Icons provided at 192x192 and 512x512 resolutions

**Cross-Browser Compatibility**
- Web Audio API support across modern browsers including Safari
- Service worker and PWA features for modern browser ecosystem

## External Dependencies

### Third-Party Libraries

**JSZip v3.10.1**
- Bundled locally as `jszip.min.js`
- Used for client-side decompression of `.mxl` (zipped MusicXML) files
- MIT/GPLv3 dual license
- Includes Pako compression library (MIT license)

**Font Awesome 6.4.0**
- Loaded from CDN (cdnjs.cloudflare.com)
- Provides UI icons throughout the application

### APIs

**ChatGPT/OpenAI API**
- Used for AI-powered musical analysis features
- Modes: Technical analysis, Fingering suggestions, Sheet Music generation
- API calls made directly from browser to OpenAI endpoints

### Development Dependencies (package.json)

**Octokit REST (@octokit/rest v22.0.1)**
- GitHub API client used in `download-repo.js` utility script
- Used for downloading repository contents programmatically
- Not part of core application runtime

**Express v5.1.0**
- Simple static file server for local development (`server.js`)
- Serves files on port 5000 for testing
- Not required for production deployment (static site can be hosted anywhere)

### Browser APIs

**Web Audio API**
- Native browser API for audio playback
- No external library required
- Cross-platform support including iOS Safari

**Service Worker API**
- Native PWA support for caching and offline functionality

**File API**
- Drag-and-drop and file picker functionality for importing scores

### MusicXML Specification

**MusicXML 4.1 Schema**
- Reference schema stored in `docs/MusicXML_4.1_Schema.xsd`
- Used for understanding MusicXML file structure and validation
- W3C XML Schema Definition (XSD) format