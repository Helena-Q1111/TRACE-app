// ========== FRONTEND CHORD ANALYSIS ==========
// Template scoring (HarmAn-style S = P - N - M) over HALF-BEAT quantized
// weighted chroma, per-bar DP segmentation (<=4 segments/bar), strict merging.
// Precision: chord boundaries resolve to half-beat positions (8th notes in x/4);
// the per-bar cap of 4 fundamentally different chords is kept as a hard limit.

// Extended template dictionary: triads, 7ths, 9/11/13 and alterations.
// core = defining tones (missing -> heavy penalty); opt = commonly omitted
// tones (5th, inner extensions) that score when present but never penalize.
// Small complexity tiebreak prefers the simplest template that explains the notes.
const CHORD_TEMPLATES = [
    // triads
    { quality: 'major',   core: [0, 4, 7],  opt: [] },
    { quality: 'minor',   core: [0, 3, 7],  opt: [] },
    { quality: 'dim',     core: [0, 3, 6],  opt: [] },
    { quality: 'aug',     core: [0, 4, 8],  opt: [] },
    { quality: 'sus2',    core: [0, 2, 7],  opt: [] },
    { quality: 'sus4',    core: [0, 5, 7],  opt: [] },
    // sevenths
    { quality: 'dominant7', core: [0, 4, 10], opt: [7] },
    { quality: 'maj7',      core: [0, 4, 11], opt: [7] },
    { quality: 'min7',      core: [0, 3, 10], opt: [7] },
    { quality: 'm7b5',      core: [0, 3, 6, 10], opt: [] },
    { quality: 'dim7',      core: [0, 3, 6, 9],  opt: [] },
    { quality: 'minMaj7',   core: [0, 3, 11], opt: [7] },
    // ninths
    { quality: 'dom9',   core: [0, 4, 10, 2], opt: [7] },
    { quality: 'maj9',   core: [0, 4, 11, 2], opt: [7] },
    { quality: 'min9',   core: [0, 3, 10, 2], opt: [7] },
    { quality: 'dom7b9', core: [0, 4, 10, 1], opt: [7] },
    { quality: 'dom7s9', core: [0, 4, 10, 3], opt: [7] },
    { quality: 'add9',   core: [0, 4, 2],     opt: [7] },
    { quality: 'madd9',  core: [0, 3, 2],     opt: [7] },
    // elevenths
    { quality: 'dom11',   core: [0, 10, 5],    opt: [7, 2, 4] },
    { quality: 'min11',   core: [0, 3, 10, 5], opt: [7, 2] },
    { quality: 'dom7s11', core: [0, 4, 10, 6], opt: [7, 2] },
    { quality: 'maj7s11', core: [0, 4, 11, 6], opt: [7, 2] },
    // thirteenths
    { quality: 'dom13',    core: [0, 4, 10, 9],    opt: [7, 2, 5] },
    { quality: 'maj13',    core: [0, 4, 11, 9],    opt: [7, 2] },
    { quality: 'min13',    core: [0, 3, 10, 9],    opt: [7, 2, 5] },
    { quality: 'dom7b13',  core: [0, 4, 10, 8],    opt: [7] },
    // Note: literal b11 (=M3) and #13 (=b7) are enharmonic duplicates of chord
    // tones in pitch-class space; the distinguishable neighbors are added instead:
    { quality: 'dom13s11', core: [0, 4, 10, 6, 9], opt: [7, 2] },   // 13#11 (Lydian dominant)
    { quality: 'm11b5',    core: [0, 3, 6, 10, 5], opt: [] }        // half-dim 11
];

const ANALYSIS_CFG = {
    gridPerBeat: 1,          // whole-beat boundary resolution (was half-beat)
    maxSegmentsPerBar: 4,    // hard cap on chord changes per bar
    segmentPenalty: 0.45,    // cost per extra segment
    missingPenalty: 0.3,     // penalty per missing CORE tone
    complexityBias: 0.02,    // slight preference for simpler templates
    rootBassBonus: 0.16,     // bonus when root == bass (raised: fewer inversions)
    inversionMinRatio: 0.55, // bass must carry this much weight (vs max) to flag inversion
    tensionKeepRatio: 0.55,  // keep a non-template tone only if this strong vs max
    metricStrong: 1.5,       // downbeat weight
    metricMid: 1.2,          // mid-bar beat weight (4/4 beat 3)
    bassBoost: 1.6           // bass pitch class weight boost
};

