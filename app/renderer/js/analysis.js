// ========== FRONTEND CHORD ANALYSIS ==========
// Whole-beat quantized weighted chroma, cut into chords by a per-bar DP
// (<=4 segments/bar), then merged only where truly identical.
//
//   stage 1  pick (root, core quality) by weighted-template COSINE similarity,
//            then veto a "sus" whose suspended tone is really a 9th/11th
//   stage 2  attach the tensions that are actually sounding; decide the bass
//
// Only stage 1 is needed to SCORE a candidate span, so the DP runs stage 1 on
// every span it tries and stage 2 only on the spans it keeps.
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
//
// Segmentation and the bass are measured separately, on Hooktheory rendered to
// MIDI in two textures (scripts/eval_segmentation.py) - the labelling benchmark
// hands the recognizer true boundaries and a true bass, so it cannot see them.

const ANALYSIS_CFG = {
    gridPerBeat: 1,          // whole-beat boundary resolution
    maxSegmentsPerBar: 4,    // hard cap on chord changes per bar
    // Cost of starting a new chord INSIDE a bar (the barline is free: bars are
    // cut independently), in units of the bar's mean per-beat energy. Priced by
    // where chords really change - 295,592 changes in Hooktheory 4/4: beat 1
    // 58.4%, beat 3 17.7% (+5.0% anticipated on 2.5), beat 4 6.1%, beat 2 3.0%.
    // A single flat price (0.45 everywhere) made the half-bar change as dear as
    // a weak-beat one, so a bar holding two chords stayed whole and their union
    // was read as one 7th chord: Mozart K.545 m.2 (G7 | C) came out "Cmaj7".
    // The weak-beat price is unchanged; it is what keeps an Alberti bar from
    // being cut into one-beat fragments that each hold half a triad.
    cutPenaltyMid: 0.05,     // half-bar (4/4 beat 3, 6/8 beat 4)
    cutPenaltyWeak: 0.45,    // any other beat
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

// Metric level of a beat position within the bar: 2 downbeat, 1 half-bar
// (only in bars of 4+ beats), 0 anything else. Weights the chroma, the bass
// vote and the price of a cut.
function metricLevel(beatPos, bpb) {
    if (beatPos === 0) return 2;
    return (bpb >= 4 && beatPos === Math.floor(bpb / 2)) ? 1 : 0;
}

// notes: [{startBeat, endBeat, pitch}], returns segments:
// [{startBeat, endBeat, durBeats, bar, beatInBar, root, bass, quality,
//   tensions, pcs, soundingPcs}]
function analyzeMidiToSegments(notes, bpb) {
    if (!notes || notes.length === 0) return [];
    const CFG = ANALYSIS_CFG;
    const G = CFG.gridPerBeat;
    const totalUnits = Math.max(1, Math.ceil((Math.max(...notes.map(n => n.endBeat)) - 1e-6) * G));
    const metricWeight = [1.0, CFG.metricMid, CFG.metricStrong];
    const unitMetric = Array.from({ length: totalUnits },
        (_, u) => metricWeight[metricLevel((u / G) % bpb, bpb)]);

    // --- Per-unit weighted chroma + register (unit = 1/G beat) ---
    // unitLowPitch keeps the ACTUAL MIDI pitch each class sounds at, which the
    // 12-bin chroma throws away. A 2nd and a 9th are the same pitch class; the
    // only thing that separates them is whether the tone sits inside the octave
    // above the root or above it. Without this the recognizer cannot tell a
    // real sus2 from an add9 voiced with the 9 on top, and calls both sus2.
    const unitChroma = Array.from({ length: totalUnits }, () => new Float32Array(12));
    const unitLowPitch = Array.from({ length: totalUnits },
        () => new Float32Array(12).fill(Infinity));
    notes.forEach((n) => {
        const u0 = Math.max(0, Math.floor(n.startBeat * G + 1e-6));
        const u1 = Math.min(totalUnits, Math.ceil(n.endBeat * G - 1e-6));
        for (let u = u0; u < u1; u++) {
            const ov = Math.min(n.endBeat, (u + 1) / G) - Math.max(n.startBeat, u / G);
            if (ov <= 0.03) continue;   // ignore hairline overlaps
            const pc = n.pitch % 12;
            unitChroma[u][pc] += ov * unitMetric[u];
            if (n.pitch < unitLowPitch[u][pc]) unitLowPitch[u][pc] = n.pitch;
        }
    });
    // The lowest sounding pitch class of each unit (-1 = silent)
    const unitBassPc = unitLowPitch.map((low) => {
        let pc = -1;
        for (let p = 0; p < 12; p++) if (low[p] < (pc < 0 ? Infinity : low[pc])) pc = p;
        return pc;
    });

    // --- Measure a unit range [s, e): what sounded, and where the bass is ---
    // The bass boost is NOT folded into unitChroma: it exists to help stage 1
    // find the root, and letting it leak into every later measurement is what
    // made the bass pitch class dominate the segment (see tensionKeepRatio).
    // Two chroma vectors are accumulated instead:
    //   w      - bass-boosted, used only to pick (root, quality)
    //   wPlain - what actually sounded, used to judge tone presence
    function measureSpan(s, e) {
        const w = new Float32Array(12);
        const wPlain = new Float32Array(12);
        const lowPitch = new Float32Array(12).fill(Infinity);
        const bassVote = new Float32Array(12);
        for (let u = s; u < e; u++) {
            const bassPcOfUnit = unitBassPc[u];
            for (let pc = 0; pc < 12; pc++) {
                const v = unitChroma[u][pc];
                wPlain[pc] += v;
                w[pc] += pc === bassPcOfUnit ? v * CFG.bassBoost : v;
                if (unitLowPitch[u][pc] < lowPitch[pc]) lowPitch[pc] = unitLowPitch[u][pc];
            }
            // Metric-weighted: in a broken-chord figure (Alberti C-G-E-G) the
            // lowest note of each BEAT alternates root, 3rd, root, 3rd. Counted
            // one vote per beat that is a tie, and the old tie-break (lowest
            // pitch-CLASS number) handed C chords their root but G chords their
            // 3rd - a false inversion on 13% of root-position Alberti frames.
            // The beats that carry the harmony are the strong ones.
            if (bassPcOfUnit >= 0) bassVote[bassPcOfUnit] += unitMetric[u];
        }
        let total = 0;
        for (let pc = 0; pc < 12; pc++) total += w[pc];
        // Dominant bass: the pc that is the lowest voice on the most (metrically
        // weighted) beats - a fleeting low passing note does not decide it.
        // Exact ties go to the lower sounding pitch.
        let bassPc = -1;
        for (let pc = 0; pc < 12; pc++) {
            if (bassVote[pc] <= 0) continue;
            if (bassPc < 0 || bassVote[pc] > bassVote[bassPc] + 1e-9
                || (Math.abs(bassVote[pc] - bassVote[bassPc]) <= 1e-9 && lowPitch[pc] < lowPitch[bassPc])) {
                bassPc = pc;
            }
        }
        return { w, wPlain, lowPitch, total, bassPc };
    }

    // --- Stage 1: (root, core quality) by weighted-template cosine ---
    function pickChord(m) {
        let wNorm = 0;
        for (let pc = 0; pc < 12; pc++) wNorm += m.w[pc] * m.w[pc];
        wNorm = Math.sqrt(wNorm) || 1e-9;

        // Any root considered must actually sound, which is what guarantees
        // lowPitch[root] and a non-empty tension reference further down.
        const bestTemplate = (allowSus) => {
            let top = null;
            for (const tpl of SCORING_TEMPLATES) {
                if (m.w[tpl.root] < 1e-6) continue;
                if (!allowSus && SUSPENDED_INTERVAL[tpl.quality] !== undefined) continue;
                let dot = 0;
                for (let pc = 0; pc < 12; pc++) dot += m.w[pc] * tpl.w[pc];
                let sim = dot / (wNorm * tpl.norm);
                if (tpl.root === m.bassPc) sim += CFG.rootBassBonus;
                if (!top || sim > top.sim) top = { sim, root: tpl.root, quality: tpl.quality };
            }
            return top;
        };

        const best = bestTemplate(true);
        best.forcedTensionPc = -1;

        // Voicing check: is that "suspension" actually an upper structure?
        // A sus chord puts the 2nd or 4th where the 3rd would be - close to the
        // root, inside the octave. If the same pitch class only ever sounds an
        // octave or more above the root it is a 9th or an 11th sitting on top of
        // an ordinary triad, and the chord is add9 / 11, not sus. Pitch-class
        // matching alone cannot see the difference, which is why sus was being
        // over-reported.
        const susIv = SUSPENDED_INTERVAL[best.quality];
        if (susIv !== undefined) {
            const susPc = (best.root + susIv) % 12;
            if (Number.isFinite(m.lowPitch[susPc])
                && m.lowPitch[susPc] - m.lowPitch[best.root] >= 12) {
                // The root still sounds, so a non-sus template on it exists.
                const alt = bestTemplate(false);
                // Keep the tone: it is the whole reason the chord is
                // interesting, and the embedding key must not lose it even if
                // it lands under the tension layer's weight threshold.
                alt.forcedTensionPc = susPc;
                return alt;
            }
        }
        return best;
    }

    // --- Stage 2: tensions, bass, and the lookup key for a KEPT span ---
    function describeChord(m, chord) {
        // Reference = the mean weight of this chord's own sounding tones, so a
        // tension is kept when it is comparable to the rest of the chord rather
        // than to whatever the loudest pitch class happens to be. The root
        // always sounds, so the mean is never empty.
        const corePcs = CORE_TONES[chord.quality].map(iv => (chord.root + iv) % 12);
        let refSum = 0, refN = 0;
        corePcs.forEach((pc) => { if (m.wPlain[pc] > 1e-6) { refSum += m.wPlain[pc]; refN++; } });
        const ref = refSum / refN;

        const tonePcs = new Set(corePcs);
        const tensions = [];
        for (const t of TENSION_DEFS) {
            const pc = (chord.root + t.iv) % 12;
            if (tonePcs.has(pc)) continue;
            if (pc === chord.forcedTensionPc || m.wPlain[pc] >= CFG.tensionKeepRatio * ref) {
                tensions.push(t.iv);
            }
        }
        tensions.forEach(iv => tonePcs.add((chord.root + iv) % 12));

        // Inversion: the segment's bass differs from the root - only flagged
        // when the bass is a chord tone AND carries substantial weight. Judged
        // on wPlain: against the boosted chroma the bass would always pass.
        const maxPlain = Math.max(...m.wPlain);
        const bass = (m.bassPc !== chord.root && tonePcs.has(m.bassPc)
            && m.wPlain[m.bassPc] >= CFG.inversionMinRatio * maxPlain) ? m.bassPc : chord.root;

        // `pcs` is the embedding lookup key: core tones (5th included even when
        // omitted, so one recognized chord always maps to one table entry) plus
        // confirmed tensions (the bass is always one of these). `soundingPcs`
        // is what actually rang, used for off-key detection where inventing a
        // 5th would be misleading.
        const soundingPcs = [];
        for (let pc = 0; pc < 12; pc++) if (m.wPlain[pc] > 1e-6) soundingPcs.push(pc);

        return {
            root: chord.root,
            bass,
            quality: chord.quality,
            tensions,
            pcs: [...tonePcs].sort((a, b) => a - b),
            soundingPcs
        };
    }

    // --- Per-bar DP: best split of the bar's units into <=4 segments ---
    // A span's DP score is its energy x cosine: cosine is scale-free, so a long
    // span explaining a lot of weight must outscore two short ones.
    const rawSegments = [];
    const unitsPerBar = bpb * G;
    const nBars = Math.ceil(totalUnits / unitsPerBar);
    for (let bar = 0; bar < nBars; bar++) {
        const s0 = bar * unitsPerBar;
        const B = Math.min(unitsPerBar, totalUnits - s0);
        if (B <= 0) break;

        let barEnergy = 0;
        for (let u = s0; u < s0 + B; u++) barEnergy += unitChroma[u].reduce((a, x) => a + x, 0);
        if (barEnergy < 1e-6) continue;   // silent bar
        const cutCost = (j) => (metricLevel(j / G, bpb) === 1 ? CFG.cutPenaltyMid : CFG.cutPenaltyWeak)
            * (barEnergy / B) * G;

        const memo = new Map();
        const span = (a, b) => {
            const key = a * (B + 1) + b;
            let v = memo.get(key);
            if (!v) {
                const m = measureSpan(s0 + a, s0 + b);
                const chord = m.total < 1e-6 ? null : pickChord(m);
                v = { m, chord, score: chord ? m.total * chord.sim : 0 };
                memo.set(key, v);
            }
            return v;
        };

        // dp[i][k]: best score of units [0, i) cut into k segments. The k axis
        // only enforces maxSegmentsPerBar; with whole-beat units it binds only
        // in bars longer than 4 beats.
        const K = Math.min(CFG.maxSegmentsPerBar, B);
        const NEG = -1e18;
        const dp = Array.from({ length: B + 1 }, () => new Array(K + 1).fill(NEG));
        const par = Array.from({ length: B + 1 }, () => new Array(K + 1).fill(-1));
        dp[0][0] = 0;
        for (let i = 1; i <= B; i++) {
            for (let k = 1; k <= K; k++) {
                for (let j = k - 1; j < i; j++) {
                    if (dp[j][k - 1] === NEG) continue;
                    const sc = dp[j][k - 1] + span(j, i).score - (j > 0 ? cutCost(j) : 0);
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
            const { m, chord } = span(a, b);
            if (!chord) return;
            rawSegments.push({ startBeat: (s0 + a) / G, endBeat: (s0 + b) / G, ...describeChord(m, chord) });
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
