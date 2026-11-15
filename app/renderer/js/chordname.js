// ========== CHORD NAME PARSER (used by the chord editor) ==========
// Reads what a musician types - "Am7", "F#m7b5", "Cmaj7(9,13)/E", "G7#11",
// "Bb6", "Dsus", "C/D" - into the recognizer's own chord shape
// {root, bass, quality, tensions, pcs, soundingPcs}, so an edited chord goes
// through exactly the same lookup, colours and labels as a recognized one.
// Everything getChordLabel() prints parses back to the same chord.
//
// It never guesses: anything it cannot read comes back as
// {ok: false, error, hint} naming the part that failed, and the editor will
// not apply a chord until it parses.

const NOTE_LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Quality spellings, longest first so "m7b5" wins over "m7" and "m".
// Each maps to a core quality plus tensions implied by the shorthand
// (C9 = C7 with a 9th, C6 = C with a 13th: maj6 is not in the vocabulary
// because its pitch classes are those of Am7 - see config.js).
const QUALITY_SPELLINGS = [
    // half-diminished / diminished sevenths
    ['m7b5', 'm7b5'], ['min7b5', 'm7b5'], ['-7b5', 'm7b5'], ['ø7', 'm7b5'], ['ø', 'm7b5'], ['h7', 'm7b5'],
    ['dim7', 'dim7'], ['°7', 'dim7'], ['o7', 'dim7'],
    // minor-major seventh
    ['mmaj7', 'minMaj7'], ['minmaj7', 'minMaj7'], ['m(maj7)', 'minMaj7'], ['-maj7', 'minMaj7'], ['mΔ7', 'minMaj7'], ['-Δ7', 'minMaj7'],
    // suspended sevenths
    ['7sus4', 'dom7sus4'], ['7sus2', 'dom7sus2'], ['7sus', 'dom7sus4'],
    // ninths / elevenths / thirteenths (shorthand for a seventh plus tensions)
    ['maj13', 'maj7', [2, 9]], ['maj11', 'maj7', [2, 5]], ['maj9', 'maj7', [2]],
    ['m13', 'min7', [2, 9]], ['m11', 'min7', [2, 5]], ['m9', 'min7', [2]],
    ['min9', 'min7', [2]], ['-9', 'min7', [2]],
    // sevenths
    ['maj7', 'maj7'], ['ma7', 'maj7'], ['M7', 'maj7'], ['Δ7', 'maj7'], ['Δ', 'maj7'],
    ['min7', 'min7'], ['m7', 'min7'], ['-7', 'min7'],
    ['13', 'dominant7', [2, 9]], ['11', 'dominant7', [2, 5]], ['9', 'dominant7', [2]],
    ['7', 'dominant7'],
    // sixths and added tones
    ['m6', 'minor', [9]], ['min6', 'minor', [9]], ['6', 'major', [9]],
    ['madd9', 'minor', [2]], ['add9', 'major', [2]], ['add11', 'major', [5]], ['add2', 'major', [2]],
    // triads
    ['sus2', 'sus2'], ['sus4', 'sus4'], ['sus', 'sus4'],
    ['dim', 'dim'], ['°', 'dim'], ['o', 'dim'],
    ['aug', 'aug'], ['+', 'aug'],
    ['maj', 'major'], ['M', 'major'],
    ['min', 'minor'], ['m', 'minor'], ['-', 'minor'],
    ['', 'major']
];

// Tension spellings -> interval above the root
const TENSION_SPELLINGS = {
    'b9': 1, '9': 2, '#9': 3, '11': 5, '#11': 6, 'b13': 8, '13': 9,
    'b5': null, '#5': null       // altered 5ths are qualities here (dim/aug, m7b5), not tensions
};

const CHORD_EXAMPLES = 'C, Am7, F#m7b5, Bbmaj7(9), G7(b9,#11), Dsus4, E/G#';

// "#" and "b" in every spelling; the app prints ♯ ♭ (and Δ, °, ø as-is)
function normalizeChordText(s) {
    return String(s || '').trim().replace(/\s+/g, '')
        .replace(/♯/g, '#').replace(/♭/g, 'b').replace(/[–—−]/g, '-');
}

