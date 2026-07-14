// ========== CONFIG & SHARED STATE ==========

// Legacy quality colors (kept for the hidden circle-of-fifths inset)
const QUALITY_COLORS_HEX = {
    major: "#4466ff", minor: "#ff4444", dominant7: "#44cc44",
    maj7: "#ffaa44", min7: "#aa44ff", dim: "#ffaa00",
    aug: "#aa44ff", sus2: "#44aaff", sus4: "#44aaff"
};

// ---- Chord color system ----
// Step 1: chord scheme - how chords are grouped into colors
//   'function3': tonic / subdominant / dominant  (3 colors, needs estimated key)
//   'quality4' : major-type / minor-type / dominant / altered(dim+aug) (4 colors)
// Step 2: palette - three tonal variants per scheme
let chordColorMode = 'quality4';
let chordPaletteKey = 'vividBright';

const CHORD_PALETTES = {
    vividBright: {  // 高明度高饱和
        name: '亮·饱和',
        function3: { T: 0x3d9bff, S: 0x3ddc70, D: 0xff4d5e },
        quality4:  { major: 0x3d9bff, minor: 0xff4d5e, dominant: 0xffb300, altered: 0xb44dff }
    },
    softBright: {   // 高明度低饱和
        name: '亮·柔和',
        function3: { T: 0xa8c8ee, S: 0xaeddb6, D: 0xeeaab2 },
        quality4:  { major: 0xa8c8ee, minor: 0xeeaab2, dominant: 0xeed6a0, altered: 0xcfb2e6 }
    },
    vividDeep: {    // 低明度高饱和
        name: '暗·饱和',
        function3: { T: 0x1c55a8, S: 0x1f7d3d, D: 0xa02338 },
        quality4:  { major: 0x1c55a8, minor: 0xa02338, dominant: 0xa87310, altered: 0x6c2fa8 }
    }
};

// Quality -> 4-color group (extended vocabulary)
const QUALITY_GROUP = {
    major: 'major', maj7: 'major', sus2: 'major', sus4: 'major',
    add9: 'major', maj9: 'major', maj13: 'major', maj7s11: 'major',
    maj11: 'major', maj13s11: 'major',
    minor: 'minor', min7: 'minor', min9: 'minor', min11: 'minor',
    min13: 'minor', madd9: 'minor', minMaj7: 'minor',
    dominant7: 'dominant', dom9: 'dominant', dom11: 'dominant', dom13: 'dominant',
    dom7b9: 'dominant', dom7s9: 'dominant', dom7s11: 'dominant', dom7b13: 'dominant',
    dom13s11: 'dominant',
    dim: 'altered', aug: 'altered', m7b5: 'altered', dim7: 'altered', m11b5: 'altered'
};

// Display suffixes for chord labels
const QUALITY_SUFFIX = {
    major: '', minor: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
    dominant7: '7', maj7: 'maj7', min7: 'm7', m7b5: 'm7♭5', dim7: 'dim7', minMaj7: 'mMaj7',
    dom9: '9', maj9: 'maj9', min9: 'm9', dom7b9: '7♭9', dom7s9: '7♯9',
    add9: 'add9', madd9: 'madd9',
    dom11: '11', min11: 'm11', dom7s11: '7♯11', maj7s11: 'maj7♯11',
    dom13: '13', maj13: 'maj13', min13: 'm13', dom7b13: '7♭13',
    dom13s11: '13♯11', m11b5: 'm11♭5',
    maj11: 'maj11', maj13s11: 'maj13♯11'   // diatonic re-flavors (no template needed)
};