// notes: [{startBeat, endBeat, pitch}], returns segments:
// [{startBeat, endBeat, durBeats, bar, beatInBar, root, quality, pcs}]
function analyzeMidiToSegments(notes, bpb) {
    if (!notes || notes.length === 0) return [];
    const G = ANALYSIS_CFG.gridPerBeat;
    const totalUnits = Math.max(1, Math.ceil((Math.max(...notes.map(n => n.endBeat)) - 1e-6) * G));

    // --- Per-unit weighted chroma + bass tracking (unit = 1/G beat) ---
    const unitChroma = Array.from({ length: totalUnits }, () => new Float32Array(12));
    const unitBassPitch = new Array(totalUnits).fill(Infinity);
    notes.forEach((n) => {
        const u0 = Math.max(0, Math.floor(n.startBeat * G + 1e-6));
        const u1 = Math.min(totalUnits, Math.ceil(n.endBeat * G - 1e-6));
        for (let u = u0; u < u1; u++) {
            const ov = Math.min(n.endBeat, (u + 1) / G) - Math.max(n.startBeat, u / G);
            if (ov <= 0.03) continue;   // ignore hairline overlaps
            const beatPos = (u / G) % bpb;
            const mw = beatPos === 0 ? ANALYSIS_CFG.metricStrong
                : (bpb >= 4 && beatPos === Math.floor(bpb / 2)) ? ANALYSIS_CFG.metricMid : 1.0;
            unitChroma[u][n.pitch % 12] += ov * mw;
            if (n.pitch < unitBassPitch[u]) unitBassPitch[u] = n.pitch;
        }
    });
    for (let u = 0; u < totalUnits; u++) {
        if (unitBassPitch[u] !== Infinity) unitChroma[u][unitBassPitch[u] % 12] *= ANALYSIS_CFG.bassBoost;
    }

    // --- Score one unit range [s, e) against all (root, template) pairs ---
    function segmentInfo(s, e) {
        const w = new Float32Array(12);
        const bassTime = new Float32Array(12);   // time each pc spends as the bass
        for (let u = s; u < e; u++) {
            for (let pc = 0; pc < 12; pc++) w[pc] += unitChroma[u][pc];
            if (unitBassPitch[u] !== Infinity) bassTime[unitBassPitch[u] % 12]++;
        }
        const total = w.reduce((a, x) => a + x, 0);
        if (total < 1e-6) return { empty: true, score: 0 };
        // Dominant bass: the pc that is the lowest voice for the MOST time
        // (a fleeting low passing note no longer decides the segment's bass)
        let bassPc = -1, bassBest = 0;
        for (let pc = 0; pc < 12; pc++) {
            if (bassTime[pc] > bassBest) { bassBest = bassTime[pc]; bassPc = pc; }
        }
        const missUnit = total / 4;

        let best = null;
        for (let root = 0; root < 12; root++) {
            if (w[root] < 1e-6) continue;
            for (const tpl of CHORD_TEMPLATES) {
                const corePcs = tpl.core.map(iv => (root + iv) % 12);
                const optPcs = tpl.opt.map(iv => (root + iv) % 12);
                let P = 0, Nmiss = 0, M = 0;
                for (let pc = 0; pc < 12; pc++) {
                    if (corePcs.includes(pc)) {
                        if (w[pc] > 1e-6) P += w[pc]; else Nmiss++;   // core missing = penalized
                    } else if (optPcs.includes(pc)) {
                        if (w[pc] > 1e-6) P += w[pc];                  // optional: free to omit
                    } else {
                        M += w[pc];
                    }
                }
                let score = P - ANALYSIS_CFG.missingPenalty * Nmiss * missUnit - M
                    - ANALYSIS_CFG.complexityBias * total * ((tpl.core.length + tpl.opt.length) / 12);
                if (root === bassPc) score += ANALYSIS_CFG.rootBassBonus * total;
                if (!best || score > best.score) {
                    best = { score, root, quality: tpl.quality, tplPcs: corePcs.concat(optPcs) };
                }
            }
        }

        const maxW = Math.max(...w);
        const pcs = new Set([best.root]);
        best.tplPcs.forEach(pc => { if (w[pc] > 1e-6) pcs.add(pc); });
        for (let pc = 0; pc < 12; pc++) {
            if (!best.tplPcs.includes(pc) && w[pc] >= ANALYSIS_CFG.tensionKeepRatio * maxW) pcs.add(pc);
        }
        // Inversion: sounding bass differs from the chord root - only flagged
        // when the bass is a real template tone AND carries substantial weight
        let bass = best.root;
        if (bassPc >= 0 && bassPc !== best.root
            && best.tplPcs.includes(bassPc)
            && w[bassPc] >= ANALYSIS_CFG.inversionMinRatio * maxW) {
            bass = bassPc;
        }
        return {
            empty: false, score: best.score, root: best.root, bass: bass,
            quality: best.quality, pcs: [...pcs].sort((a, b) => a - b)
        };
    }

    // --- Per-bar DP: best split of the bar's units into <=4 segments ---
    const rawSegments = [];
    const unitsPerBar = bpb * G;
    const nBars = Math.ceil(totalUnits / unitsPerBar);
    for (let bar = 0; bar < nBars; bar++) {
        const s0 = bar * unitsPerBar;
        const B = Math.min(unitsPerBar, totalUnits - s0);
        if (B <= 0) break;

        const memo = {};
        const info = (a, b) => memo[a * 1000 + b] || (memo[a * 1000 + b] = segmentInfo(s0 + a, s0 + b));
        const whole = info(0, B);
        if (whole.empty) continue;

        let barEnergy = 0;
        for (let u = s0; u < s0 + B; u++) barEnergy += unitChroma[u].reduce((a, x) => a + x, 0);
        const lambda = ANALYSIS_CFG.segmentPenalty * (barEnergy / B) * G;

        const K = Math.min(ANALYSIS_CFG.maxSegmentsPerBar, B);
        const NEG = -1e18;
        const dp = Array.from({ length: B + 1 }, () => new Array(K + 1).fill(NEG));
        const par = Array.from({ length: B + 1 }, () => new Array(K + 1).fill(-1));
        dp[0][0] = 0;
        for (let i = 1; i <= B; i++) {
            for (let k = 1; k <= K; k++) {
                for (let j = k - 1; j < i; j++) {
                    if (dp[j][k - 1] === NEG) continue;
                    const seg = info(j, i);
                    const sc = dp[j][k - 1] + (seg.empty ? 0 : seg.score) - (k > 1 ? lambda : 0);
                    if (sc > dp[i][k]) { dp[i][k] = sc; par[i][k] = j; }
                }
            }
        }
        let bestK = 1;
        for (let k = 2; k <= K; k++) if (dp[B][k] > dp[B][bestK]) bestK = k;

        const cuts = [];
        let i = B, k = bestK;
        while (k > 0) { const j = par[i][k]; cuts.unshift([j, i]); i = j; k--; }
        cuts.forEach(([a, b]) => {
            const seg = info(a, b);
            if (seg.empty) return;
            rawSegments.push({
                startBeat: (s0 + a) / G, endBeat: (s0 + b) / G,
                root: seg.root, bass: seg.bass, quality: seg.quality, pcs: seg.pcs
            });
        });
    }

    // --- Merge adjacent segments ONLY when truly identical ---
    // (same root + bass + quality + exact pitch-class set)
    const merged = [];
    rawSegments.forEach((seg) => {
        const prev = merged[merged.length - 1];
        if (prev && prev.root === seg.root && prev.quality === seg.quality
            && prev.bass === seg.bass
            && prev.pcs.join(',') === seg.pcs.join(',')
            && Math.abs(prev.endBeat - seg.startBeat) < 1e-6) {
            prev.endBeat = seg.endBeat;
        } else {
            merged.push({ ...seg });
        }
    });

    merged.forEach((seg) => {
        seg.durBeats = seg.endBeat - seg.startBeat;
        seg.bar = Math.floor(seg.startBeat / bpb) + 1;
        seg.beatInBar = seg.startBeat - (seg.bar - 1) * bpb;
    });
    return merged;
}

// --- Key guess: Krumhansl-Schmuckler profile correlation on global chroma ---
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function guessKey(notes) {
    const chroma = new Float32Array(12);
    notes.forEach(n => { chroma[n.pitch % 12] += (n.endBeat - n.startBeat); });
    const corr = (profile, shift) => {
        let num = 0, sa = 0, sb = 0, ma = 0, mb = 0;
        for (let i = 0; i < 12; i++) { ma += chroma[(i + shift) % 12]; mb += profile[i]; }
        ma /= 12; mb /= 12;
        for (let i = 0; i < 12; i++) {
            const a = chroma[(i + shift) % 12] - ma, b = profile[i] - mb;
            num += a * b; sa += a * a; sb += b * b;
        }
        return num / (Math.sqrt(sa * sb) + 1e-9);
    };
    let best = { tonic: 0, mode: 'major', r: -2 };
    for (let t = 0; t < 12; t++) {
        const rMaj = corr(KS_MAJOR, t);
        const rMin = corr(KS_MINOR, t);
        if (rMaj > best.r) best = { tonic: t, mode: 'major', r: rMaj };
        if (rMin > best.r) best = { tonic: t, mode: 'minor', r: rMin };
    }
    return { tonic: best.tonic, mode: best.mode };
}