function parseNote(s) {
    const m = /^([A-Ga-g])([#b]{0,2})/.exec(s);
    if (!m) return null;
    let pc = NOTE_LETTER_PC[m[1].toUpperCase()];
    for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
    return { pc: ((pc % 12) + 12) % 12, len: m[0].length };
}

function parseChordName(text) {
    const fail = (error, hint) => ({ ok: false, error, hint: hint || `Examples: ${CHORD_EXAMPLES}` });
    let s = normalizeChordText(text);
    if (!s) return fail('Type a chord name.');
    if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) {
        return fail('A bracket is not closed.', 'Tensions go in one pair of brackets: Cmaj7(9,13).');
    }

    // ---- bass: everything after the last "/" that is not inside brackets ----
    let bass = null;
    const slash = s.lastIndexOf('/');
    if (slash > 0 && s.indexOf(')', slash) < 0) {
        const bassText = s.slice(slash + 1);
        const b = parseNote(bassText);
        if (!b || b.len !== bassText.length) {
            return fail(`"/${bassText}" is not a bass note.`, 'After the slash write a note name, e.g. C/E or F#m/A.');
        }
        bass = b.pc;
        s = s.slice(0, slash);
    }

    // ---- root ----
    const r = parseNote(s);
    if (!r) {
        const c = s[0];
        return fail(/[Hh]/.test(c) ? '"H" is not used here - write B (and Bb for the German B).'
            : `"${c}" is not a note name.`, 'The root is a letter A-G, optionally with # or b: C, F#, Bb.');
    }
    if (s[0] !== s[0].toUpperCase()) {
        // "am7" is unambiguous enough to accept, but say what was read
    }
    const root = r.pc;
    let rest = s.slice(r.len);

    // ---- tensions in brackets: (9,13), (b9 #11) ----
    let bracketTensions = [];
    const br = /\(([^()]*)\)$/.exec(rest);
    if (br && !/^\(maj7\)$/i.test(br[0])) {
        bracketTensions = br[1].split(/[,\s]+/).filter(Boolean);
        rest = rest.slice(0, br.index);
    }

    // ---- quality: the longest spelling that matches at the front ----
    let spelling = null;
    for (const sp of QUALITY_SPELLINGS) {
        const caseSensitive = /^M/.test(sp[0]);        // M7 is major, m7 is minor
        const head = caseSensitive ? rest.slice(0, sp[0].length) : rest.slice(0, sp[0].length).toLowerCase();
        const want = caseSensitive ? sp[0] : sp[0].toLowerCase();
        if (head === want) { spelling = sp; break; }
    }
    const [qText, quality, implied = []] = spelling;
    rest = rest.slice(qText.length);

    // ---- trailing tensions without brackets: G7b9#11, C7#9 ----
    const loose = [];
    while (rest.length) {
        const m = /^(add)?([#b]?)(13|11|9|5)/i.exec(rest);
        if (!m) break;
        loose.push(m[2] + m[3]);
        rest = rest.slice(m[0].length);
    }
    if (rest.length) {
        return fail(`"${rest}" is not a chord quality I know.`,
            'Qualities: m, dim, aug, sus2, sus4, 7, maj7, m7, mMaj7, m7b5, dim7, 7sus4, 6, 9, add9. '
            + 'Tensions go after it: C7(b9), Cmaj7#11.');
    }

    // ---- assemble the tone set ----
    const core = CORE_TONES[quality];
    const tensions = new Set(implied);
    for (const t of bracketTensions.concat(loose)) {
        if (!(t in TENSION_SPELLINGS)) {
            return fail(`"${t}" is not a tension.`, 'Tensions: b9, 9, #9, 11, #11, b13, 13.');
        }
        const iv = TENSION_SPELLINGS[t];
        if (iv === null) {
            return fail(`An altered 5th (${t}) is part of the quality here.`,
                'Write it as the quality: Cdim, Caug, Cm7b5.');
        }
        if (core.includes(iv)) {
            const label = PITCH_NAMES[root] + (QUALITY_SUFFIX[quality] ?? '');
            return fail(`${t} is already a chord tone of ${label}.`,
                `Drop the (${t}), or pick a quality without that tone.`);
        }
        tensions.add(iv);
    }

    const tonePcs = new Set(core.map(iv => (root + iv) % 12));
    tensions.forEach(iv => tonePcs.add((root + iv) % 12));
    const b = bass ?? root;
    tonePcs.add(b);                 // a bass outside the chord (C/D) still sounds
    const order = TENSION_DEFS.map(d => d.iv);
    const chord = {
        root, bass: b, quality,
        tensions: [...tensions].sort((x, y) => order.indexOf(x) - order.indexOf(y)),
        pcs: [...tonePcs].sort((x, y) => x - y)
    };
    chord.soundingPcs = chord.pcs.slice();
    return { ok: true, chord, label: getChordLabel(chord) };
}
