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
const AE_PILL_W = 168, AE_PILL_H = 26;
const AE_SCALE = { pill: 1, panel: 1, expanded: 2.2 };
const AE_ANIM_MS = 700;

let aeModel = null;             // {m2:{...}, m0:{...}} weight arrays
let aeCanvas = null, aeCtx = null;
let aeState = 'panel';          // 'pill' | 'panel' | 'expanded'
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
    if (aeState === 'pill') return [AE_PILL_W, AE_PILL_H];
    return [AE_W, aeH()];
}
const aeH = () => (aeView === 'forward' ? AE_H_FORWARD : AE_H);

function aeResize() {
    if (!aeCanvas) return;
    const [lw, lh] = aeLogicalSize();
    const scale = AE_SCALE[aeState];
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale;
    aeCanvas.width = Math.round(lw * dpr);
    aeCanvas.height = Math.round(lh * dpr);
    aeCanvas.style.width = (lw * scale) + 'px';
    aeCanvas.style.height = (lh * scale) + 'px';
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
    if (right) aeText(right, AE_W - 44, 16, { size: 7.5, color: aeColors.faint, align: 'right' });

    // View tabs sit bottom-RIGHT: the bottom-left of both views carries a
    // readout line (the TPS residual), and the top row is taken by the title.
    const tabs = [['FORWARD', 'forward'], ['TENSION', 'tension']];
    let x = AE_W - 12 - 46 - 5 - 46;
    tabs.forEach(([label, view]) => {
        const w = 46;
        const on = aeView === view;
        aeCtx.strokeStyle = aeRgba(on ? aeColors.accent : aeColors.line, 1);
        aeCtx.lineWidth = 0.7;
        aeRoundRect(aeCtx, x, aeH() - 16, w, 12, 2);
        if (on) { aeCtx.fillStyle = aeRgba(aeColors.accent, 0.18); aeCtx.fill(); }
        aeCtx.stroke();
        aeText(label, x + w / 2, aeH() - 7, {
            size: 7, weight: on ? 600 : 400,
            color: on ? aeColors.accent : aeColors.faint, align: 'center'
        });
        aeHitRegions.push({ x, y: aeH() - 16, w, h: 12, action: 'view:' + view });
        x += w + 5;
    });

    // window controls
    const ctl = [[AE_W - 34, aeState === 'expanded' ? '⤡' : '⤢',
                  aeState === 'expanded' ? 'panel' : 'expanded'],
                 [AE_W - 18, '–', 'pill']];
    ctl.forEach(([cx, glyph, action]) => {
        aeText(glyph, cx + 5, 17, { size: 9, color: aeColors.faint, align: 'center' });
        aeHitRegions.push({ x: cx, y: 6, w: 14, h: 14, action: 'state:' + action });
    });
}

// ----------------------------------------------------------------- pill view
function aeDrawPill(chord) {
    aeCtx.fillStyle = aeColors.ground;
    aeRoundRect(aeCtx, 0.5, 0.5, AE_PILL_W - 1, AE_PILL_H - 1, 6);
    aeCtx.fill();
    aeText('15→64→32→3', 9, 17, { size: 8, weight: 600, color: aeColors.accent });
    if (chord) {
        const z = chord.coords;
        aeText(`${z[0].toFixed(1)} ${z[1].toFixed(1)} ${z[2].toFixed(1)}`,
            AE_PILL_W - 9, 17, { size: 8, color: aeColors.latent, align: 'right' });
    }
    aeHitRegions = [{ x: 0, y: 0, w: AE_PILL_W, h: AE_PILL_H, action: 'state:panel' }];
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
function aeDrawTension(chord, prev, p) {
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
        aeText('trained to pull d toward δ', LX, 190, { size: 7, color: aeColors.ok });
    } else {
        aeText('first chord — no pair yet', LX, 56, { size: 7.5, color: aeColors.faint });
    }

    aeDrawScatter(234, 44, 138, p);
}

