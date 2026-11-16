// ========== AUTOENCODER PANEL (bottom-right overlay) ==========
// Shows how the current chord's 3D coordinate is produced: the 15D input runs
// through the encoder (15 -> 64 -> 32 -> 3) live, in this process, and the three
// latent units ARE the position of the sphere in the scene. A second view puts
// the theoretical TPS distance next to the distance the model actually kept,
// which is the whole point of the regularizer the model was trained with.
//
// The forward pass runs here rather than being baked into the embedding table:
// the whole autoencoder is 6,406 parameters (~79 KB of JSON), while storing
// every hidden activation for all 159,744 table entries would be >130 MB. It
// also means the panel can draw chords that are not in the table at all.
//
// data/trace_model.json is produced by scripts/export_model_weights.py, which
// refuses to export unless the checkpoint reproduces embedding_table_v2.json.

const AE_W = 380, AE_H = 250;          // logical panel size (px)
const AE_H_FORWARD = 212;              // the forward view ends at the latent readout
                                       // (the TPS comparison lives in the move panel above)
const AE_SCALE = { panel: 1, expanded: 2.2 };
const AE_ANIM_MS = 700;

let aeModel = null;             // {m2:{...}, m0:{...}} weight arrays
let aeCanvas = null, aeCtx = null;
let aeState = 'panel';          // 'panel' | 'expanded'
let aeView = 'forward';         // 'forward' | 'tension'
let aeVisible = true;
let aeDirty = true;
let aeAnimStart = 0;
let aeLastIndex = -1;
let aeHover = null;             // {col, i} hovered neuron (expanded only)
let aeHitRegions = [];          // [{x,y,w,h,action}] in logical px
let aeFabric = null;            // cached low-alpha edge fabric
let aeFabricKey = '';
let aeWarned = false;
let aeColors = {};
let aeColorKey = '';

// ---- network geometry (logical px) ----
const AE_COLS = [
    { n: 15, x: 26,  span: 120, r: 2.9,  lab: '15' },
    { n: 64, x: 82,  span: 128, r: 0.95, lab: '64' },
    { n: 32, x: 138, span: 126, r: 1.7,  lab: '32' },
    { n: 3,  x: 190, span: 40,  r: 5.5,  lab: '3' },
    { n: 32, x: 242, span: 126, r: 1.7,  lab: '32' },
    { n: 64, x: 298, span: 128, r: 0.95, lab: '64' },
    { n: 15, x: 354, span: 120, r: 2.9,  lab: '15' }
];
const AE_CY = 96;
const AE_LAYERS = [
    ['encoder.0.weight', 64, 15], ['encoder.2.weight', 32, 64], ['encoder.4.weight', 3, 32],
    ['decoder.0.weight', 32, 3],  ['decoder.2.weight', 64, 32], ['decoder.4.weight', 15, 64]
];
const AE_PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function aeNodeY(col, i) {
    const c = AE_COLS[col];
    return c.n === 1 ? AE_CY : AE_CY - c.span / 2 + (i * c.span) / (c.n - 1);
}

// ---------------------------------------------------------------- model math
function aeAffine(w, b, x, outDim, inDim) {
    const y = new Float32Array(outDim);
    for (let o = 0; o < outDim; o++) {
        let s = b[o];
        const off = o * inDim;
        for (let i = 0; i < inDim; i++) s += w[off + i] * x[i];
        y[o] = s;
    }
    return y;
}
function aeRelu(v) {
    const y = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) y[i] = v[i] > 0 ? v[i] : 0;
    return y;
}

// The 15D input convention of embedding_table_v2.json (asserted by the export
// script): root 1.0, an inversion bass 0.75, other chord tones 0.5; the root's
// position on the circle of fifths as sin/cos; duration frozen at one beat.
function aeEncodeInput(key) {
    const x = new Float32Array(15);
    for (const pc of key.pcs) x[pc] = 0.5;
    if (key.bass !== key.root) x[key.bass] = 0.75;
    x[key.root] = 1.0;
    const a = 2 * Math.PI * key.root / 12;
    x[12] = Math.sin(a);
    x[13] = Math.cos(a);
    x[14] = Math.log(2);
    return x;
}

function aeForward(modelKey, key) {
    const m = aeModel && aeModel[modelKey];
    if (!m) return null;
    const x = aeEncodeInput(key);
    const h1 = aeRelu(aeAffine(m['encoder.0.weight'], m['encoder.0.bias'], x, 64, 15));
    const h2 = aeRelu(aeAffine(m['encoder.2.weight'], m['encoder.2.bias'], h1, 32, 64));
    const z = aeAffine(m['encoder.4.weight'], m['encoder.4.bias'], h2, 3, 32);
    const out = { x, h1, h2, z };
    if (m['decoder.0.weight']) {
        out.g1 = aeRelu(aeAffine(m['decoder.0.weight'], m['decoder.0.bias'], z, 32, 3));
        out.g2 = aeRelu(aeAffine(m['decoder.2.weight'], m['decoder.2.bias'], out.g1, 64, 32));
        out.xh = aeAffine(m['decoder.4.weight'], m['decoder.4.bias'], out.g2, 15, 64);
    }
    return out;
}