// ---- Diatonic 7th defaulting ----
// When no 7th actually sounds, dominant-vs-major flavor is decided by the
// CURRENT KEY: e.g. F13 with no 7th in C major becomes Fmaj13 (E is diatonic).
const DOM_TO_MAJ_FLAVOR = {
    dominant7: 'maj7', dom9: 'maj9', dom11: 'maj11',
    dom13: 'maj13', dom7s11: 'maj7s11', dom13s11: 'maj13s11'
};
const MAJ_TO_DOM_FLAVOR = {
    maj7: 'dominant7', maj9: 'dom9', maj13: 'dom13', maj7s11: 'dom7s11',
    maj11: 'dom11', maj13s11: 'dom13s11'
};

function adjustSeventhFlavor(seg, bar) {
    const q = seg.quality;
    const isDom = q in DOM_TO_MAJ_FLAVOR;
    const isMaj = q in MAJ_TO_DOM_FLAVOR;
    if (!isDom && !isMaj) return q;
    const has7 = seg.pcs.includes((seg.root + 10) % 12) || seg.pcs.includes((seg.root + 11) % 12);
    if (has7) return q;   // a 7th sounds: trust the analyzer
    const k = keyAtBar(bar);
    const tonic = k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;   // relative major
    const scale = [0, 2, 4, 5, 7, 9, 11].map(iv => (iv + tonic) % 12);
    const maj7Diatonic = scale.includes((seg.root + 11) % 12);
    const b7Diatonic = scale.includes((seg.root + 10) % 12);
    if (maj7Diatonic && isDom) return DOM_TO_MAJ_FLAVOR[q];
    if (!maj7Diatonic && b7Diatonic && isMaj) return MAJ_TO_DOM_FLAVOR[q];
    return q;
}

// ---- Roman numeral degree (relative to the current key) ----
const DEGREE_NAMES = {
    0: 'I', 1: '♭II', 2: 'II', 3: '♭III', 4: 'III', 5: 'IV',
    6: '♯IV', 7: 'V', 8: '♭VI', 9: 'VI', 10: '♭VII', 11: 'VII'
};

function romanDegree(chord, k) {
    const iv = (((chord.root ?? 0) - k.tonic) % 12 + 12) % 12;
    let name = DEGREE_NAMES[iv];
    const grp = QUALITY_GROUP[chord.quality] || 'major';
    if (grp === 'minor') name = name.toLowerCase();
    if (['dim', 'dim7', 'm7b5', 'm11b5'].includes(chord.quality)) name = name.toLowerCase() + '°';
    if (chord.quality === 'aug') name += '+';
    return name;
}

// Full label including inversion slash (e.g. "Cmaj7/E")
function getChordLabel(chord) {
    const base = PITCH_NAMES[chord.root] + (QUALITY_SUFFIX[chord.quality] ?? chord.quality);
    const bass = chord.bass ?? chord.root;
    return bass !== chord.root ? `${base}/${PITCH_NAMES[bass]}` : base;
}

// ---- RNA-style roman numeral label (degree + extension figures) ----
// Case/°/+ come from romanDegree; minor-ness is implied by lowercase so
// min7 -> "ii7" (not iim7). m7b5 uses the half-diminished slash ø.
// Inversions are appended as the chord member in the bass: /3 /5 /7 ...
const RNA_SUFFIX = {
    major: '', minor: '', dim: '', aug: '',
    sus2: 'sus2', sus4: 'sus4',
    dominant7: '7', maj7: 'maj7', min7: '7', minMaj7: 'maj7',
    dim7: '7', m7b5: '7', m11b5: '11',
    dom9: '9', maj9: 'maj9', min9: '9', add9: 'add9', madd9: 'add9',
    dom7b9: '7♭9', dom7s9: '7♯9',
    dom11: '11', min11: '11', maj11: 'maj11',
    dom7s11: '7♯11', maj7s11: 'maj7♯11',
    dom13: '13', maj13: 'maj13', min13: '13', dom7b13: '7♭13',
    dom13s11: '13♯11', maj13s11: 'maj13♯11'
};
const BASS_MEMBER = {
    3: '3', 4: '3', 7: '5', 10: '7', 11: '7',
    2: '9', 5: '11', 9: '13', 6: '♭5', 8: '♯5'
};

