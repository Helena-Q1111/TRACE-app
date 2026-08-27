// ========== FRONTEND CHORD ANALYSIS ==========
// Two-stage recognition over whole-beat quantized weighted chroma, with per-bar
// DP segmentation (<=4 segments/bar) and strict merging.
//
//   stage 1  pick (root, core quality) by weighted-template COSINE similarity
//   stage 2  attach the tensions that are actually sounding
//
// The vocabulary (CORE_QUALITIES / TENSION_DEFS) lives in config.js.
//
// Why cosine and not the old HarmAn-style S = P - N - M: with M = total - P
// that score expands to 2P - total - ..., so moving one pitch class from
// outside the template to inside swings the score by TWICE its weight, while
// the complexity bias resisting it was only ~0.005 x total. Any passing tone
// therefore won, and templates carrying free `opt` tones absorbed it. Cosine
// self-regularizes instead: claiming a tone that is not sounding raises the
// template norm and lowers the score. Measured effect on 95,423 Hooktheory
// segments - exact pitch-class set 50.8% -> 88.8%, invented tones 49.2% -> 7.1%
// (scripts/eval_chord_recognition.py).

const ANALYSIS_CFG = {
    gridPerBeat: 1,          // whole-beat boundary resolution
    maxSegmentsPerBar: 4,    // hard cap on chord changes per bar
    segmentPenalty: 0.45,    // cost per extra segment
    rootBassBonus: 0.05,     // cosine-scale bonus when root == the segment bass
    inversionMinRatio: 0.55, // bass must carry this much weight (vs max) to flag inversion
    // A tension counts when it is at least this strong relative to the MEAN
    // weight of the chord's own sounding tones. Deliberately not a fraction of
    // the peak: bassBoost, the downbeat weight and the bass note's longer
    // duration all multiply together, so in real MIDI the bass pitch class runs
    // ~3.4x the next one and a peak-relative threshold can never be cleared -
    // the whole tension stage goes silent. Measured on 129,410 Hooktheory
    // segments, switching the reference lifts accuracy on genuinely extended
    // chords from 69.3% to 76.1% at the same inflation.
    tensionKeepRatio: 0.75,
    metricStrong: 1.5,       // downbeat weight
    metricMid: 1.2,          // mid-bar beat weight (4/4 beat 3)
    bassBoost: 1.6           // bass pitch class weight boost
};