// delta-vs-distance scatter over the whole progression, M2 against the
// unconstrained baseline. The two models' latent spaces have unrelated scales,
// so each is divided by its own mean pair distance: only the RELATIONSHIP to
// the theoretical distance is comparable, never the raw coordinates.
function aeDrawScatter(sx, sy, ss, p) {
    aeCtx.strokeStyle = aeRgba(aeColors.line, 1);
    aeCtx.lineWidth = 0.7;
    aeCtx.strokeRect(sx, sy, ss, ss);

    const pairs = aeScatterPairs();
    if (!pairs || pairs.n < 3) {
        aeText('need 3+ chords', sx + ss / 2, sy + ss / 2,
            { size: 7.5, color: aeColors.faint, align: 'center' });
        return;
    }
    const maxD = pairs.maxDelta * 1.12;
    const maxM = pairs.maxNorm * 1.12;
    const px = (v) => sx + (v / maxD) * ss;
    const py = (v) => sy + ss - (v / maxM) * ss;

    aeCtx.strokeStyle = aeRgba(aeColors.faint, 0.5);
    aeCtx.setLineDash([2, 2]);
    aeCtx.lineWidth = 0.6;
    aeCtx.beginPath();
    aeCtx.moveTo(sx, sy + ss);
    aeCtx.lineTo(sx + ss, sy);
    aeCtx.stroke();
    aeCtx.setLineDash([]);

    pairs.list.forEach((q, i) => {
        const app = Math.max(0, Math.min(1, (p - (i / pairs.n) * 0.5) / 0.5));
        if (app <= 0) return;
        if (pairs.hasM0) {
            aeCtx.beginPath();
            aeCtx.arc(px(q.delta), py(q.m0), 2.1 * app, 0, Math.PI * 2);
            aeCtx.fillStyle = aeRgba(aeColors.neg, 0.55 * app);
            aeCtx.fill();
        }
        aeCtx.beginPath();
        aeCtx.arc(px(q.delta), py(q.m2), 2.6 * app, 0, Math.PI * 2);
        aeCtx.fillStyle = aeRgba(aeColors.accent, 0.85 * app);
        aeCtx.fill();
    });

    aeText('‖Δz‖ / mean ↑', sx, sy - 6, { size: 7, color: aeColors.faint });
    aeText('δ →', sx + ss, sy + ss + 11, { size: 7, color: aeColors.faint, align: 'right' });
    aeText(`${pairs.n} pairs`, sx + ss, sy - 6, { size: 7, color: aeColors.faint, align: 'right' });

    // legend (two series must never be told apart by colour alone)
    let ly = sy + ss + 24;
    aeCtx.fillStyle = aeRgba(aeColors.accent, 0.9);
    aeCtx.beginPath(); aeCtx.arc(sx + 3, ly - 2.5, 2.6, 0, Math.PI * 2); aeCtx.fill();
    aeText(`M2 ρ ${pairs.rhoM2 >= 0 ? '+' : ''}${pairs.rhoM2.toFixed(2)}`, sx + 9, ly,
        { size: 7.5, weight: 600, color: pairs.rhoM2 > 0.5 ? aeColors.ok : aeColors.tps });
    if (pairs.hasM0) {
        ly += 11;
        aeCtx.fillStyle = aeRgba(aeColors.neg, 0.75);
        aeCtx.beginPath(); aeCtx.arc(sx + 3, ly - 2.5, 2.1, 0, Math.PI * 2); aeCtx.fill();
        aeText(`M0 ρ ${pairs.rhoM0 >= 0 ? '+' : ''}${pairs.rhoM0.toFixed(2)}`, sx + 9, ly,
            { size: 7.5, color: aeColors.neg });
    }
}

// Cached per progression identity - the forward passes are cheap but there is
// no reason to redo the whole piece every frame.
let _aeScatterRef = null, _aeScatterVal = null;
function aeScatterPairs() {
    if (_aeScatterRef === progression && _aeScatterVal) return _aeScatterVal;
    _aeScatterRef = progression;
    _aeScatterVal = null;
    if (!aeModel || progression.length < 4) return null;

    const hasM0 = !!aeModel.m0;
    const list = [];
    let prevKey = null, prevZ0 = null;
    for (let i = 0; i < progression.length; i++) {
        const key = aeChordKey(progression[i]);
        const z0 = hasM0 ? aeForward('m0', key).z : null;
        if (prevKey) {
            const t = aeTps(prevKey, key);
            const m2 = euclideanDistance(progression[i - 1].coords, progression[i].coords);
            const m0 = hasM0 ? Math.hypot(z0[0] - prevZ0[0], z0[1] - prevZ0[1], z0[2] - prevZ0[2]) : 0;
            list.push({ delta: t.delta, m2, m0 });
        }
        prevKey = key;
        prevZ0 = z0;
    }
    if (list.length < 3) return null;

    const mean = (sel) => list.reduce((s, q) => s + sel(q), 0) / list.length || 1;
    const m2Mean = mean(q => q.m2), m0Mean = mean(q => q.m0) || 1;
    list.forEach(q => { q.m2 /= m2Mean; q.m0 /= m0Mean; });

    _aeScatterVal = {
        list, n: list.length, hasM0,
        maxDelta: Math.max(...list.map(q => q.delta)) || 1,
        maxNorm: Math.max(...list.map(q => Math.max(q.m2, hasM0 ? q.m0 : 0))) || 1,
        rhoM2: aeSpearman(list.map(q => q.delta), list.map(q => q.m2)),
        rhoM0: hasM0 ? aeSpearman(list.map(q => q.delta), list.map(q => q.m0)) : NaN
    };
    return _aeScatterVal;
}

// ------------------------------------------------------------------- driver
function markAeVizDirty() {
    if (currentIndex !== aeLastIndex) {
        aeLastIndex = currentIndex;
        aeAnimStart = performance.now();
    }
    aeDirty = true;
}

function updateAeViz() {
    if (!aeCanvas || !aeVisible || !aeModel) return;
    aeSyncColors();   // before the dirty check: a theme switch sets aeDirty
    const animating = performance.now() - aeAnimStart < AE_ANIM_MS;
    if (!aeDirty && !animating) return;

    const dpr = aeCanvas._dpr;
    const [lw, lh] = aeLogicalSize();
    aeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    aeCtx.clearRect(0, 0, lw, lh);

    const chord = progression[currentIndex];
    if (aeState === 'pill') {
        aeDrawPill(chord);
        aeDirty = false;
        return;
    }

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
            if (kind === 'view') { aeView = value; aeResize(); }
            else { aeState = value; aeResize(); }
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
        if (e.key === 'Escape' && aeState === 'expanded') { aeState = 'panel'; aeResize(); }
    });
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