function romanLabel(chord, k) {
    let name = romanDegree(chord, k);
    if (chord.quality === 'm7b5' || chord.quality === 'm11b5') name = name.replace('°', 'ø');
    name += RNA_SUFFIX[chord.quality] ?? (QUALITY_SUFFIX[chord.quality] ?? '');
    const bass = chord.bass ?? chord.root;
    if (bass !== chord.root) {
        const iv = ((bass - chord.root) % 12 + 12) % 12;
        name += '/' + (BASS_MEMBER[iv] ?? PITCH_NAMES[bass]);
    }
    return name;
}

// ---- Key / tonality (user-confirmed after MIDI import; auto-guess prefilled) ----
// All tension embeddings are C-based, so before the embedding-table lookup the
// (root, pcs) are transposed so the current tonic maps to C (A major -> +3).
// Minor keys align to the relative major (Am content == C major content).
const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
let keySignature = { tonic: 0, mode: 'major' };
let keyModulations = [];   // [{bar, tonic, mode}] sorted by bar

function keyAtBar(bar) {
    let k = keySignature;
    keyModulations.forEach((m) => { if (bar >= m.bar) k = m; });
    return k;
}

// Semitone shift that maps the key's pitch content onto C major's
function transposeShiftForKey(k) {
    const effectiveTonic = k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;
    return (12 - effectiveTonic) % 12;
}

function keyName(k) {
    return PITCH_NAMES[k.tonic] + (k.mode === 'minor' ? 'm' : '');
}

// Estimated tonic pitch class (kept for the function3 color scheme)
let estimatedTonic = 0;

// Scale-degree interval from tonic -> harmonic function (with chromatic fallbacks)
const FUNCTION_OF_INTERVAL = {
    0: 'T', 1: 'S', 2: 'S', 3: 'T', 4: 'T', 5: 'S',
    6: 'D', 7: 'D', 8: 'S', 9: 'T', 10: 'S', 11: 'D'
};

function chordFunction(root, quality, bar) {
    if (QUALITY_GROUP[quality] === 'dominant') return 'D';   // dominant quality is functionally D
    const tonic = bar ? keyAtBar(bar).tonic : estimatedTonic;
    const iv = (((root ?? 0) - tonic) % 12 + 12) % 12;
    return FUNCTION_OF_INTERVAL[iv] || 'T';
}

// Main lookup: chord {root, quality} -> hex color under current mode+palette
function getChordColor(chord) {
    const palette = CHORD_PALETTES[chordPaletteKey];
    if (chordColorMode === 'function3') {
        return palette.function3[chordFunction(chord.root, chord.quality, chord.bar)];
    }
    return palette.quality4[QUALITY_GROUP[chord.quality] || 'major'];
}

// Theme-aware variant: darker spheres on the white background
function getThemedChordColor(chord) {
    const c = new THREE.Color(getChordColor(chord));
    if (bgThemeKey === 'light') c.multiplyScalar(0.62);
    return c;
}

function getChordColorHexStr(chord) {
    return '#' + getThemedChordColor(chord).getHexString();
}

// ---- Comet / path color schemes ----
const COMET_SCHEMES = {
    ice:    { name: '星蓝', comet: 0xbcd0f5, flow: 0x9db4e8, tube: 0x99aadd, tubeEmissive: 0x6677cc, swatch: '#9db4e8' },
    solar:  { name: '金橙', comet: 0xf5d7a8, flow: 0xe8bc7d, tube: 0xd9b285, tubeEmissive: 0xb98a4a, swatch: '#e8bc7d' },
    violet: { name: '紫辉', comet: 0xdcc2f0, flow: 0xc39ce8, tube: 0xb391d4, tubeEmissive: 0x8a5cc0, swatch: '#c39ce8' }
};
let cometSchemeKey = 'ice';
function getCometScheme() { return COMET_SCHEMES[cometSchemeKey]; }