// Precomputed (root, quality) templates: pitch-class weight vector + its norm.
const SCORING_TEMPLATES = (() => {
    const out = [];
    for (let root = 0; root < 12; root++) {
        for (const q of CORE_QUALITIES) {
            const w = new Float32Array(12);
            let sq = 0;
            for (const [iv, weight] of q.tones) {
                w[(root + iv) % 12] = weight;
                sq += weight * weight;
            }
            out.push({ root, quality: q.quality, w, norm: Math.sqrt(sq) });
        }
    }
    return out;
})();

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
    // The bass boost is NOT folded into unitChroma: it exists to help stage 1
    // find the root, and letting it leak into every later measurement is what
    // made the bass pitch class dominate the segment (see tensionKeepRatio).
    // Two chroma vectors are accumulated per segment instead:
    //   w      - bass-boosted, used only to pick (root, quality)
    //   wPlain - what actually sounded, used to judge tone presence
    // --- Score one unit range [s, e) against all (root, template) pairs ---
    function segmentInfo(s, e) {
        const w = new Float32Array(12);
        const wPlain = new Float32Array(12);
        const bassTime = new Float32Array(12);   // time each pc spends as the bass
        for (let u = s; u < e; u++) {
            const bassPcOfUnit = unitBassPitch[u] !== Infinity ? unitBassPitch[u] % 12 : -1;
            for (let pc = 0; pc < 12; pc++) {
                const v = unitChroma[u][pc];
                wPlain[pc] += v;
                w[pc] += pc === bassPcOfUnit ? v * ANALYSIS_CFG.bassBoost : v;
            }
            if (bassPcOfUnit >= 0) bassTime[bassPcOfUnit]++;
        }
        const total = w.reduce((a, x) => a + x, 0);
        if (total < 1e-6) return { empty: true, score: 0 };
        // Dominant bass: the pc that is the lowest voice for the MOST time
        // (a fleeting low passing note no longer decides the segment's bass)
        let bassPc = -1, bassBest = 0;
        for (let pc = 0; pc < 12; pc++) {
            if (bassTime[pc] > bassBest) { bassBest = bassTime[pc]; bassPc = pc; }
        }
        // ---- Stage 1: (root, core quality) by weighted-template cosine ----
        // Cosine is scale-free, so the DP score is re-scaled by the segment's
        // energy: a long segment explaining a lot of weight must outscore two
        // short ones, exactly as under the old P - N - M score.
        let wNorm = 0;
        for (let pc = 0; pc < 12; pc++) wNorm += w[pc] * w[pc];
        wNorm = Math.sqrt(wNorm) || 1e-9;

        let best = null;
        for (const tpl of SCORING_TEMPLATES) {
            if (w[tpl.root] < 1e-6) continue;   // the root must sound
            let dot = 0;
            for (let pc = 0; pc < 12; pc++) dot += w[pc] * tpl.w[pc];
            let sim = dot / (wNorm * tpl.norm);
            if (tpl.root === bassPc) sim += ANALYSIS_CFG.rootBassBonus;
            if (!best || sim > best.sim) best = { sim, root: tpl.root, quality: tpl.quality };
        }
        if (!best) return { empty: true, score: 0 };

        // ---- Stage 2: which tensions are genuinely sounding ----
        // Reference = the mean weight of this chord's own sounding tones, so a
        // tension is kept when it is comparable to the rest of the chord rather
        // than to whatever the loudest pitch class happens to be.
        const maxPlain = Math.max(...wPlain);
        const coreIvs = CORE_TONES[best.quality];
        const corePcs = coreIvs.map(iv => (best.root + iv) % 12);
        const coreSet = new Set(corePcs);
        let refSum = 0, refN = 0;
        corePcs.forEach((pc) => { if (wPlain[pc] > 1e-6) { refSum += wPlain[pc]; refN++; } });
        const ref = refN > 0 ? refSum / refN : maxPlain;
        const tensions = [];
        for (const t of TENSION_DEFS) {
            const pc = (best.root + t.iv) % 12;
            if (coreSet.has(pc)) continue;
            if (wPlain[pc] >= ANALYSIS_CFG.tensionKeepRatio * ref) tensions.push(t.iv);
        }

        // Inversion: the segment's bass differs from the root - only flagged
        // when the bass is a chord tone AND carries substantial weight. Judged
        // on wPlain: against the boosted chroma the bass would always pass.
        const tonePcs = new Set(corePcs);
        tensions.forEach(iv => tonePcs.add((best.root + iv) % 12));
        let bass = best.root;
        if (bassPc >= 0 && bassPc !== best.root && tonePcs.has(bassPc)
            && wPlain[bassPc] >= ANALYSIS_CFG.inversionMinRatio * maxPlain) {
            bass = bassPc;
        }
        tonePcs.add(bass);

        // `pcs` is the embedding lookup key: core tones (5th included even when
        // omitted, so one recognized chord always maps to one table entry) plus
        // confirmed tensions plus the bass. `soundingPcs` is what actually rang,
        // used for off-key detection where inventing a 5th would be misleading.
        const soundingPcs = [];
        for (let pc = 0; pc < 12; pc++) if (wPlain[pc] > 1e-6) soundingPcs.push(pc);

        return {
            empty: false,
            score: total * best.sim,
            root: best.root,
            bass: bass,
            quality: best.quality,
            tensions: tensions,
            pcs: [...tonePcs].sort((a, b) => a - b),
            soundingPcs: soundingPcs
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
                root: seg.root, bass: seg.bass, quality: seg.quality,
                tensions: seg.tensions, pcs: seg.pcs, soundingPcs: seg.soundingPcs
            });
        });
    }

    // --- Merge adjacent segments ONLY when truly identical ---
    // (same root + bass + quality + exact lookup pitch-class set; equal pcs
    // with equal root/quality implies equal tensions, so those need no test)
    const merged = [];
    rawSegments.forEach((seg) => {
        const prev = merged[merged.length - 1];
        if (prev && prev.root === seg.root && prev.quality === seg.quality
            && prev.bass === seg.bass
            && prev.pcs.join(',') === seg.pcs.join(',')
            && Math.abs(prev.endBeat - seg.startBeat) < 1e-6) {
            prev.endBeat = seg.endBeat;
            // off-key detection should see everything that rang across the span
            prev.soundingPcs = [...new Set(prev.soundingPcs.concat(seg.soundingPcs))]
                .sort((a, b) => a - b);
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