// TPS target, mirroring data/chord_dataset.py - shared with the move panel
// (tpsFrameTerms in chords.js), so both show the same j and k.
const aeTps = (a, b) => tpsFrameTerms(a, b);

function aeChordKey(chord) {
    return transposedChordKey(chord.root, chord.bass, chord.pcs, chord.bar);
}

function aeSpearman(xs, ys) {
    const n = xs.length;
    if (n < 3) return NaN;
    const rank = (v) => {
        const idx = v.map((val, i) => [val, i]).sort((p, q) => p[0] - q[0]);
        const r = new Array(n);
        let i = 0;
        while (i < n) {
            let j = i;
            while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
            const avg = (i + j) / 2 + 1;
            for (let t = i; t <= j; t++) r[idx[t][1]] = avg;
            i = j + 1;
        }
        return r;
    };
    const a = rank(xs), b = rank(ys);
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db || 1);
}

// ------------------------------------------------------------------- colours
function aeSyncColors() {
    const key = isLightBg() ? 'light' : 'dark';
    if (key === aeColorKey) return;
    aeColorKey = key;
    // The panel sits ON the starfield rather than in a chrome box: barely-there
    // ground, no border. Text and marks carry the readability instead, so the
    // ink/dim steps are pushed a little brighter than the chrome version was.
    aeColors = key === 'light'
        ? { ink: '#22211e', dim: '#6e6c66', faint: '#a5a39c', accent: '#22211e',
            latent: '#0f6c7e', tps: '#96580b', neg: '#b8425c', ok: '#247a4d',
            line: '#d6d3cb', ground: 'rgba(250,249,246,0.30)', fabric: 0.09 }
        : { ink: '#e8e9f0', dim: '#8d8fa0', faint: '#5d5f70', accent: '#e8e9f0',
            latent: '#6fdff0', tps: '#f5ab5e', neg: '#e88a9b', ok: '#6ed49b',
            line: '#2a2a3a', ground: 'rgba(6,6,15,0.26)', fabric: 0.07 };
    aeFabric = null;
    aeDirty = true;
}

function aeRgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// -------------------------------------------------------------------- canvas
function aeLogicalSize() {
    return [AE_W, aeH()];
}
const aeH = () => (aeView === 'forward' ? AE_H_FORWARD : (aeState === 'expanded' ? AE_H : 166));

function aeResize() {
    if (!aeCanvas) return;
    const [lw, lh] = aeLogicalSize();
    const scale = AE_SCALE[aeState] || 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale;
    aeCanvas.width = Math.round(lw * dpr);
    aeCanvas.height = Math.round(lh * dpr);
    aeCanvas.style.width = '100%';
    aeCanvas.style.height = 'auto';
    aeCanvas._dpr = dpr;
    aeFabric = null;
    aeDirty = true;
}

function aeRoundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
}

function aeText(s, x, y, o) {
    o = o || {};
    const size = o.size || 8, weight = o.weight || 400;
    aeCtx.font = `${weight} ${size}px "IBM Plex Mono", Consolas, monospace`;
    aeCtx.fillStyle = o.color || aeColors.dim;
    aeCtx.textAlign = o.align || 'left';
    aeCtx.textBaseline = 'alphabetic';
    aeCtx.fillText(s, x, y);
}

// --------------------------------------------------------------- edge fabric
function aeBuildFabric() {
    const dpr = aeCanvas._dpr;
    const cv = document.createElement('canvas');
    cv.width = AE_W * dpr;
    cv.height = AE_H_FORWARD * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.lineWidth = 0.35;
    const m = aeModel.m2;
    for (let L = 0; L < AE_LAYERS.length; L++) {
        const [key, outN, inN] = AE_LAYERS[L];
        const w = m[key];
        if (!w) continue;
        const base = aeColors.fabric * (L >= 3 ? 0.5 : 1);
        for (let o = 0; o < outN; o++) {
            const y2 = aeNodeY(L + 1, o), x2 = AE_COLS[L + 1].x;
            for (let i = 0; i < inN; i++) {
                const a = base * Math.min(1, Math.abs(w[o * inN + i]) / 1.1);
                if (a < 0.006) continue;
                g.strokeStyle = aeRgba(aeColors.ink, a);
                g.beginPath();
                g.moveTo(AE_COLS[L].x, aeNodeY(L, i));
                g.lineTo(x2, y2);
                g.stroke();
            }
        }
    }
    return cv;
}

function aeTopContribs(w, act, outN, inN, K) {
    const arr = [];
    for (let o = 0; o < outN; o++) {
        const off = o * inN;
        for (let i = 0; i < inN; i++) {
            const c = w[off + i] * act[i];
            if (c !== 0) arr.push([Math.abs(c), c, i, o]);
        }
    }
    arr.sort((a, b) => b[0] - a[0]);
    return arr.slice(0, K);
}

// ------------------------------------------------------------------ chrome
function aeHeader(title, right) {
    aeHitRegions = [];
    aeText(title, 12, 16, { size: 8.5, weight: 600, color: aeColors.ink });
    if (right) aeText(right, AE_W - 12, 16, { size: 7.5, color: aeColors.faint, align: 'right' });
}

