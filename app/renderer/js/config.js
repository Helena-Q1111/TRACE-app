// ========== CONFIG & SHARED STATE ==========

// ---- Scene scale ----
// Everything drawn INSIDE the latent space - chord spheres, their particle
// clouds, labels, path tubes, landmark beacons - is sized off this factor, and
// the camera's start distance came down with it.
//
// Why: the boundary cage's near wall is only ~13 units from the scene origin
// (44.8 at its far corner), while the camera used to orbit the current chord at
// radius 34. That put the viewpoint OUTSIDE the boundary looking in, which is
// exactly why the space read as cramped. Shrinking the contents and moving the
// camera inside makes the cage a room you are standing in. The two changes go
// together: at a third of the distance, unshrunk objects would look three times
// larger and swallow the view.
const SCENE_SCALE = 0.3;
const CAMERA_START_RADIUS = 9;
const CAMERA_MIN_RADIUS = 0.4;
// Set from the boundary once it is built (landmarks.js): the camera should not
// be able to zoom out through the wall.
let cameraMaxRadius = 45;

// ---- Boundary ----
// A REGULAR icosahedron centred on the tonic, not a hull of the chord cloud.
// The hull version hugged the music - the median chord cleared its wall by 4.4
// display units and a tenth of them by under 0.7 - so any zoom put the camera
// outside the boundary. Sizing a regular solid so its INRADIUS reaches the most
// remote chord gives an arena that actually contains the vocabulary.
//
// For a regular icosahedron inradius / circumradius = 0.7557613, and
// THREE.IcosahedronGeometry takes the CIRCUMradius, hence the division.
const ICOSA_INRADIUS_RATIO = 0.7557613;
const CAGE_MARGIN = 1.06;          // a little air beyond the furthest chord

// ---- Distance fog ----
// Depth cue for the interior: the far side of the cage and older path segments
// recede instead of crowding the near geometry. The sky (stars, nebulae, dust)
// opts OUT via material.fog = false - fogging it would just empty the sky.
const FOG_NEAR = 5;
const FOG_FAR = 95;                // the far wall of the boundary is ~85 away

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

// ---- Chord vocabulary: 14 core qualities + a separate tension layer ----
// Every quality here occurs in Hooktheory, and every extension/alteration is
// expressed by the SECOND stage instead of getting its own template. The old
// 29-template dictionary put 9/11/13 variants in the same flat list, which
// (with `opt` tones that scored for free) made big templates win over triads
// as soon as any passing tone sounded: measured on 95,423 Hooktheory segments,
// it inflated the pitch-class set on 49% of them and over-predicted maj13 by
// 926x. See scripts/eval_chord_recognition.py.
//
// Template tones are WEIGHTED, and scoring is cosine similarity, so a template
// that claims a tone which is not sounding is penalised automatically by its
// own norm - no complexity-bias constant to tune. The 5th is the one routinely
// omitted chord tone, so it carries less weight than the defining tones.
const FIFTH_WEIGHT = 0.7;
const CORE_QUALITIES = [
    // triads
    { quality: 'major',     tones: [[0, 1], [4, 1], [7, FIFTH_WEIGHT]] },
    { quality: 'minor',     tones: [[0, 1], [3, 1], [7, FIFTH_WEIGHT]] },
    { quality: 'dim',       tones: [[0, 1], [3, 1], [6, 1]] },
    { quality: 'aug',       tones: [[0, 1], [4, 1], [8, 1]] },
    { quality: 'sus2',      tones: [[0, 1], [2, 1], [7, FIFTH_WEIGHT]] },
    { quality: 'sus4',      tones: [[0, 1], [5, 1], [7, FIFTH_WEIGHT]] },
    // sevenths
    { quality: 'maj7',      tones: [[0, 1], [4, 1], [7, FIFTH_WEIGHT], [11, 1]] },
    { quality: 'dominant7', tones: [[0, 1], [4, 1], [7, FIFTH_WEIGHT], [10, 1]] },
    { quality: 'min7',      tones: [[0, 1], [3, 1], [7, FIFTH_WEIGHT], [10, 1]] },
    { quality: 'minMaj7',   tones: [[0, 1], [3, 1], [7, FIFTH_WEIGHT], [11, 1]] },
    { quality: 'm7b5',      tones: [[0, 1], [3, 1], [6, 1], [10, 1]] },
    { quality: 'dim7',      tones: [[0, 1], [3, 1], [6, 1], [9, 1]] },
    { quality: 'dom7sus4',  tones: [[0, 1], [5, 1], [7, FIFTH_WEIGHT], [10, 1]] },
    { quality: 'dom7sus2',  tones: [[0, 1], [2, 1], [7, FIFTH_WEIGHT], [10, 1]] }
];
// Deliberately NOT here, after measuring all three on the corpus:
//   power (0.16% of Hooktheory) - a two-tone template has a small norm, so it
//     wins whenever the third is merely QUIET rather than absent. It fired on
//     25% of a real MIDI's bars and turned Eb-Bb-G into "Eb5"; dropping it
//     moved exact pitch-class accuracy 87.8% -> 91.5%.
//   maj6 / min6 (<0.06%) - their pitch-class sets are identical to min7 and
//     m7b5 a third away, so they can only be told apart by the bass, and min7
//     is ~130x more common. They stole min7 detections; dropping them moved
//     accuracy 91.5% -> 92.2% and root accuracy 95.0% -> 96.3%.
// A bare fifth now reads as a major triad with the third filled in, which is
// the same bargain already made for the omitted 5th: one recognized chord maps
// to one table entry, so the 3D point does not jump between voicings.