// ---- Background themes (canvas + background particles) ----
const BG_THEMES = {
    dark: {
        name: '深空',
        bg: 0x030308,
        starAdditive: true,
        starPalette: 'bright',     // white / ice-blue / warm tints
        starOpacityScale: 1.0,
        nebulaVisible: true,
        dustColor: 0x8899cc,
        dustOpacity: 0.35,
        bloomStrength: 0.85
    },
    light: {
        name: '纸白',
        bg: 0xe8e8ee,              // slightly gray so particles read against it
        starAdditive: false,       // additive is invisible on white
        starPalette: 'dark',       // dark gray-blue dots
        starOpacityScale: 1.0,
        nebulaVisible: false,
        dustColor: 0x34344a,
        dustOpacity: 0.45,
        bloomStrength: 0.0   // white bg exceeds the bloom threshold: full-screen
                             // bloom washes out dark lines, so disable it here
    }
};
let bgThemeKey = 'dark';
function getBgTheme() { return BG_THEMES[bgThemeKey]; }

// Star density knob: fraction of the max budget below (max = current look)
let starDensity = 1.0;

// Path line width factor: 1.0 = current thickness (slider middle)
let lineWidthFactor = 1.0;
const BASE_TUBE_RADIUS = 0.011;

// ---- Tension contrast remap (fixed sinh radial stretch around the origin) ----
// displayR = DISPLAY_SCALE * sinh(REMAP_ALPHA * r). Near the origin the slope
// is DISPLAY_SCALE * REMAP_ALPHA = 1.2x, so close chords (inversions,
// extensions) never clump; far root motion still grows but stays moderate
// (r=11 remote motion maps to ~27, vs ~67 with the old alpha=0.3/scale=5).
// Raw coords are never modified: metrics and tiers stay in model units.
const REMAP_ALPHA = 0.2;
const DISPLAY_SCALE = 6;

// Tonic I chord raw coords in C-normalized embedding space (C major triad,
// root position: key "0:0:[0, 4, 7]"). All keys transpose to C before lookup,
// so the I reference is always at this position regardless of actual key.
const TONIC_I_COORDS = [-4.34, -4.03, 0.38];

function displayCoords(c) {
    const r = Math.hypot(c[0], c[1], c[2]);
    if (r < 1e-6) return [c[0], c[1], c[2]];
    const s = DISPLAY_SCALE * Math.sinh(REMAP_ALPHA * r) / r;
    return [c[0] * s, c[1] * s, c[2] * s];
}

// ---- Tension tiers for path segments ----
// Band 1 merges inversions + extensions/quality changes (d <= 4.5, one thin
// width). Root motion splits by measured latent distance, which tracks
// circle-of-fifths remoteness: ±1-2 fifths ~5.3-7.4, ±3-4 ~8-9.5,
// ±5-6 (tritone side) ~10-11.
const TENSION_TIERS = [
    { maxD: 4.5,      widthMul: 0.3,  opacityMul: 0.45, emissiveMul: 0.15 },
    { maxD: 7.6,      widthMul: 1.0,  opacityMul: 1.0,  emissiveMul: 1.0 },
    { maxD: 9.5,      widthMul: 1.8,  opacityMul: 1.2,  emissiveMul: 2.8 },
    { maxD: Infinity, widthMul: 2.8,  opacityMul: 1.4,  emissiveMul: 5.0 }
];
function tensionTier(d) {
    return TENSION_TIERS.find(t => d <= t.maxD);
}

// Off-key (离调): any sounding pitch class outside the current key's
// relative-major scale. Off-key chords get a brighter halo.
function isOffKey(pcs, bar) {
    const k = keyAtBar(bar);
    const tonic = k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;
    return pcs.some(pc => ![0, 2, 4, 5, 7, 9, 11].includes(((pc - tonic) % 12 + 12) % 12));
}