// -------------------------------------------------------------- forward view
function aeDrawForward(chord, prev, p) {
    const key = aeChordKey(chord);
    const f = aeForward('m2', key);
    if (!f) return;

    // The panel must agree with the table the scene is drawn from; if it ever
    // does not, the table and the checkpoint have drifted apart.
    if (!aeWarned) {
        const err = Math.max(
            Math.abs(f.z[0] - chord.coords[0]),
            Math.abs(f.z[1] - chord.coords[1]),
            Math.abs(f.z[2] - chord.coords[2]));
        if (err > 1e-2) {
            aeWarned = true;
            console.warn(`aeviz: live encoder output disagrees with embedding_table_v2.json `
                + `by ${err.toFixed(4)} - re-run scripts/export_model_weights.py`);
        }
    }

    aeHeader(`AUTOENCODER · ${chord.label}`, 'M2 λ=1.0');

    if (!aeFabric || aeFabricKey !== aeColorKey) {
        aeFabric = aeBuildFabric();
        aeFabricKey = aeColorKey;
    }
    aeCtx.save();
    aeCtx.globalAlpha = 0.9;
    aeCtx.drawImage(aeFabric, 0, 0, AE_W, AE_H_FORWARD);
    aeCtx.restore();

    const m = aeModel.m2;
    const acts = [f.x, f.h1, f.h2, f.z, f.g1, f.g2, f.xh];
    const stages = [
        [0, 'encoder.0.weight', f.x, 64, 15, 46],
        [1, 'encoder.2.weight', f.h1, 32, 64, 56],
        [2, 'encoder.4.weight', f.h2, 3, 32, 40],
        [3, 'decoder.0.weight', f.z, 32, 3, 24],
        [4, 'decoder.2.weight', f.g1, 64, 32, 30],
        [5, 'decoder.4.weight', f.g2, 15, 64, 30]
    ];
    for (const [L, wkey, act, outN, inN, K] of stages) {
        if (!act) continue;
        const lo = L / 7, hi = (L + 1.6) / 7;
        const local = Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
        if (local <= 0) continue;
        const dec = L >= 3;
        const top = aeTopContribs(m[wkey], act, outN, inN, K);
        const maxC = top.length ? top[0][0] : 1;
        aeCtx.lineWidth = dec ? 0.4 : 0.55;
        for (const [mag, sign, i, o] of top) {
            const a = (mag / maxC) * local * (dec ? 0.3 : 0.72);
            if (a < 0.02) continue;
            aeCtx.strokeStyle = aeRgba(sign > 0 ? aeColors.accent : aeColors.neg, a);
            aeCtx.beginPath();
            aeCtx.moveTo(AE_COLS[L].x, aeNodeY(L, i));
            aeCtx.lineTo(AE_COLS[L + 1].x, aeNodeY(L + 1, o));
            aeCtx.stroke();
        }
    }

    // hovered neuron: light up its strongest incoming weights (expanded only)
    if (aeHover && aeHover.col > 0 && aeHover.col <= 3) {
        const L = aeHover.col - 1;
        const [wkey, outN, inN] = AE_LAYERS[L];
        const w = m[wkey];
        const row = [];
        for (let i = 0; i < inN; i++) row.push([Math.abs(w[aeHover.i * inN + i]), w[aeHover.i * inN + i], i]);
        row.sort((a, b) => b[0] - a[0]);
        const mx = row[0][0] || 1;
        aeCtx.lineWidth = 0.9;
        for (const [mag, sign, i] of row.slice(0, 10)) {
            aeCtx.strokeStyle = aeRgba(sign > 0 ? aeColors.accent : aeColors.neg, 0.95 * (mag / mx));
            aeCtx.beginPath();
            aeCtx.moveTo(AE_COLS[L].x, aeNodeY(L, i));
            aeCtx.lineTo(AE_COLS[aeHover.col].x, aeNodeY(aeHover.col, aeHover.i));
            aeCtx.stroke();
        }
    }

    // latent box
    const boxA = Math.max(0, Math.min(1, (p - 2 / 7) / 0.22));
    aeCtx.strokeStyle = aeRgba(aeColors.latent, 0.35 + 0.5 * boxA);
    aeCtx.lineWidth = 1;
    aeRoundRect(aeCtx, AE_COLS[3].x - 14, AE_CY - 33, 28, 66, 7);
    aeCtx.stroke();

    // nodes
    for (let L = 0; L < AE_COLS.length; L++) {
        const act = acts[L];
        if (!act) continue;
        const dec = L >= 4;
        const stageT = Math.max(0, Math.min(1, (p - L / 7) / 0.16));
        if (stageT <= 0) continue;
        let mx = 0;
        for (const v of act) mx = Math.max(mx, Math.abs(v));
        mx = mx || 1;
        for (let i = 0; i < AE_COLS[L].n; i++) {
            const v = Math.abs(act[i]) / mx;
            const y = aeNodeY(L, i);
            const isLat = L === 3;
            const col = isLat ? aeColors.latent : (dec ? aeColors.dim : aeColors.ink);
            const hot = aeHover && aeHover.col === L && aeHover.i === i;
            aeCtx.beginPath();
            aeCtx.arc(AE_COLS[L].x, y, AE_COLS[L].r * (hot ? 2.2 : 1), 0, Math.PI * 2);
            aeCtx.fillStyle = aeRgba(col, (0.09 + 0.85 * v) * stageT * (dec ? 0.65 : 1));
            aeCtx.fill();
            aeCtx.strokeStyle = aeRgba(hot ? aeColors.latent : col, (hot ? 1 : 0.28) * stageT);
            aeCtx.lineWidth = hot ? 0.8 : 0.4;
            aeCtx.stroke();
        }
        aeText(AE_COLS[L].lab, AE_COLS[L].x, 172,
            { size: 7.5, color: L === 3 ? aeColors.latent : aeColors.dim, align: 'center' });
    }

    // input dimension names; tensions are called out so the tension stage of
    // the recognizer is visible in the model's own input vector
    const tenPcs = new Set((chord.tensions || []).map(iv => (key.root + iv) % 12));
    for (let i = 0; i < 15; i++) {
        const lbl = i < 12 ? AE_PC_NAMES[i] : (i === 12 ? 'sin' : i === 13 ? 'cos' : 'dur');
        const on = f.x[i] !== 0;
        const isTen = i < 12 && tenPcs.has(i);
        aeText(lbl, 17, aeNodeY(0, i) + 1.8, {
            size: 5.2,
            color: isTen ? aeColors.tps : (on ? aeColors.ink : aeColors.faint),
            align: 'right'
        });
    }
    aeText('encoder', 82, 30, { size: 7, color: aeColors.faint, align: 'center' });
    aeText('decoder', 298, 30, { size: 7, color: aeColors.faint, align: 'center' });

    aeText('latent z =', 12, 186, { size: 7.5, color: aeColors.latent });
    aeText(`(${f.z[0].toFixed(2)}, ${f.z[1].toFixed(2)}, ${f.z[2].toFixed(2)})`,
        AE_W - 12, 186, { size: 9, weight: 600, color: aeColors.latent, align: 'right' });

}