// Core tone intervals per quality (weights dropped) - the tone set that always
// enters the embedding lookup, whether or not every member sounded. Filling in
// an omitted 5th is deliberate: it keeps one recognized chord on one table
// entry, so the 3D point does not jump between voicings of the same chord.
const CORE_TONES = (() => {
    const m = {};
    CORE_QUALITIES.forEach((q) => { m[q.quality] = q.tones.map(t => t[0]); });
    return m;
})();

// The interval that a suspended quality puts where the 3rd would be. Used by
// the voicing check in analysis.js: if that pitch class only sounds an octave
// or more above the root, it is a 9th or an 11th on top of an ordinary triad,
// not a suspension, and the chord should be re-read without the sus templates.
const SUSPENDED_INTERVAL = {
    sus2: 2, dom7sus2: 2,
    sus4: 5, dom7sus4: 5
};

// ---- Tension layer ----
// Checked against the chosen root AFTER the core quality is fixed; a tension
// counts only if it carries real weight in the segment. 7ths are deliberately
// absent: they are core qualities, so a 7th never arrives as a tension and we
// never end up labelling a triad "C(♭7)".
const TENSION_DEFS = [
    { iv: 1, sym: '♭9' },
    { iv: 2, sym: '9' },
    { iv: 3, sym: '♯9' },
    { iv: 5, sym: '11' },
    { iv: 6, sym: '♯11' },
    { iv: 8, sym: '♭13' },
    { iv: 9, sym: '13' }
];

// Quality -> 4-color group
const QUALITY_GROUP = {
    major: 'major', maj7: 'major', sus2: 'major', sus4: 'major',
    minor: 'minor', min7: 'minor', minMaj7: 'minor',
    dominant7: 'dominant', dom7sus4: 'dominant', dom7sus2: 'dominant',
    dim: 'altered', aug: 'altered', m7b5: 'altered', dim7: 'altered'
};

// Display suffixes for absolute chord labels
const QUALITY_SUFFIX = {
    major: '', minor: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
    dominant7: '7', maj7: 'maj7', min7: 'm7', minMaj7: 'mMaj7',
    m7b5: 'm7♭5', dim7: 'dim7',
    dom7sus4: '7sus4', dom7sus2: '7sus2'
};

// Tension figures, e.g. "(9,13)". Sorted by TENSION_DEFS order so the reading
// is always ♭9, 9, ♯9, 11, ♯11, ♭13, 13.
function tensionFigures(chord) {
    const t = chord.tensions;
    if (!t || t.length === 0) return '';
    const order = TENSION_DEFS.map(d => d.iv);
    const syms = t.slice()
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map(iv => (TENSION_DEFS.find(d => d.iv === iv) || {}).sym)
        .filter(Boolean);
    return syms.length ? `(${syms.join(',')})` : '';
}

// NOTE: the old adjustSeventhFlavor() was removed with the 29-template
// dictionary. It existed because templates like dom13 kept the ♭7 in `core`
// while making everything else optional, so a chord with no 7th at all could
// still come out labelled "13" and needed re-flavoring by key. Under the
// two-stage recognizer a seventh is only ever labelled when it genuinely
// sounds (it is a full-weight tone of its own core quality), so the ambiguity
// cannot arise - and re-flavoring now would desync the label from the
// pitch-class set that the lookup and the autoencoder panel both display.

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
    if (['dim', 'dim7', 'm7b5'].includes(chord.quality)) name = name.toLowerCase() + '°';
    if (chord.quality === 'aug') name += '+';
    return name;
}

