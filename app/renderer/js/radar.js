// ========== CIRCLE-OF-FIFTHS TENSION RADAR (top-right overlay) ==========
// 12 axes in fifths order with 3 radius ticks, drawn on a transparent canvas
// so it blends into the scene (white lines on the dark theme, black on light).
// The current tonal center (relative major for minor keys - matching the
// tension reference point) is marked with a thick accent axis and rotated to
// 12 o'clock; modulations rotate the whole dial with an eased animation.
// Each chord appears on its root's axis; radius = raw model distance from
// the I-chord embedding (TONIC_I_COORDS), normalized so the piece's global
// max touches the outer ring. The last 5 chords stay visible with graduated
// fading, joined by lines; the newest segment grows in like the 3D path.

const RADAR_SIZE = 220;    // CSS pixels
const RADAR_DPR = 2;
const RADAR_TRAIL = 5;     // max chords visible at once

let _radarCtx = null;
let _radarRotation = null;   // animated dial rotation (rad); null = snap on first draw
let _radarLastIndex = -1;
let _radarHead = null;       // {toIdx, t0, dur} growing-segment animation

// Circle-of-fifths position of a pitch class (C=0, G=1, D=2, ...)
function fifthsIndex(pc) { return (pc * 7) % 12; }

function initRadar() {
    const canvas = document.getElementById('circleCanvas');
    if (!canvas) return;
    canvas.width = RADAR_SIZE * RADAR_DPR;
    canvas.height = RADAR_SIZE * RADAR_DPR;
    _radarCtx = canvas.getContext('2d');
    _radarCtx.scale(RADAR_DPR, RADAR_DPR);
}

// Tonal center shown at 12 o'clock (minor keys align to the relative major,
// the same alignment the embedding transposition uses)
function radarTopPitch() {
    const bar = progression.length ? (progression[currentIndex].bar || 1) : 1;
    const k = keyAtBar(bar);
    return k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;
}

// Raw model-space distance from the I-chord reference (cached per chord)
function radarTension(chord) {
    if (chord._radarTension === undefined) {
        chord._radarTension = euclideanDistance(chord.coords, TONIC_I_COORDS);
    }
    return chord._radarTension;
}

// ---- Radius normalization: quantile equalization blended with linear ----
// A log curve has its steepest slope near zero, so it would spread the
// near-center region (I-chord variants) and squeeze the crowded diatonic
// band even tighter. Quantile (histogram) equalization instead stretches
// wherever the piece's chords are DENSE - in-key chords fan apart on the
// dial. Blending in floor-anchored linear keeps radii metrically honest.
// RADAR_EQ_BLEND: 0 = pure linear, 1 = pure equalization.
const RADAR_EQ_BLEND = 0.65;

let _radarProgRef = null;    // stats cache key: progression array identity
let _radarSorted = [];
let _radarMin = 0, _radarMax = 1;

function radarRefreshStats() {
    if (_radarProgRef === progression) return;
    _radarProgRef = progression;
    _radarSorted = progression.map(radarTension).sort((a, b) => a - b);
    _radarMin = _radarSorted[0] ?? 0;
    _radarMax = _radarSorted[_radarSorted.length - 1] ?? 1;
    if (_radarMax - _radarMin < 1e-6) _radarMax = _radarMin + 1;
}

// tension -> [0,1] radius fraction (global over the whole piece)
function radarRadiusNorm(t) {
    const lin = (t - _radarMin) / (_radarMax - _radarMin);
    const n = _radarSorted.length;
    if (n < 2) return Math.max(0, Math.min(1, lin));
    // mid-rank of t in the sorted tensions (binary search both bounds)
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (_radarSorted[m] < t) lo = m + 1; else hi = m; }
    let lo2 = 0, hi2 = n;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (_radarSorted[m] <= t) lo2 = m + 1; else hi2 = m; }
    const rank = ((lo + lo2 - 1) / 2) / (n - 1);
    return Math.max(0, Math.min(1, (1 - RADAR_EQ_BLEND) * lin + RADAR_EQ_BLEND * rank));
}