// -------------------------------------------------------------- tension view
// Research benchmark test evaluation data exported from TRACE-Research (held-out test split)
const AE_BENCHMARK_DATA = {
    meta: {
        title: "TRACE-Research Evaluation Benchmark",
        full15_rho: 0.970,
        full15_rho_std: 0.001,
        full15_kk_rho: 0.763,
        full15_kk_std: 0.021,
        full15_triplet: 0.82,
        full15_bp_rho: 0.51,
        full15_tps_mse: 0.392,
        baseline_rho: 0.495,
        baseline_kk_rho: -0.046,
        baseline_tps_mse: 43.23
    },
    pairs: [
        {"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0.007,"m0":0.04},
        {"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0.021,"m0":0.105},{"delta":0,"m1":0,"m0":0},
        {"delta":0,"m1":0.027,"m0":0.073},{"delta":0,"m1":0.022,"m0":0.084},{"delta":0,"m1":0,"m0":0},
        {"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0,"m0":0},
        {"delta":0,"m1":0,"m0":0},{"delta":0,"m1":0.039,"m0":0.252},{"delta":0,"m1":0.047,"m0":0.093},
        {"delta":0,"m1":0.015,"m0":0.103},{"delta":1,"m1":0.23,"m0":0.387},{"delta":1,"m1":0.243,"m0":0.202},
        {"delta":2,"m1":0.41,"m0":0.269},{"delta":3,"m1":0.72,"m0":2.213},{"delta":4,"m1":0.954,"m0":0.889},
        {"delta":4,"m1":0.781,"m0":1.438},{"delta":5,"m1":1.106,"m0":0.872},{"delta":5,"m1":1.105,"m0":0.879},
        {"delta":5,"m1":1.114,"m0":1.894},{"delta":5,"m1":1.075,"m0":1.861},{"delta":5,"m1":1.089,"m0":0.755},
        {"delta":5,"m1":1.096,"m0":1.461},{"delta":5,"m1":1.09,"m0":0.93},{"delta":5,"m1":1.074,"m0":1.892},
        {"delta":5,"m1":1.099,"m0":1.987},{"delta":5,"m1":1.063,"m0":1.541},{"delta":5,"m1":1.11,"m0":0.856},
        {"delta":5,"m1":1.075,"m0":1.958},{"delta":5,"m1":1.074,"m0":1.803},{"delta":5,"m1":0.994,"m0":1.43},
        {"delta":5,"m1":1.058,"m0":2.518},{"delta":5,"m1":1.091,"m0":1.783},{"delta":5,"m1":0.843,"m0":1.165},
        {"delta":5,"m1":1.111,"m0":0.86},{"delta":5,"m1":1.131,"m0":0.782},{"delta":6,"m1":1.215,"m0":1.377},
        {"delta":6,"m1":1.191,"m0":1.378},{"delta":6,"m1":1.232,"m0":1.426},{"delta":6,"m1":1.268,"m0":1.908},
        {"delta":6,"m1":1.215,"m0":1.377},{"delta":6,"m1":1.155,"m0":0.713},{"delta":6,"m1":1.261,"m0":1.538},
        {"delta":6,"m1":1.316,"m0":1.252},{"delta":6,"m1":1.313,"m0":1.767},{"delta":6,"m1":1.212,"m0":1.956},
        {"delta":6,"m1":1.214,"m0":0.831},{"delta":6,"m1":1.282,"m0":1.785},{"delta":7,"m1":1.464,"m0":1.526},
        {"delta":8,"m1":1.472,"m0":0.997},{"delta":8,"m1":1.621,"m0":1.288},{"delta":8,"m1":1.599,"m0":1.177},
        {"delta":8,"m1":1.503,"m0":1.267},{"delta":8,"m1":1.534,"m0":2.009},{"delta":8,"m1":1.603,"m0":1.236},
        {"delta":8,"m1":1.583,"m0":0.879},{"delta":8,"m1":1.517,"m0":1.094},{"delta":8,"m1":1.444,"m0":1.897},
        {"delta":8,"m1":1.603,"m0":1.231},{"delta":8,"m1":1.523,"m0":0.793},{"delta":10,"m1":1.443,"m0":0.733},
        {"delta":11,"m1":2.261,"m0":1.095},{"delta":11,"m1":2.279,"m0":0.635},{"delta":12,"m1":1.951,"m0":1.014},
        {"delta":12,"m1":2.554,"m0":0.232}
    ]
};

// Compact mode: condense content, highlight the essential figures clearly
function aeDrawTensionCompact(chord, prev, p) {
    aeHeader('TENSION CONSTRAINT', 'TEST ρ +0.97');

    if (!prev) {
        aeText('first chord — awaiting transition', AE_W / 2, 85,
            { size: 8, color: aeColors.faint, align: 'center' });
        return;
    }

    const t = aeTps(aeChordKey(prev), aeChordKey(chord));
    const d = euclideanDistance(prev.coords, chord.coords);
    const res = d - t.delta;
    const a = Math.min(1, p / 0.5);

    // Transition header
    aeText(`${prev.label} → ${chord.label}`, 16, 36,
        { size: 9, weight: 600, color: aeColors.ink });
    const statusText = Math.abs(res) < 0.5 ? 'close agreement' : (res < 0 ? 'closer than theory' : 'further than theory');
    aeText(statusText, AE_W - 16, 36, { size: 7.5, color: aeColors.dim, align: 'right' });

    // Two prominent metric cards
    // 1. Theory card
    aeCtx.fillStyle = aeRgba(aeColors.ground, 0.6);
    aeRoundRect(aeCtx, 16, 46, 168, 54, 3);
    aeCtx.fill();
    aeCtx.strokeStyle = aeRgba(aeColors.line, 0.7);
    aeCtx.stroke();

    aeText('δ THEORY (TPS)', 26, 59, { size: 7.5, weight: 600, color: aeColors.tps });
    aeText(t.delta.toFixed(2), 26, 78, { size: 18, weight: 700, color: aeColors.tps });
    aeText(`j: ${t.j} (5ths) + k: ${t.k} (tones)`, 26, 92, { size: 7, color: aeColors.dim });

    // 2. Model card
    aeCtx.fillStyle = aeRgba(aeColors.ground, 0.6);
    aeRoundRect(aeCtx, 196, 46, 168, 54, 3);
    aeCtx.fill();
    aeCtx.strokeStyle = aeRgba(aeColors.line, 0.7);
    aeCtx.stroke();

    aeText('‖Δz‖ MODEL DIST', 206, 59, { size: 7.5, weight: 600, color: aeColors.accent });
    aeText(d.toFixed(2), 206, 78, { size: 18, weight: 700, color: aeColors.accent });
    const resCol = Math.abs(res) < 1 ? aeColors.ok : aeColors.neg;
    aeText(`res ${(res >= 0 ? '+' : '') + res.toFixed(2)}  (L_TPS ${(res * res).toFixed(3)})`, 206, 92,
        { size: 7, weight: 600, color: resCol });

    // Comparative progress gauge bar
    const bx = 16, bw = 348;
    aeCtx.fillStyle = aeRgba(aeColors.line, 0.4);
    aeRoundRect(aeCtx, bx, 108, bw, 6, 2);
    aeCtx.fill();

    const tw = Math.max(2, Math.min(bw, (t.delta / 12) * bw));
    aeCtx.fillStyle = aeRgba(aeColors.tps, 0.85);
    aeRoundRect(aeCtx, bx, 108, tw * a, 6, 2);
    aeCtx.fill();

    const mw = Math.max(0, Math.min(bw, (d / 12) * bw));
    aeCtx.fillStyle = aeColors.accent;
    aeRoundRect(aeCtx, bx + mw * a - 1.5, 106, 3, 10, 1);
    aeCtx.fill();

    // Research benchmark strip
    aeCtx.strokeStyle = aeRgba(aeColors.line, 0.5);
    aeCtx.beginPath();
    aeCtx.moveTo(16, 124);
    aeCtx.lineTo(364, 124);
    aeCtx.stroke();

    aeText('TEST TPS ρ', 16, 137, { size: 7, color: aeColors.faint });
    aeText('+0.970', 16, 150, { size: 9.5, weight: 700, color: aeColors.ok });

    aeText('K&K KEY ρ', 145, 137, { size: 7, color: aeColors.faint });
    aeText('+0.763', 145, 150, { size: 9.5, weight: 700, color: aeColors.accent });

    aeText('TEST TPS MSE', 274, 137, { size: 7, color: aeColors.faint });
    aeText('0.392', 274, 150, { size: 9.5, weight: 700, color: aeColors.tps });
}

// Expanded mode: keep full mathematical breakdown and full static 2D scatter plot
function aeDrawTensionExpanded(chord, prev, p) {
    aeHeader('TENSION CONSTRAINT', 'L = L_recon + λ·L_TPS');

    const LX = 14, LR = 208;
    if (prev) {
        const t = aeTps(aeChordKey(prev), aeChordKey(chord));
        const d = euclideanDistance(prev.coords, chord.coords);
        const bx = 84, bw = 106, scale = bw / 15;
        const a = Math.min(1, p / 0.6);

        aeText(`${prev.label} → ${chord.label}`, LX, 34,
            { size: 8, weight: 600, color: aeColors.ink });

        aeText('δ theory', LX, 56, { size: 7.5, color: aeColors.tps });
        aeCtx.fillStyle = aeRgba(aeColors.tps, 0.9);
        aeCtx.fillRect(bx, 48, Math.min(bw, t.delta * scale) * a, 9);
        aeText(t.delta.toFixed(2), LR, 56, { size: 9, weight: 600, color: aeColors.tps, align: 'right' });

        aeText('‖Δz‖ model', LX, 76, { size: 7.5, color: aeColors.accent });
        aeCtx.fillStyle = aeRgba(aeColors.accent, 0.9);
        aeCtx.fillRect(bx, 68, Math.min(bw, d * scale) * a, 9);
        aeText(d.toFixed(2), LR, 76, { size: 9, weight: 600, color: aeColors.accent, align: 'right' });

        const res = d - t.delta;
        aeCtx.strokeStyle = aeRgba(aeColors.line, 1);
        aeCtx.lineWidth = 0.6;
        aeCtx.beginPath(); aeCtx.moveTo(LX, 90); aeCtx.lineTo(LR, 90); aeCtx.stroke();

        const rows = [
            ['j  fifths ring', String(t.j), aeColors.dim],
            ['k  |pcs △ pcs|', String(t.k), aeColors.dim],
            ['residual  d − δ', (res >= 0 ? '+' : '') + res.toFixed(2),
                Math.abs(res) < 1 ? aeColors.ok : aeColors.neg],
            ['L_TPS = (d − δ)²', (res * res).toFixed(3), aeColors.tps]
        ];
        rows.forEach((r, i) => {
            const y = 106 + i * 17;
            aeText(r[0], LX, y, { size: 7.5, color: aeColors.faint });
            aeText(r[1], LR, y, { size: 8.5, weight: 600, color: r[2], align: 'right' });
        });
        aeText('trained to pull d toward δ (λ=1)', LX, 190, { size: 7, color: aeColors.ok });
    } else {
        aeText('first chord — no pair yet', LX, 56, { size: 7.5, color: aeColors.faint });
    }

    // Right side: static 2D scatter benchmark plot (no chord-wipe animation)
    aeDrawScatter(234, 44, 138);
}

// 2D Scatter plot: fixed static plot from TRACE-Research held-out test benchmark
function aeDrawScatter(sx, sy, ss) {
    aeCtx.strokeStyle = aeRgba(aeColors.line, 1);
    aeCtx.lineWidth = 0.7;
    aeCtx.strokeRect(sx, sy, ss, ss);

    const b = AE_BENCHMARK_DATA;
    const pairs = b.pairs;
    const maxD = 13.5;
    const maxM = 2.85;
    const px = (v) => sx + (v / maxD) * ss;
    const py = (v) => sy + ss - (v / maxM) * ss;

    // Diagonal target reference line
    aeCtx.strokeStyle = aeRgba(aeColors.faint, 0.45);
    aeCtx.setLineDash([2, 2]);
    aeCtx.lineWidth = 0.6;
    aeCtx.beginPath();
    aeCtx.moveTo(sx, sy + ss);
    aeCtx.lineTo(sx + ss, sy);
    aeCtx.stroke();
    aeCtx.setLineDash([]);

    // Draw baseline (λ=0) points (unconstrained baseline, ρ = +0.50)
    pairs.forEach((q) => {
        aeCtx.beginPath();
        aeCtx.arc(px(q.delta), py(q.m0), 1.9, 0, Math.PI * 2);
        aeCtx.fillStyle = aeRgba(aeColors.neg, 0.45);
        aeCtx.fill();
    });

    // Draw Full15 (λ=1) points (TPS regularized, ρ = +0.97)
    pairs.forEach((q) => {
        aeCtx.beginPath();
        aeCtx.arc(px(q.delta), py(q.m1), 2.4, 0, Math.PI * 2);
        aeCtx.fillStyle = aeRgba(aeColors.accent, 0.88);
        aeCtx.fill();
    });

    aeText('‖Δz‖ / mean ↑', sx, sy - 6, { size: 7, color: aeColors.faint });
    aeText('δ (TPS) →', sx + ss, sy + ss + 11, { size: 7, color: aeColors.faint, align: 'right' });
    aeText(`${pairs.length} test pairs · held-out`, sx + ss, sy - 6, { size: 7, color: aeColors.faint, align: 'right' });

    // Legend
    let ly = sy + ss + 23;
    aeCtx.fillStyle = aeRgba(aeColors.accent, 0.95);
    aeCtx.beginPath(); aeCtx.arc(sx + 3, ly - 2.5, 2.5, 0, Math.PI * 2); aeCtx.fill();
    aeText(`Full15 (λ=1) ρ +${b.meta.full15_rho.toFixed(2)} (MSE ${b.meta.full15_tps_mse.toFixed(2)})`, sx + 9, ly,
        { size: 7.5, weight: 600, color: aeColors.ok });

    ly += 11;
    aeCtx.fillStyle = aeRgba(aeColors.neg, 0.75);
    aeCtx.beginPath(); aeCtx.arc(sx + 3, ly - 2.5, 2.0, 0, Math.PI * 2); aeCtx.fill();
    aeText(`Baseline (λ=0) ρ +${b.meta.baseline_rho.toFixed(2)} (MSE ${b.meta.baseline_tps_mse.toFixed(1)})`, sx + 9, ly,
        { size: 7.5, color: aeColors.neg });

    ly += 11;
    aeText(`K&K ρ +${b.meta.full15_kk_rho.toFixed(2)} · B&P ρ +${b.meta.full15_bp_rho.toFixed(2)}`, sx + 9, ly,
        { size: 7, color: aeColors.dim });
}

function aeDrawTension(chord, prev, p) {
    if (aeState === 'expanded') {
        aeDrawTensionExpanded(chord, prev, p);
    } else {
        aeDrawTensionCompact(chord, prev, p);
    }
}

// ------------------------------------------------------------------- driver
function markAeVizDirty() {
    if (currentIndex !== aeLastIndex) {
        aeLastIndex = currentIndex;
        aeAnimStart = performance.now();
    }
    aeDirty = true;
}

function setAeView(view) {
    if (aeView === view) return;
    aeView = view;
    document.querySelectorAll('#aeTabs .ae-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    aeResize();
    aeAnimStart = performance.now();
    aeDirty = true;
}

function toggleAeMin() {
    const panel = document.getElementById('aePanel');
    const minBtn = document.getElementById('aeMinBtn');
    const zoomBtn = document.getElementById('aeZoomBtn');
    if (!panel || !minBtn) return;

    const isMin = panel.classList.toggle('minimized');
    minBtn.innerHTML = isMin ? '+' : '&ndash;';
    minBtn.title = isMin ? 'Expand' : 'Minimise';

    if (isMin && aeState === 'expanded') {
        aeState = 'panel';
        panel.classList.remove('expanded');
        if (zoomBtn) {
            zoomBtn.innerHTML = '&#x2922;';
            zoomBtn.title = 'Maximize';
        }
    }

    if (!isMin) {
        aeResize();
        aeAnimStart = performance.now();
        aeDirty = true;
    }
}

function toggleAeZoom() {
    const panel = document.getElementById('aePanel');
    const zoomBtn = document.getElementById('aeZoomBtn');
    const minBtn = document.getElementById('aeMinBtn');
    if (!panel || !zoomBtn) return;

    // If currently minimized, expand first
    if (panel.classList.contains('minimized')) {
        panel.classList.remove('minimized');
        if (minBtn) {
            minBtn.innerHTML = '&ndash;';
            minBtn.title = 'Minimise';
        }
    }

    if (aeState === 'expanded') {
        aeState = 'panel';
        panel.classList.remove('expanded');
        zoomBtn.innerHTML = '&#x2922;';
        zoomBtn.title = 'Maximize';
    } else {
        aeState = 'expanded';
        panel.classList.add('expanded');
        zoomBtn.innerHTML = '&#x2921;';
        zoomBtn.title = 'Restore';
        requestAnimationFrame(() => {
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }
    aeResize();
    aeAnimStart = performance.now();
    aeDirty = true;
}

function bindAePanel() {
    const minBtn = document.getElementById('aeMinBtn');
    const zoomBtn = document.getElementById('aeZoomBtn');
    const tabs = document.querySelectorAll('#aeTabs .ae-tab-btn');

    if (minBtn) {
        minBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAeMin();
        };
    }
    if (zoomBtn) {
        zoomBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAeZoom();
        };
    }
    tabs.forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const v = btn.dataset.view;
            if (v) setAeView(v);
        };
    });
}

function updateAeViz() {
    if (!aeCanvas || !aeVisible || !aeModel) return;
    aeSyncColors();   // before the dirty check: a theme switch sets aeDirty

    const chord = progression[currentIndex];

    // Update HTML readouts
    const infoEl = document.getElementById('aeInfo');
    if (infoEl) {
        if (aeView === 'forward') {
            infoEl.textContent = chord ? `· ${chord.label}` : '';
        } else {
            infoEl.textContent = '· ρ = +0.970 benchmark';
        }
    }
    const sumChord = document.getElementById('aeSummaryChord');
    const sumZ = document.getElementById('aeSummaryZ');
    if (sumChord) sumChord.textContent = chord ? (chord.absLabel || chord.label) : '–';
    if (sumZ && chord) {
        const z = chord.coords;
        sumZ.textContent = `z = (${z[0].toFixed(2)}, ${z[1].toFixed(2)}, ${z[2].toFixed(2)})`;
    }

    const panel = document.getElementById('aePanel');
    if (panel && panel.classList.contains('minimized')) {
        aeDirty = false;
        return;
    }

    const animating = performance.now() - aeAnimStart < AE_ANIM_MS;
    if (!aeDirty && !animating) return;

    const dpr = aeCanvas._dpr;
    const [lw, lh] = aeLogicalSize();
    aeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    aeCtx.clearRect(0, 0, lw, lh);

    // No border: the panel is meant to sit in the starfield, not on top of it
    aeCtx.fillStyle = aeColors.ground;
    aeRoundRect(aeCtx, 0.5, 0.5, AE_W - 1, aeH() - 1, 6);
    aeCtx.fill();

    if (!chord) {
        aeHeader('AUTOENCODER', '15→64→32→3');
        aeText('import a MIDI file to begin', AE_W / 2, aeH() / 2,
            { size: 8, color: aeColors.faint, align: 'center' });
        aeDirty = false;
        return;
    }

    const raw = (performance.now() - aeAnimStart) / AE_ANIM_MS;
    const t = Math.max(0, Math.min(1, raw));
    const p = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const prev = currentIndex > 0 ? progression[currentIndex - 1] : null;

    if (aeView === 'forward') aeDrawForward(chord, prev, p);
    else aeDrawTension(chord, prev, p);

    aeDirty = animating;
}

// ------------------------------------------------------------- interaction
function aeEventPos(ev) {
    const r = aeCanvas.getBoundingClientRect();
    const [lw, lh] = aeLogicalSize();
    return [(ev.clientX - r.left) * (lw / r.width), (ev.clientY - r.top) * (lh / r.height)];
}

function aeOnClick(ev) {
    const [x, y] = aeEventPos(ev);
    for (const h of aeHitRegions) {
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
            const [kind, value] = h.action.split(':');
            if (kind === 'view') { setAeView(value); }
            else if (value === 'expanded') { toggleAeZoom(); }
            else if (value === 'pill') { toggleAeMin(); }
            aeAnimStart = performance.now();
            aeDirty = true;
            ev.stopPropagation();
            return;
        }
    }
}

