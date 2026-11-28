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
        name: 'Bright, saturated',
        function3: { T: 0x3d9bff, S: 0x3ddc70, D: 0xff4d5e },
        quality4:  { major: 0x3d9bff, minor: 0xff4d5e, dominant: 0xffb300, altered: 0xb44dff }
    },
    softBright: {   // 高明度低饱和
        name: 'Bright, soft',
        function3: { T: 0xa8c8ee, S: 0xaeddb6, D: 0xeeaab2 },
        quality4:  { major: 0xa8c8ee, minor: 0xeeaab2, dominant: 0xeed6a0, altered: 0xcfb2e6 }
    },
    vividDeep: {    // 低明度高饱和
        name: 'Deep, saturated',
        function3: { T: 0x1c55a8, S: 0x1f7d3d, D: 0xa02338 },
        quality4:  { major: 0x1c55a8, minor: 0xa02338, dominant: 0xa87310, altered: 0x6c2fa8 }
    }
};

// The same three palettes on the light ("Paper") background. Darkening the
// dark-background colours left them muddy and over-saturated there, so these
// come from Tableau 10 (Stone & Maureen, 2016), a categorical set designed for
// white grounds: mid lightness, restrained saturation, distinct hue names.
//   vividBright -> Tableau 10 itself
//   softBright  -> its light companions (Tableau 20, even entries)
//   vividDeep   -> Tableau 10 at ~80% lightness, for a heavier line
const CHORD_PALETTES_LIGHT = {
    vividBright: {
        function3: { T: 0x4e79a7, S: 0x59a14f, D: 0xe15759 },
        quality4:  { major: 0x4e79a7, minor: 0xe15759, dominant: 0xf28e2b, altered: 0xb07aa1 }
    },
    softBright: {
        function3: { T: 0xa0cbe8, S: 0x8cd17d, D: 0xff9d9a },
        quality4:  { major: 0xa0cbe8, minor: 0xff9d9a, dominant: 0xffbe7d, altered: 0xd4a6c8 }
    },
    vividDeep: {
        function3: { T: 0x3e6186, S: 0x47813f, D: 0xb44647 },
        quality4:  { major: 0x3e6186, minor: 0xb44647, dominant: 0xc27222, altered: 0x8d6281 }
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
//
// This table is the ONLY place a quality is defined. Every per-quality lookup
// below (CORE_TONES, SUSPENDED_INTERVAL, QUALITY_GROUP, QUALITY_SUFFIX,
// QUALITY_MARK, RNA_SUFFIX) is derived from it, so adding a quality is one row.
//   group   4-colour scheme bucket         suffix  absolute label ("Cm7")
//   rna     roman-numeral suffix ("ii7" - minor-ness is the lowercase numeral)
//   mark    degree decoration, ° or +
const FIFTH_WEIGHT = 0.7;
const F5 = FIFTH_WEIGHT;
const CORE_QUALITIES = [
    // triads
    { quality: 'major',     tones: [[0, 1], [4, 1], [7, F5]],           group: 'major',    suffix: '',      rna: '',      mark: '' },
    { quality: 'minor',     tones: [[0, 1], [3, 1], [7, F5]],           group: 'minor',    suffix: 'm',     rna: '',      mark: '' },
    { quality: 'dim',       tones: [[0, 1], [3, 1], [6, 1]],            group: 'altered',  suffix: 'dim',   rna: '',      mark: '°' },
    { quality: 'aug',       tones: [[0, 1], [4, 1], [8, 1]],            group: 'altered',  suffix: 'aug',   rna: '',      mark: '+' },
    { quality: 'sus2',      tones: [[0, 1], [2, 1], [7, F5]],           group: 'major',    suffix: 'sus2',  rna: 'sus2',  mark: '' },
    { quality: 'sus4',      tones: [[0, 1], [5, 1], [7, F5]],           group: 'major',    suffix: 'sus4',  rna: 'sus4',  mark: '' },
    // sevenths
    { quality: 'maj7',      tones: [[0, 1], [4, 1], [7, F5], [11, 1]],  group: 'major',    suffix: 'maj7',  rna: 'maj7',  mark: '' },
    { quality: 'dominant7', tones: [[0, 1], [4, 1], [7, F5], [10, 1]],  group: 'dominant', suffix: '7',     rna: '7',     mark: '' },
    { quality: 'min7',      tones: [[0, 1], [3, 1], [7, F5], [10, 1]],  group: 'minor',    suffix: 'm7',    rna: '7',     mark: '' },
    { quality: 'minMaj7',   tones: [[0, 1], [3, 1], [7, F5], [11, 1]],  group: 'minor',    suffix: 'mMaj7', rna: 'maj7',  mark: '' },
    { quality: 'm7b5',      tones: [[0, 1], [3, 1], [6, 1], [10, 1]],   group: 'altered',  suffix: 'm7♭5',  rna: '7',     mark: '°' },
    { quality: 'dim7',      tones: [[0, 1], [3, 1], [6, 1], [9, 1]],    group: 'altered',  suffix: 'dim7',  rna: '7',     mark: '°' },
    { quality: 'dom7sus4',  tones: [[0, 1], [5, 1], [7, F5], [10, 1]],  group: 'dominant', suffix: '7sus4', rna: '7sus4', mark: '' },
    { quality: 'dom7sus2',  tones: [[0, 1], [2, 1], [7, F5], [10, 1]],  group: 'dominant', suffix: '7sus2', rna: '7sus2', mark: '' }
];
const qualityField = (field) => Object.fromEntries(CORE_QUALITIES.map(q => [q.quality, q[field]]));
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
const CORE_TONES = Object.fromEntries(CORE_QUALITIES.map(q => [q.quality, q.tones.map(t => t[0])]));

// The interval that a suspended quality puts where the 3rd would be: a quality
// with no 3rd at all, carrying a 2nd or a 4th instead. Used by the voicing
// check in analysis.js: if that pitch class only sounds an octave or more above
// the root, it is a 9th or an 11th on top of an ordinary triad, not a
// suspension, and the chord should be re-read without the sus templates.
const SUSPENDED_INTERVAL = Object.fromEntries(Object.entries(CORE_TONES)
    .filter(([, ivs]) => !ivs.includes(3) && !ivs.includes(4))
    .map(([quality, ivs]) => [quality, ivs.find(iv => iv === 2 || iv === 5)]));

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

// Quality -> 4-color group, absolute-label suffix, degree decoration
const QUALITY_GROUP = qualityField('group');
const QUALITY_SUFFIX = qualityField('suffix');
const QUALITY_MARK = qualityField('mark');

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
    const mark = QUALITY_MARK[chord.quality] || '';
    if (QUALITY_GROUP[chord.quality] === 'minor' || mark === '°') name = name.toLowerCase();
    return name + mark;
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
// The slash gives the bass's simple interval from the chord root: /2 /3 /5 ...
const RNA_SUFFIX = qualityField('rna');
const BASS_MEMBER = {
    1: '♭2', 2: '2', 3: '3', 4: '3', 5: '4', 6: '♭5',
    7: '5', 8: '♯5', 9: '6', 10: '7', 11: '7'
};

// Roman-numeral label with optional extension figures and a simple bass interval.
function romanLabel(chord, k, withTensions) {
    let name = romanDegree(chord, k);
    if (chord.quality === 'm7b5') name = name.replace('°', 'ø');
    name += RNA_SUFFIX[chord.quality] ?? (QUALITY_SUFFIX[chord.quality] ?? '');
    if (withTensions) name += tensionFigures(chord);
    const bass = chord.bass ?? chord.root;
    if (bass !== chord.root) {
        const iv = ((bass - chord.root) % 12 + 12) % 12;
        name += '/' + BASS_MEMBER[iv];
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
// (and background: the light theme has its own table)
function getChordColor(chord) {
    const palette = (bgThemeKey === 'light' ? CHORD_PALETTES_LIGHT : CHORD_PALETTES)[chordPaletteKey];
    if (chordColorMode === 'function3') {
        return palette.function3[chordFunction(chord.root, chord.quality, chord.bar)];
    }
    return palette.quality4[QUALITY_GROUP[chord.quality] || 'major'];
}

// Kept as the one entry point for themed colours; the light palette table
// already carries the theme, so nothing is scaled here any more.
function getThemedChordColor(chord) {
    return new THREE.Color(getChordColor(chord));
}

// ---- Colour management ----
// Palette colours are sRGB - they are what the sidebar dots and the HUD show.
// Three r128 has no colour management: a material colour is taken as a LINEAR
// value, and the output stage then sRGB-encodes it, which lifts and washes
// every colour (a #d5a376 amber line rendered as grey-beige 198,193,187).
// Everything that paints a palette colour into the scene converts it first.
function sceneColor(c) {
    return new THREE.Color(c).convertSRGBToLinear();
}
function getSceneChordColor(chord) {
    return getThemedChordColor(chord).convertSRGBToLinear();
}

function getChordColorHexStr(chord) {
    return '#' + getThemedChordColor(chord).getHexString();
}

// ---- Comet / path color schemes ----
const COMET_SCHEMES = {
    ice:    { name: 'Ice', comet: 0xbcd0f5, flow: 0x9db4e8, swatch: '#9db4e8' },
    solar:  { name: 'Solar', comet: 0xf5d7a8, flow: 0xe8bc7d, swatch: '#e8bc7d' },
    violet: { name: 'Violet', comet: 0xdcc2f0, flow: 0xc39ce8, swatch: '#c39ce8' }
};
let cometSchemeKey = 'ice';
function getCometScheme() { return COMET_SCHEMES[cometSchemeKey]; }

// ---- Background themes (canvas + background particles) ----
const BG_THEMES = {
    dark: {
        name: 'Deep space',
        // The colour as displayed (sRGB); sceneColor() converts it. Kept equal
        // to what the old pipeline actually showed, so the sky did not change
        // when the double tone mapping was removed (see scene.js).
        bg: 0x0c0c21,
        starsVisible: true,
        starAdditive: true,
        starPalette: 'bright',     // white / ice-blue / warm tints
        starOpacityScale: 1.0,
        nebulaVisible: true,
        dustColor: 0x8899cc,
        dustOpacity: 0.35,
        bloomStrength: 0.85
    },
    light: {
        name: 'Paper',
        bg: 0xe7e5df,              // warm grey paper: dark enough that particles read against it (displayed sRGB)
        starsVisible: false,       // dark dots on paper read as dust, not sky
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
// A tier sets only a line's WIDTH (and how present it is). Colour belongs to
// the harmony instead: each line runs from its first chord's colour to its
// second's, so in the function scheme a T -> D move is literally blue fading
// into red. Lines are flat, unlit and kept out of the bloom layer.
const TENSION_TIERS = [
    { maxD: 4.5,      widthMul: 0.45, opacityMul: 0.40 },
    { maxD: 7.6,      widthMul: 1.1,  opacityMul: 1.0 },
    { maxD: 9.5,      widthMul: 2.4,  opacityMul: 1.25 },
    { maxD: Infinity, widthMul: 4.0,  opacityMul: 1.5 }
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
let fadeBars = 8;

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
// Bloom is SELECTIVE: only objects that opt in with
// obj.layers.enable(BLOOM_LAYER) feed it (the sky's stars, the chord spheres,
// the meteor). It used to take the whole frame, so every line, landmark and
// cage edge bright enough to clear the threshold grew a halo - and a halo
// whose core has clipped comes out white whatever its hue. See scene.js.
const BLOOM_LAYER = 1;
const RENDER_CFG = {
    bloom: { strength: 0.85, radius: 0.55, threshold: 0.3 },
    exposure: 1.1,
    maxPixelRatio: 1.5,        // cap DPR: full-res bloom on HiDPI can overload the GPU
    // The sky sits OUTSIDE the boundary (whose far wall reaches ~85 from the
    // scene origin), so it still reads as backdrop rather than as debris
    // floating inside the arena. Sizes grew with the radii to keep the stars
    // the same apparent size.
    starLayers: [
        // (counts halved from 1600/700/220: the full field was too busy)
        { count: 800,  size: 0.65, rMin: 100, rMax: 260, opacity: 0.85, twinkleSpeed: 0.9 },
        { count: 350,  size: 1.20, rMin: 95,  rMax: 220, opacity: 0.70, twinkleSpeed: 1.6 },
        { count: 110,  size: 2.10, rMin: 92,  rMax: 175, opacity: 0.60, twinkleSpeed: 2.4 }
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
// Resolves once the table is in (or failed to load). Anything that looks
// chords up must wait on it: a MIDI imported during the first second or two
// after launch used to find an empty table and put every chord at the origin.
let embeddingTableReady = Promise.resolve();
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