function updateRadar() {
    if (!_radarCtx) return;
    const ctx = _radarCtx;
    ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    const light = bgThemeKey === 'light';
    const lineRGB = light ? '30,28,24' : '255,255,255';
    const accent = light ? '#22211e' : '#e8e9f0';   // chrome is greyscale; hue is for chords
    const cx = RADAR_SIZE / 2, cy = RADAR_SIZE / 2;
    const R = RADAR_SIZE / 2 - 22;
    const STEP = Math.PI / 6;

    // Dial rotation: ease toward the current tonal center via shortest path
    const target = fifthsIndex(radarTopPitch()) * STEP;
    if (_radarRotation === null) _radarRotation = target;
    let dAng = target - _radarRotation;
    dAng = ((dAng + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    _radarRotation += dAng * 0.08;

    const angleOf = (pc) => -Math.PI / 2 + fifthsIndex(pc) * STEP - _radarRotation;

    // --- Grid: 3 tick circles + 12 axes + pitch labels ---
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${lineRGB},0.16)`;
    for (let t = 1; t <= 3; t++) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * t / 3, 0, 2 * Math.PI);
        ctx.stroke();
    }
    const topPitch = radarTopPitch();
    ctx.font = '500 9.5px "IBM Plex Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let pc = 0; pc < 12; pc++) {
        const a = angleOf(pc);
        const isTonic = pc === topPitch;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.lineWidth = isTonic ? 1.5 : 1;
        ctx.strokeStyle = isTonic ? accent : `rgba(${lineRGB},0.22)`;
        ctx.stroke();

        const lx = cx + Math.cos(a) * (R + 12);
        const ly = cy + Math.sin(a) * (R + 12);
        ctx.font = isTonic ? '600 10.5px "IBM Plex Mono", Consolas, monospace' : '500 9.5px "IBM Plex Mono", Consolas, monospace';
        ctx.fillStyle = isTonic ? accent : `rgba(${lineRGB},0.55)`;
        ctx.fillText(PITCH_NAMES[pc], lx, ly);
    }

    if (progression.length === 0) return;

    // --- Chord trail (last RADAR_TRAIL chords, newest segment grows in) ---
    if (currentIndex !== _radarLastIndex) {
        if (currentIndex === _radarLastIndex + 1 && currentIndex > 0) {
            const segDurMs = (progression[currentIndex].durBeats || beatsPerBar) * beatDurationMs;
            _radarHead = {
                toIdx: currentIndex,
                t0: performance.now(),
                dur: Math.max(120, Math.min(beatDurationMs * 2, segDurMs * 0.8))
            };
        } else {
            _radarHead = null;   // manual jump / restart: appear instantly
        }
        _radarLastIndex = currentIndex;
    }

    radarRefreshStats();
    const posOf = (idx) => {
        const c = progression[idx];
        const a = angleOf(c.root);
        const r = radarRadiusNorm(radarTension(c)) * R;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };

    let headF = 1;   // growth progress of the newest segment
    if (_radarHead && _radarHead.toIdx === currentIndex) {
        const f = Math.min(1, (performance.now() - _radarHead.t0) / _radarHead.dur);
        headF = f < 0.5 ? 2 * f * f : 1 - (2 - 2 * f) ** 2 / 2;   // quad in-out
        if (f >= 1) _radarHead = null;
    }

    const start = Math.max(0, currentIndex - (RADAR_TRAIL - 1));
    const scheme = getCometScheme();

    // Connecting lines (alpha follows the older endpoint's fade)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = scheme.swatch;
    for (let i = start + 1; i <= currentIndex; i++) {
        const [x0, y0] = posOf(i - 1);
        let [x1, y1] = posOf(i);
        if (i === currentIndex && headF < 1) {
            x1 = x0 + (x1 - x0) * headF;
            y1 = y0 + (y1 - y0) * headF;
        }
        ctx.globalAlpha = 0.65 * (1 - (currentIndex - (i - 1)) / RADAR_TRAIL);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }

    // Chord dots (current one rides the growing head)
    let curX = 0, curY = 0;
    for (let i = start; i <= currentIndex; i++) {
        let [x, y] = posOf(i);
        if (i === currentIndex && headF < 1) {
            const [px, py] = posOf(i - 1);
            x = px + (x - px) * headF;
            y = py + (y - py) * headF;
        }
        const isCur = i === currentIndex;
        if (isCur) { curX = x; curY = y; }
        ctx.globalAlpha = isCur ? 1 : 0.85 * (1 - (currentIndex - i) / RADAR_TRAIL);
        ctx.fillStyle = getChordColorHexStr(progression[i]);
        ctx.beginPath();
        ctx.arc(x, y, isCur ? 5 : 3.5, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Current chord label (roman numeral) beside its dot
    const cur = progression[currentIndex];
    ctx.globalAlpha = 0.95;
    ctx.font = '600 11px "IBM Plex Mono", Consolas, monospace';
    ctx.fillStyle = getChordColorHexStr(cur);
    ctx.fillText(cur.label || '', curX, curY - 11);
    ctx.globalAlpha = 1;
}