// Fade-out: chords/lines older than this many bars start fading.
// FADE_OFF (slider max) disables fading entirely.
const FADE_OFF = 50;
const FADE_SPAN_BARS = 4;   // fade completes over this many additional bars
let fadeBars = 16;

// ---- Playback timing (read from MIDI / progression metadata) ----
// MIDI spec defaults, used only when no source provides timing:
const DEFAULT_TIMING = { bpm: 120, beatsPerBar: 4 };
let beatsPerBar = DEFAULT_TIMING.beatsPerBar;
let beatDurationMs = (60 / DEFAULT_TIMING.bpm) * 1000;
let barDurationMs = beatDurationMs * beatsPerBar;

function setTiming(newBpm, newBeatsPerBar, source) {
    if (newBpm) bpm = newBpm;
    if (newBeatsPerBar) beatsPerBar = newBeatsPerBar;
    beatDurationMs = (60 / bpm) * 1000;
    barDurationMs = beatDurationMs * beatsPerBar;
    const bpmValueEl = document.getElementById('bpmValue');
    if (bpmValueEl) bpmValueEl.textContent = bpm;
    const sliderEl = document.getElementById('bpmSlider');
    if (sliderEl) sliderEl.value = Math.min(200, Math.max(60, bpm));
    console.log(`Timing${source ? ' [' + source + ']' : ''}: ${bpm} BPM, ${beatsPerBar} beats/bar`);
}

function parseTimeSignature(str) {
    if (typeof str !== 'string') return null;
    const m = str.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (!m) return null;
    return parseInt(m[1]) * (4 / parseInt(m[2]));
}

// ---- Rendering settings ----
// Particle budget kept moderate: buffers are allocated once at these max counts;
// the density knob only changes drawRange (no realloc, no GC churn).
const RENDER_CFG = {
    bloom: { strength: 0.85, radius: 0.55, threshold: 0.3 },
    exposure: 1.1,
    maxPixelRatio: 1.5,        // cap DPR: full-res bloom on HiDPI can overload the GPU
    starLayers: [
        { count: 1600, size: 0.09, rMin: 34, rMax: 90, opacity: 0.85, twinkleSpeed: 0.9 },
        { count: 700,  size: 0.18, rMin: 30, rMax: 75, opacity: 0.65, twinkleSpeed: 1.6 },
        { count: 220,  size: 0.34, rMin: 26, rMax: 60, opacity: 0.5,  twinkleSpeed: 2.4 }
    ],
    nebulaCount: 6,
    nebulaColors: [0x3a2a7a, 0x1a3a7a, 0x0a4a5a, 0x4a1a4a, 0x24245e],
    dustCount: 450,            // cosmic dust around the embedding constellation
    cloudPerChord: 36,         // particle cloud points per active chord (sparser)
    trailFlowCount: 110        // stardust particles flowing along the trail
};

// ---- Three.js objects ----
let scene, camera, renderer, composer, bloomPass;
let activeChordSpheres = [];
let activeChordClouds = [];
let trailLine = null;
let lightFollower = null;

// ---- State ----
let embeddingTable = {};    // full (root, bass, pcs) -> coords table
let analysisSegments = []; // recognizer output (key-independent)
let midiNoteSpans = [];     // [{startBeat, endBeat, pitch}] for analysis
let progression = [];
let currentIndex = 0;
let isPlaying = false;
let bpm = DEFAULT_TIMING.bpm;
let lastBeatTime = 0;
let pausedVisualElapsedMs = null;  // elapsed-in-segment at pause; restored on resume
let mouseInteracting = false;

// Interpolation animation / camera follow
let followTarget = null;
let camSpherical = null;
let lightTarget = null;
let lightInitialized = false;

// MIDI playback
let midiNotes = [];
let midiStartTime = null;
let synth = null;
let activeNotes = {};