// Per-neuron inspection is expanded-only: the panel is small enough that a
// hover target would be a couple of pixels, and the scene still owns the mouse
// everywhere outside the panel rectangle.
function aeOnMove(ev) {
    if (aeState !== 'expanded' || aeView !== 'forward') {
        if (aeHover) { aeHover = null; aeDirty = true; }
        return;
    }
    const [x, y] = aeEventPos(ev);
    let found = null;
    for (let L = 0; L < AE_COLS.length && !found; L++) {
        const c = AE_COLS[L];
        if (Math.abs(x - c.x) > 6) continue;
        for (let i = 0; i < c.n; i++) {
            if (Math.abs(y - aeNodeY(L, i)) <= Math.max(2.4, c.r + 1.2)) { found = { col: L, i }; break; }
        }
    }
    const changed = JSON.stringify(found) !== JSON.stringify(aeHover);
    aeHover = found;
    if (changed) aeDirty = true;
}

function setAeVizVisible(on) {
    aeVisible = !!on;
    const host = document.getElementById('aePanel');
    if (host) host.hidden = !on;
    aeDirty = true;
}

async function initAeViz() {
    aeCanvas = document.getElementById('aeCanvas');
    if (!aeCanvas) return;
    aeCtx = aeCanvas.getContext('2d');
    aeCanvas.addEventListener('click', aeOnClick);
    aeCanvas.addEventListener('pointermove', aeOnMove);
    aeCanvas.addEventListener('pointerleave', () => { aeHover = null; aeDirty = true; });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && aeState === 'expanded') { toggleAeZoom(); }
    });
    window.addEventListener('resize', () => { aeResize(); });
    bindAePanel();
    aeSyncColors();
    aeResize();
    try {
        aeModel = window.traceAPI
            ? await window.traceAPI.readJSON('trace_model.json')
            : await (await fetch('data/trace_model.json')).json();
        const n = Object.values(aeModel.m2).reduce((s, v) => s + v.length, 0);
        console.log(`Loaded autoencoder weights: ${n} parameters`
            + (aeModel.m0 ? ' (+ M0 baseline encoder)' : ''));
    } catch (e) {
        console.error('Failed to load trace_model.json:', e);
        setAeVizVisible(false);
        return;
    }
    aeDirty = true;
}