// Full absolute label: root + quality + tension figures + inversion slash,
// e.g. "Cmaj7(9,13)/E". Shown in the sidebar list.
function getChordLabel(chord) {
    const base = PITCH_NAMES[chord.root] + (QUALITY_SUFFIX[chord.quality] ?? chord.quality)
        + tensionFigures(chord);
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
    dim7: '7', m7b5: '7',
    dom7sus4: '7sus4', dom7sus2: '7sus2'
};
const BASS_MEMBER = {
    3: '3', 4: '3', 7: '5', 10: '7', 11: '7',
    2: '9', 5: '11', 9: '13', 6: '♭5', 8: '♯5'
};

// Roman-numeral label. `withTensions` is off for the 3D sprites - label space
// in the scene is tight and "V7(♯11)/3" turns into mush - and on for the
// sidebar, where the full reading is useful.
function romanLabel(chord, k, withTensions) {
    let name = romanDegree(chord, k);
    if (chord.quality === 'm7b5') name = name.replace('°', 'ø');
    name += RNA_SUFFIX[chord.quality] ?? (QUALITY_SUFFIX[chord.quality] ?? '');
    if (withTensions) name += tensionFigures(chord);
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
// Deliberately NOT scaled by SCENE_SCALE. Everything else shrank by 0.3 while
// the camera came 3.8x closer, which keeps apparent size constant - but the
// path tubes were already hairlines, so the four tension tiers all collapsed
// into the 0.05-1.0 pixel range and read as one texture. At this radius the
// tiers span roughly 0.3 -> 3 pixels at the default camera distance, and the
// boldest is about 1.8x a chord sphere's radius.
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

// Inverse of displayCoords. The boundary is built directly in display space so
// that it renders as a true regular solid; this maps its corners back into
// model units so their distance ticks can be read in the same scale as the
// sidebar's d/t metrics.
function inverseDisplayCoords(c) {
    const rd = Math.hypot(c[0], c[1], c[2]);
    if (rd < 1e-6) return [c[0], c[1], c[2]];
    const r = Math.asinh(rd / DISPLAY_SCALE) / REMAP_ALPHA;
    const s = r / rd;
    return [c[0] * s, c[1] * s, c[2] * s];
}

// ---- Tension tiers for path segments ----
// Band 1 merges inversions + extensions/quality changes (d <= 4.5, one thin
// width). Root motion splits by measured latent distance, which tracks
// circle-of-fifths remoteness: ±1-2 fifths ~5.3-7.4, ±3-4 ~8-9.5,
// ±5-6 (tritone side) ~10-11.
// Width alone was doing nearly all the work and the four tiers still read as
// one texture, so each tier now also carries its own HUE, running cool -> hot
// with the size of the harmonic leap. `tint` is blended over the scheme's own
// tube colour rather than replacing it, so the user's palette still governs
// the look.
//
// emissiveMul stays modest on the hot tiers on purpose: the bloom pass has a
// 0.3 threshold, and pushing a wide tube well past it clips every channel and
// turns the line WHITE - which throws away the hue that was just added. Width
// carries the magnitude; emissive only has to keep the line legible.
const TENSION_TIERS = [
    { maxD: 4.5,      widthMul: 0.45, opacityMul: 0.40, emissiveMul: 0.15, tint: 0x5f7fbe, tintMix: 0.75 },
    { maxD: 7.6,      widthMul: 1.1,  opacityMul: 1.0,  emissiveMul: 0.8,  tint: 0x7fd4e8, tintMix: 0.35 },
    { maxD: 9.5,      widthMul: 2.4,  opacityMul: 1.25, emissiveMul: 1.5,  tint: 0xf0a04b, tintMix: 0.70 },
    { maxD: Infinity, widthMul: 4.0,  opacityMul: 1.5,  emissiveMul: 2.1,  tint: 0xff5d4d, tintMix: 0.85 }
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
    // The sky sits OUTSIDE the boundary (whose far wall reaches ~85 from the
    // scene origin), so it still reads as backdrop rather than as debris
    // floating inside the arena. Sizes grew with the radii to keep the stars
    // the same apparent size.
    starLayers: [
        { count: 1600, size: 0.20, rMin: 100, rMax: 260, opacity: 0.85, twinkleSpeed: 0.9 },
        { count: 700,  size: 0.40, rMin: 95,  rMax: 220, opacity: 0.65, twinkleSpeed: 1.6 },
        { count: 220,  size: 0.75, rMin: 92,  rMax: 175, opacity: 0.5,  twinkleSpeed: 2.4 }
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
