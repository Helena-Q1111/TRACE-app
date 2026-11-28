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
    gridPerBeat: 1,          // whole-beat boundary resolution (plus block-chord attacks, below)
    maxSegmentsPerBar: 4,    // hard cap on chord changes per bar
    // Block-chord attacks become boundary candidates of their own, so a chord
    // struck off the beat (a push on the "and of 4", a triplet, a dotted
    // rhythm) changes where it is struck, not at the nearest whole beat.
    attackWindow: 0.15,      // notes starting this close together form one attack (a rolled chord too)
    attackMinPcs: 3,         // ...if they span this many pitch classes
    attackSnap: 0.1,         // an attack this close to a beat is that beat (humanised timing)
    blockTextureAttacksPerBar: 1.0, // below this many attacks per bar the anchoring rules stay off
    carryOverShare: 0.5,     // a barline span merges back only if this share of it is the earlier chord's tones
    anchorReach: 1.0,        // a change moves onto an attack up to this far before it,
    anchorReachLater: 1.0,   // ...or this far after it
    anchorTolerance: 0.03,   // ...if the two spans then fit within this fraction of the grid cut's score
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
    cutPenaltyBassMove: 0.05, // any beat where a new bass-line note starts (see bassMoves)
    foreignBassPenalty: 0.5, // per unit of weight of a second bass-line note inside one span
    seventhKeepRatio: 0.5,   // a triad whose 7th sounds at this fraction of the chord's mean tone weight is a 7th chord
    bassRootRule: true,
    bassRootToneMin: 0.35,   // ...its 3rd and 5th must reach this fraction of the loudest,
    bassRootSeventhMin: 0.25, // and its 7th this one
    bassRootSubstantial: 0.2, // a tone at this fraction of the loudest must be explained by a bass-rooted reading
    rootBassBonus: 0.05,     // cosine-scale bonus when root == the segment bass
    inversionMinRatio: 0.55, // initial bass estimate used when merging identical spans
    inversionBassShare: 0.70, // minimum share of sounding time supported by the candidate bass
    unusualBassShare: 0.85,   // a suspended or added tone needs stronger evidence in the bass
    inversionRootRatio: 0.50, // the chord root must carry at least half the bass pitch class's weight
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
    bassBoost: 1.6,          // bass pitch class weight boost
    structBassBeats: 0.9     // a lowest note held this long is a bass line, not figuration
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
    const endBeat = Math.max(...notes.map(n => n.endBeat));
    const metricWeight = [1.0, CFG.metricMid, CFG.metricStrong];

    // --- Boundary candidates: the beat grid + every block-chord attack ---
    // An attack is a cluster of onsets within attackWindow covering at least
    // attackMinPcs pitch classes; one near a beat snaps to it (humanised or
    // slightly early playing), the others stay where they were struck.
    const byStart = [...notes].sort((x, y) => x.startBeat - y.startBeat);
    const attackTimes = new Set();
    for (let i = 0; i < byStart.length;) {
        const t0 = byStart[i].startBeat;
        const pcs = new Set();
        while (i < byStart.length && byStart[i].startBeat <= t0 + CFG.attackWindow) pcs.add(byStart[i++].pitch % 12);
        if (pcs.size < CFG.attackMinPcs) continue;
        const grid = Math.round(t0 * G) / G;
        const at = Math.abs(t0 - grid) <= CFG.attackSnap ? grid : Math.round(t0 * 1000) / 1000;
        attackTimes.add(at);
    }
    const nGrid = Math.max(1, Math.ceil((endBeat - 1e-6) * G));
    const onGrid = (t) => Math.abs(t * G - Math.round(t * G)) < 1e-6;
    const gridTimes = new Set();
    for (let k = 0; k <= nGrid; k++) gridTimes.add(k / G);
    for (let t = bpb; t < nGrid / G; t += bpb) gridTimes.add(Math.round(t * 1000) / 1000);   // barlines
    const fineTimes = new Set(gridTimes);
    attackTimes.forEach(t => { if (t > 0 && t < nGrid / G) fineTimes.add(t); });

    // Two unit tables over the same notes. GRID (beats + barlines) is what the
    // DP cuts on - it decides how many chords there are, exactly as it always
    // has. FINE adds every block-chord attack, and is only used afterwards to
    // move a change onto the attack it belongs to (see "anchoring").
    function makeTable(times) {
        const start = [...times].sort((x, y) => x - y);
        const n = start.length - 1;
        const end = start.slice(1);
        start.length = n;
        const attack = start.map(t => attackTimes.has(t));
        // metric weight of the beat a unit lies in
        const metric = start.map(t => metricWeight[metricLevel(Math.floor(t * G + 1e-6) / G % bpb, bpb)]);
        const at = (t) => {                      // last unit starting at or before t
            let lo = 0, hi = n - 1;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (start[mid] <= t + 1e-9) lo = mid; else hi = mid - 1; }
            return lo;
        };
        // Per-unit weighted chroma + register. lowPitch keeps the ACTUAL MIDI
        // pitch each class sounds at, which the 12-bin chroma throws away. A
        // 2nd and a 9th are the same pitch class; the only thing that separates
        // them is whether the tone sits inside the octave above the root or
        // above it. Without this the recognizer cannot tell a real sus2 from an
        // add9 voiced with the 9 on top, and calls both sus2.
        const chroma = Array.from({ length: n }, () => new Float32Array(12));
        const lowPitch = Array.from({ length: n }, () => new Float32Array(12).fill(Infinity));
        const lowDur = new Float32Array(n);      // duration of the note that is the unit's lowest
        const lowestOverlap = new Float32Array(n);
        const lowest = new Float32Array(n).fill(Infinity);
        notes.forEach((nt) => {
            for (let u = at(nt.startBeat); u < n && start[u] < nt.endBeat; u++) {
                const ov = Math.min(nt.endBeat, end[u]) - Math.max(nt.startBeat, start[u]);
                if (ov <= 0.03) continue;   // ignore hairline overlaps
                const pc = nt.pitch % 12;
                chroma[u][pc] += ov * metric[u];
                if (nt.pitch < lowPitch[u][pc]) lowPitch[u][pc] = nt.pitch;
                if (nt.pitch < lowest[u]) {
                    lowest[u] = nt.pitch;
                    lowDur[u] = nt.endBeat - nt.startBeat;
                    lowestOverlap[u] = ov;
                } else if (nt.pitch === lowest[u]) {
                    lowestOverlap[u] += ov;
                }
            }
        });
        // The lowest sounding pitch class of each unit (-1 = silent)
        const bassPc = lowPitch.map((low) => {
            let pc = -1;
            for (let q = 0; q < 12; q++) if (low[q] < (pc < 0 ? Infinity : low[pc])) pc = q;
            return pc;
        });
        // A bass LINE (a note held for about a beat or more: a ground bass, a
        // walking or two-feel bass, a held block-chord bass) names its chord. A
        // figuration's lowest notes do not: an Alberti bar's lowest eighths
        // alternate root and 3rd under ONE chord.
        const structBass = bassPc.map((pc, u) => (pc >= 0 && lowDur[u] >= CFG.structBassBeats ? pc : -1));

        // Measure a unit range [s, e): what sounded, and where the bass is.
        // The bass boost is NOT folded into the chroma: it exists to help
        // stage 1 find the root, and letting it leak into every later
        // measurement is what made the bass pitch class dominate the segment
        // (see tensionKeepRatio). Two chroma vectors are accumulated instead:
        //   w      - bass-boosted, used only to pick (root, quality)
        //   wPlain - what actually sounded, used to judge tone presence
        // One bass per chord. Each unit's lowest note is boosted - but when the
        // span holds TWO different bass-line notes it crosses a chord change,
        // and only its dominant bass keeps the boost. Boosting every unit let
        // such a span claim both basses as chord tones: Em7 | A7 merged into
        // "Esus4" (E and A boosted, both in the template), and the Canon's
        // D | A | B | F# beats into "Gsus2" and "Bm7/D". Figuration basses
        // (Alberti) keep the per-unit boost, which is what finds their root.
        function measure(s, e) {
            const w = new Float32Array(12);
            const wPlain = new Float32Array(12);
            const asBass = new Float32Array(12);     // weight a pc carried while it was the lowest voice
            const lp = new Float32Array(12).fill(Infinity);
            const bassVote = new Float32Array(12);
            const lineBass = new Set();
            for (let u = s; u < e; u++) {
                const bpc = bassPc[u];
                if (structBass[u] >= 0) lineBass.add(structBass[u]);
                for (let pc = 0; pc < 12; pc++) {
                    const v = chroma[u][pc];
                    wPlain[pc] += v;
                    if (pc === bpc) asBass[pc] += v;
                    if (lowPitch[u][pc] < lp[pc]) lp[pc] = lowPitch[u][pc];
                }
                // Metric-weighted: in a broken-chord figure (Alberti C-G-E-G)
                // the lowest note of each BEAT alternates root, 3rd, root, 3rd.
                // Counted one vote per beat that is a tie, and the old tie-break
                // (lowest pitch-CLASS number) handed C chords their root but G
                // chords their 3rd - a false inversion on 13% of root-position
                // Alberti frames. The beats that carry the harmony are the strong
                // ones. Votes scale with the unit's length (a beat split by an
                // attack still votes once).
                if (bpc >= 0) bassVote[bpc] += metric[u] * (end[u] - start[u]) * G;
            }
            // Dominant bass: the pc that is the lowest voice on the most
            // (metrically weighted) beats - a fleeting low passing note does not
            // decide it. Exact ties go to the lower sounding pitch.
            let bp = -1;
            for (let pc = 0; pc < 12; pc++) {
                if (bassVote[pc] <= 0) continue;
                if (bp < 0 || bassVote[pc] > bassVote[bp] + 1e-9
                    || (Math.abs(bassVote[pc] - bassVote[bp]) <= 1e-9 && lp[pc] < lp[bp])) bp = pc;
            }
            const oneBass = lineBass.size >= 2;
            // Splitting at a bass-line change lets each piece boost its own bass,
            // which works as a reward for cutting where the bass moves - in block
            // and two-feel textures that is where chords change (Hooktheory block
            // root 92.0% with an additive total vs 93.6% with this one).
            let total = 0;
            for (let pc = 0; pc < 12; pc++) {
                w[pc] = wPlain[pc] + (!oneBass || pc === bp ? (CFG.bassBoost - 1) * asBass[pc] : 0);
                total += w[pc];
            }
            // Other bass-line notes the span swallows, by weight (charged in the
            // DP unless the chosen chord has them as its 3rd or 5th - spanScore)
            const foreignBass = [];
            if (oneBass) lineBass.forEach((pc) => { if (pc !== bp) foreignBass.push([pc, asBass[pc]]); });
            return { w, wPlain, lowPitch: lp, total, bassPc: bp, foreignBass };
        }

        function bassShare(pc, s, e) {
            let support = 0, sounding = 0;
            for (let u = s; u < e; u++) {
                const duration = end[u] - start[u];
                // Estimate sounding time without counting silence after a staccato chord.
                sounding += Math.min(duration * metric[u], Math.max(...chroma[u]));
                if (bassPc[u] === pc) support += Math.min(duration, lowestOverlap[u]) * metric[u];
            }
            return sounding ? support / sounding : 0;
        }
        return { start, end, n, attack, at, chroma, lowPitch, lowest, bassPc, structBass, measure, bassShare };
    }
    const grid = makeTable(gridTimes);
    const fine = makeTable(fineTimes);
    // the DP below works on the grid table
    const { start: unitStart, end: unitEnd, n: totalUnits, at: unitAt, chroma: unitChroma,
        lowPitch: unitLowPitch, bassPc: unitBassPc, structBass: unitStructBass, measure: measureSpan } = grid;

    // A reading rooted on the span's bass that explains every substantial
    // tone (see pickChord), or null. Among several, the best cosine wins.
    const SEVENTH_UPGRADE = { major: [[10, 'dominant7'], [11, 'maj7']], minor: [[10, 'min7'], [11, 'minMaj7']] };
    const ALTERED_TENSIONS = new Set([1, 3, 8]);
    const THIRDS = { major: 4, minor: 3, dim: 3, aug: 4, maj7: 4, dominant7: 4, min7: 3, minMaj7: 3, m7b5: 3 };
    const SEVENTHS = { maj7: 11, dominant7: 10, min7: 10, minMaj7: 11, m7b5: 10 };
    function bassRootedReading(m) {
        const r = m.bassPc;
        const maxW = Math.max(...m.wPlain);
        // its chord tones must be real chord tones - a melody's passing note is not a 5th
        const sounds = (pc) => m.wPlain[pc] >= CFG.bassRootToneMin * maxW;
        const substantial = [];
        for (let pc = 0; pc < 12; pc++) if (m.wPlain[pc] >= CFG.bassRootSubstantial * maxW) substantial.push(pc);
        let wNorm = 0;
        for (let pc = 0; pc < 12; pc++) wNorm += m.w[pc] * m.w[pc];
        wNorm = Math.sqrt(wNorm) || 1e-9;
        let top = null;
        for (const tpl of SCORING_TEMPLATES) {
            if (tpl.root !== r || THIRDS[tpl.quality] === undefined) continue;
            if (!sounds((r + THIRDS[tpl.quality]) % 12)) continue;
            // the 7th may be lighter (jazz comping keeps it soft), the 5th may be
            // omitted when the 7th is there instead
            const sev = SEVENTHS[tpl.quality];
            const seventhOk = sev !== undefined && m.wPlain[(r + sev) % 12] >= CFG.bassRootSeventhMin * maxW;
            if (sev !== undefined && !seventhOk) continue;
            const core = CORE_TONES[tpl.quality].map(iv => (r + iv) % 12);
            if (!core.every(pc => pc === (r + sev) % 12 || sounds(pc) || (pc === (r + 7) % 12 && seventhOk))) continue;
            // Altered tensions (b9, #9, b13) belong to dominants; on anything
            // else they mean the bass is not the root (Cmaj7/E is not "Em(b13)").
            const allowed = new Set(core);
            TENSION_DEFS.forEach((t) => {
                if (tpl.quality === 'dominant7' || !ALTERED_TENSIONS.has(t.iv)) allowed.add((r + t.iv) % 12);
            });
            if (!substantial.every(pc => allowed.has(pc))) continue;
            let dot = 0;
            for (let pc = 0; pc < 12; pc++) dot += m.w[pc] * tpl.w[pc];
            const sim = dot / (wNorm * tpl.norm) + CFG.rootBassBonus;
            if (!top || sim > top.sim) top = { sim, root: r, quality: tpl.quality, forcedTensionPc: -1 };
        }
        return top;
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

        // Root in the bass, chord above it: A C# G + F# B (A13) was read as
        // F#m/A, B D F# G# (Bm6) as G#dim/B - the upper tones happen to spell
        // a complete smaller chord, and the cosine prefers its short template.
        // When a chord rooted ON the bass accounts for every substantial tone
        // (as chord tones or standard tensions), take that reading. It must
        // have its 3rd, and its 5th unless the 7th is there instead (the
        // root-3-7 shell of jazz voicings) - which is what keeps a real
        // inversion like C/E from turning into a fifthless Em(b13). Every one
        // of those chord tones has to be substantial, not a melody's passing
        // note. On Hooktheory rendered as MIDI: Alberti root 77.4% -> 81.1%,
        // false inversions 5.6% -> 3.2% (block 1.1% -> 0.7%), block root
        // -0.7pt where a real inversion's pitch set also spells a 6 chord.
        if (CFG.bassRootRule && m.bassPc >= 0 && best.root !== m.bassPc) {
            // Relabels only: the DP keeps scoring the span by the best cosine,
            // so this rule never moves a boundary.
            const alt = bassRootedReading(m);
            if (alt) return { ...alt, sim: best.sim };
        }

        // Voicing check: is that "suspension" actually an upper structure?
        // A sus chord puts the 2nd or 4th where the 3rd would be - close to the
        // root, inside the octave. If the same pitch class only ever sounds an
        // octave or more above the root it is a 9th or an 11th sitting on top of
        // an ordinary triad, and the chord is add9 / 11, not sus. Pitch-class
        // matching alone cannot see the difference, which is why sus was being
        // over-reported.
        const susIv = SUSPENDED_INTERVAL[best.quality];
        // A sus chord is root + suspension + FIFTH. Without its fifth it is
        // just a dyad, and a weighted cosine can still rank it first when those
        // two tones are loud - Ain't Misbehavin' bar 10 (D F# A B, i.e. Bm7)
        // came out Asus2/B with no E sounding at all. No fifth, no sus.
        if (susIv !== undefined && !(m.wPlain[(best.root + 7) % 12] > 1e-6)) {
            const alt = bestTemplate(false);
            alt.forcedTensionPc = -1;
            return alt;
        }
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
        let corePcs = CORE_TONES[chord.quality].map(iv => (chord.root + iv) % 12);
        let refSum = 0, refN = 0;
        corePcs.forEach((pc) => { if (m.wPlain[pc] > 1e-6) { refSum += m.wPlain[pc]; refN++; } });
        const ref = refSum / refN;

        // A triad whose 7th is sounding, if quietly, is a 7th chord: jazz
        // comping keeps the 7th light under a loud root and 3rd, and stage 1's
        // cosine then prefers the shorter triad template (F#7 -> F#).
        const up = SEVENTH_UPGRADE[chord.quality];
        if (up) {
            let pick = null;
            for (const [iv, q] of up) {
                const w7 = m.wPlain[(chord.root + iv) % 12];
                if (w7 >= CFG.seventhKeepRatio * ref && (!pick || w7 > pick[0])) pick = [w7, q];
            }
            if (pick) {
                chord = { ...chord, quality: pick[1] };
                corePcs = CORE_TONES[chord.quality].map(iv => (chord.root + iv) % 12);
            }
        }

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

    // A span's DP score: energy x cosine, less a charge for each second
    // bass-line note it swallows that the chord cannot hold as a triad tone.
    // A bass moving F -> A under one F chord is an arpeggiated bass and costs
    // nothing; E -> A merged into "Esus4" hides a chord change behind a
    // suspension, and pays.
    const FIFTH_OF = { dim: 6, aug: 8, m7b5: 6, dim7: 6 };
    function spanScore(m, chord) {
        let charge = 0;
        if (m.foreignBass.length) {
            const third = THIRDS[chord.quality];
            const triad = new Set([chord.root, (chord.root + (FIFTH_OF[chord.quality] ?? 7)) % 12]);
            if (third !== undefined) triad.add((chord.root + third) % 12);
            m.foreignBass.forEach(([pc, wt]) => { if (!triad.has(pc)) charge += wt; });
        }
        return m.total * chord.sim - CFG.foreignBassPenalty * charge;
    }

    // --- Per-bar DP: best split of the bar's units into <=4 segments ---
    // A span's DP score is its energy x cosine: cosine is scale-free, so a long
    // span explaining a lot of weight must outscore two short ones.
    const rawSegments = [];
    const nBars = Math.ceil((nGrid / G) / bpb);
    for (let bar = 0; bar < nBars; bar++) {
        const s0 = unitAt(bar * bpb);
        const s1 = bar + 1 < nBars ? unitAt((bar + 1) * bpb) : totalUnits;
        const B = s1 - s0;
        if (B <= 0) break;

        let barEnergy = 0;
        for (let u = s0; u < s0 + B; u++) barEnergy += unitChroma[u].reduce((a, x) => a + x, 0);
        if (barEnergy < 1e-6) continue;   // silent bar
        const beatEnergy = barEnergy / Math.max(1e-6, unitEnd[s0 + B - 1] - unitStart[s0]);
        // A new bass-line note starting on this beat is the clearest sign the
        // harmony moves there, whatever the metric position: the Canon changes
        // chord on every beat over its ground bass, and at the weak-beat price
        // whole bars were read as one chord. Figuration never qualifies (see
        // unitStructBass), so an Alberti bar still is not cut into fragments.
        const bassMoves = (j) => {
            const u = s0 + j, b = unitStructBass[u];
            return b >= 0 && unitBassPc[u - 1] !== b && unitLowPitch[u][b] !== unitLowPitch[u - 1][b];
        };
        // The DP decides HOW MANY chords there are, on the beat grid only;
        // where each change falls is settled afterwards (anchoring, below).
        // Letting attacks be cheap cuts here put a chord on nearly every
        // struck voicing - 47-55% more chords on the example pieces.
        const cutCost = (j) => {
            const t = unitStart[s0 + j];
            if (!onGrid(t)) return Infinity;
            let c = metricLevel(Math.round(t) % bpb, bpb) === 1 ? CFG.cutPenaltyMid : CFG.cutPenaltyWeak;
            if (bassMoves(j)) c = Math.min(c, CFG.cutPenaltyBassMove);
            return c * beatEnergy;
        };

        const memo = new Map();
        const span = (a, b) => {
            const key = a * (B + 1) + b;
            let v = memo.get(key);
            if (!v) {
                const m = measureSpan(s0 + a, s0 + b);
                const chord = m.total < 1e-6 ? null : pickChord(m);
                v = { m, chord, score: chord ? spanScore(m, chord) : 0 };
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
            rawSegments.push({ startBeat: unitStart[s0 + a], endBeat: unitEnd[s0 + b - 1], u0: s0 + a, u1: s0 + b,
                ...describeChord(m, chord) });
        });
    }

    // --- Block-chord textures: changes go where chords are struck ---
    // Bars are cut independently, so a barline is always a free boundary. Where
    // the music is made of struck block chords that is wrong twice over:
    //  1. a chord pushed ahead of the barline (struck on the last triplet or
    //     the "and" of 4) was reported at the barline - move the change to the
    //     attack when one lies within anchorReach and its struck notes belong
    //     to the new chord at least as much as to the old one;
    //  2. a barline with no attack and no bass move carries no evidence of a
    //     change - if the two spans read as the first chord together, merge.
    // Both need attacks to act on, so textures without block chords (Alberti,
    // a solo line) are untouched.
    const nBarsWithNotes = Math.max(1, Math.ceil(endBeat / bpb));
    if (attackTimes.size >= CFG.blockTextureAttacksPerBar * nBarsWithNotes) {
        // grid unit indices -> fine unit indices (grid times are fine times too)
        rawSegments.forEach((sg) => { sg.u0 = fine.at(sg.startBeat); sg.u1 = fine.at(sg.endBeat - 1e-6) + 1; });
        const F = fine;
        // 1. anchor
        for (let i = 1; i < rawSegments.length; i++) {
            const prev = rawSegments[i - 1], seg = rawSegments[i];
            if (F.attack[seg.u0]) continue;
            // Earlier is always allowed (a chord struck ahead of its beat).
            // Later only a little, and not past a bass that already moved on
            // the grid boundary (jazz comping: the bass carries the change, the
            // hit comes after it) - unless the late hit brings the new bass
            // itself, in which case that hit IS the change.
            const bassMovedHere = F.structBass[seg.u0] >= 0 && F.structBass[seg.u0] !== F.bassPc[seg.u0 - 1];
            const bringsBass = (u) => F.bassPc[u] !== F.bassPc[u - 1] && F.lowest[u] < F.lowest[u - 1];
            const cands = [];
            for (let u = prev.u0 + 1; u < seg.u1; u++) {
                if (!F.attack[u] || u === seg.u0) continue;
                const d = F.start[u] - seg.startBeat;
                if (d < 0 ? -d <= CFG.anchorReach : d <= CFG.anchorReachLater && (!bassMovedHere || bringsBass(u))) cands.push([Math.abs(d), u]);
            }
            if (!cands.length) continue;
            // Re-read both sides with the boundary at each candidate. The
            // labels of a misplaced cut are themselves wrong, so they cannot be
            // the judge; the fit of the two spans can. The NEAREST attack that
            // fits (almost) as well as the grid cut wins - a push just ahead of
            // the beat beats a re-strike further away that scores a bit higher.
            const pairScore = (u) => {
                const a = F.measure(prev.u0, u), b = F.measure(u, seg.u1);
                if (a.total < 1e-6 || b.total < 1e-6) return -Infinity;
                return spanScore(a, pickChord(a)) + spanScore(b, pickChord(b));
            };
            const here = pairScore(seg.u0);
            cands.sort((x, y) => x[0] - y[0]);
            const ok = cands.find(([, u]) => pairScore(u) >= here - CFG.anchorTolerance * Math.abs(here));
            if (!ok) continue;
            const best = ok[1];
            const mp = F.measure(prev.u0, best), ms = F.measure(best, seg.u1);
            Object.assign(prev, { endBeat: F.start[best], u1: best }, describeChord(mp, pickChord(mp)));
            Object.assign(seg, { startBeat: F.start[best], u0: best }, describeChord(ms, pickChord(ms)));
        }
        // 2. carry-over merge
        for (let i = 1; i < rawSegments.length; i++) {
            const prev = rawSegments[i - 1], seg = rawSegments[i];
            const u = seg.u0;
            if (F.attack[u] || F.structBass[u] >= 0 && F.structBass[u] !== F.bassPc[u - 1]) continue;
            // the later span on its own must be the earlier chord still ringing
            const ms = F.measure(seg.u0, seg.u1);
            let inPrev = 0;
            for (let pc = 0; pc < 12; pc++) if (prev.pcs.includes(pc)) inPrev += ms.wPlain[pc];
            if (inPrev < CFG.carryOverShare * ms.wPlain.reduce((x, y) => x + y, 0)) continue;
            const mu = F.measure(prev.u0, seg.u1);
            const ch = mu.total < 1e-6 ? null : pickChord(mu);
            if (!ch) continue;
            const d = describeChord(mu, ch);
            if (d.root !== prev.root || d.quality !== prev.quality) continue;
            Object.assign(prev, { endBeat: seg.endBeat, u1: seg.u1 }, d);
            rawSegments.splice(i, 1);
            i--;
        }
    }
    rawSegments.forEach((sg) => { delete sg.u0; delete sg.u1; });

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
        // Check the confirmed span so stricter slash-bass labels cannot move
        // or remove a chord boundary. Upper-voice occurrences of the bass
        // pitch class do not count as evidence here.
        if (seg.bass !== seg.root) {
            const bassInterval = (seg.bass - seg.root + 12) % 12;
            const core = CORE_TONES[seg.quality];
            const suspension = bassInterval === SUSPENDED_INTERVAL[seg.quality];
            const unusualBass = suspension || !core.includes(bassInterval);
            const from = fine.at(seg.startBeat), to = fine.at(seg.endBeat - 1e-6) + 1;
            const share = fine.bassShare(seg.bass, from, to);
            const m = fine.measure(from, to);
            const minToneWeight = CFG.inversionRootRatio * m.wPlain[seg.bass];

            // Gsus4/C and Csus2 spell exactly the same three notes. If all
            // three are substantial, prefer the spelling rooted in the bass.
            if (seg.quality === 'sus4' && suspension && share >= CFG.inversionBassShare) {
                const alt = describeChord(m, { root: seg.bass, quality: 'sus2', forcedTensionPc: -1 });
                if (alt.pcs.join(',') === seg.pcs.join(',')
                    && CORE_TONES.sus2.every(iv => m.wPlain[(alt.root + iv) % 12] >= minToneWeight)) {
                    Object.assign(seg, alt);
                }
            }
            if (seg.bass !== seg.root) {
                const minShare = unusualBass ? CFG.unusualBassShare : CFG.inversionBassShare;
                const requiredTones = unusualBass ? core : [0];
                if (share < minShare || requiredTones.some(iv => m.wPlain[(seg.root + iv) % 12] < minToneWeight)) {
                    seg.bass = seg.root;
                }
            }
        }
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
