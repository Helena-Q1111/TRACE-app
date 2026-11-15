// ========== CHORD EDITOR (full-screen overlay) ==========
// When the recognizer gets a chord wrong, the user corrects it here. The
// whole progression is laid out as a bar grid on a translucent overlay (a
// piece of 100+ chords does not fit in any side panel); a chord is changed by
// selecting it and typing its name and where it starts.
//
// The model is a list of chord STARTS: each chord lasts until the next one
// begins, so there are no overlaps or holes to reconcile. Edits go to a
// working copy; nothing reaches the scene until Apply, and invalid input is
// never applied - the field says what is wrong and keeps the old chord.
//
// Applied edits replace the recognizer's segments for this project and are
// saved with it (projects.js), so a reopened piece keeps its corrections.

let chordsEdited = false;           // analysisSegments carry user edits (saved with the project)
const ed = {
    open: false,
    chords: [],                     // [{startBeat, root, bass, quality, tensions, pcs, soundingPcs, edited}]
    sel: -1,
    undo: [],
    pieceEnd: 0,                    // in beats
    discardArmed: false
};

const chordEditorIsOpen = () => ed.open;
const edBpb = () => beatsPerBar;
const edStartOf = (seg) => (seg.bar - 1) * beatsPerBar + (seg.beatInBar || 0);
const edEndOf = (i) => (i + 1 < ed.chords.length ? ed.chords[i + 1].startBeat : ed.pieceEnd);
const edPos = (beat) => ({ bar: Math.floor(beat / edBpb() + 1e-9) + 1, beat: beat - Math.floor(beat / edBpb() + 1e-9) * edBpb() + 1 });
const edFmtBeat = (b) => String(Math.round(b * 100) / 100);
const edPosText = (beat) => { const p = edPos(beat); return `bar ${p.bar} · beat ${edFmtBeat(p.beat)}`; };
const edClone = (list) => list.map(c => ({ ...c, tensions: c.tensions.slice(), pcs: c.pcs.slice(), soundingPcs: c.soundingPcs.slice() }));

function edFromSegments(segs, edited) {
    return segs.map(s => ({
        startBeat: edStartOf(s), root: s.root, bass: s.bass ?? s.root, quality: s.quality,
        tensions: (s.tensions || []).slice(), pcs: s.pcs.slice(), soundingPcs: (s.soundingPcs || s.pcs).slice(),
        edited: edited ?? !!s.edited
    })).sort((a, b) => a.startBeat - b.startBeat);
}

function edPushUndo() {
    ed.undo.push({ chords: edClone(ed.chords), sel: ed.sel });
    if (ed.undo.length > 100) ed.undo.shift();
    ed.discardArmed = false;
}

// ---------------------------------------------------------------- open/close
function openChordEditor() {
    if (ed.open || isExporting || !analysisSegments.length) return;
    if (isPlaying) pausePlayback();
    ed.open = true;
    ed.chords = edFromSegments(analysisSegments);
    const lastSeg = analysisSegments[analysisSegments.length - 1];
    ed.pieceEnd = Math.max(edStartOf(lastSeg) + (lastSeg.durBeats || beatsPerBar),
        ...midiNoteSpans.map(n => n.endBeat));
    ed.undo = [];
    ed.discardArmed = false;
    ed.sel = Math.min(currentIndex, ed.chords.length - 1);
    const el = document.getElementById('chordEditor');
    el.hidden = false;
    document.getElementById('ceFile').textContent =
        (projects.find(p => p.id === activeProjectId) || {}).name || '';
    edRender();
    edSelect(ed.sel, false);
    edStatus('', '');
    requestAnimationFrame(() => {
        const b = el.querySelector('.ce-block.selected');
        if (b) b.scrollIntoView({ block: 'center' });
    });
}

function closeChordEditor() {
    ed.open = false;
    document.getElementById('chordEditor').hidden = true;
}

function edDirty() { return ed.undo.length > 0; }

function syncEditedBadge() {
    const b = document.getElementById('editedBadge');
    if (b) b.hidden = !chordsEdited;
}

function edCancel() {
    if (edDirty() && !ed.discardArmed) {
        ed.discardArmed = true;
        edStatus('Press Cancel (or Esc) again to discard your edits.', 'warn');
        return;
    }
    closeChordEditor();
}

function edApply() {
    const nameIn = document.getElementById('ceName');
    if (nameIn.classList.contains('invalid')) {
        edStatus('The chord name above is not valid - fix it or press Esc in the field to undo the typing.', 'error');
        nameIn.focus();
        return;
    }
    const t = playheadSec();
    const bpb = beatsPerBar;
    analysisSegments = ed.chords.map((c, i) => {
        const startBeat = c.startBeat, endBeat = edEndOf(i);
        const bar = Math.floor(startBeat / bpb + 1e-9) + 1;
        return {
            startBeat, endBeat, durBeats: endBeat - startBeat, bar, beatInBar: startBeat - (bar - 1) * bpb,
            root: c.root, bass: c.bass, quality: c.quality, tensions: c.tensions.slice(),
            pcs: c.pcs.slice(), soundingPcs: c.soundingPcs.slice(), edited: c.edited
        };
    });
    chordsEdited = ed.chords.some(c => c.edited);
    closeChordEditor();
    rebuildProgressionFromAnalysis();       // also saves the project (projects.js)
    seekToSec(t);
}

function edRevert() {
    edPushUndo();
    ed.chords = edFromSegments(analyzeMidiToSegments(midiNoteSpans, beatsPerBar), false);
    ed.sel = Math.min(ed.sel, ed.chords.length - 1);
    edRender();
    edSelect(ed.sel, false);
    edStatus('Back to the recognized chords. Apply to keep this, or Undo.', '');
}

function edUndo() {
    const s = ed.undo.pop();
    if (!s) { edStatus('Nothing to undo.', ''); return; }
    ed.chords = s.chords;
    edRender();
    edSelect(Math.min(s.sel, ed.chords.length - 1), false);
    edStatus('Undone.', '');
}

// ---------------------------------------------------------------- grid
function edBarsPerRow() {
    const w = document.getElementById('ceGrid').clientWidth || 1000;
    return Math.max(2, Math.min(8, Math.floor(w / 170)));
}

function edRender() {
    const grid = document.getElementById('ceGrid');
    const bpb = edBpb();
    const perRow = edBarsPerRow();
    const rowBeats = perRow * bpb;
    const nBars = Math.max(1, Math.ceil(ed.pieceEnd / bpb - 1e-9));
    const nRows = Math.ceil(nBars / perRow);
    const frag = document.createDocumentFragment();
    for (let r = 0; r < nRows; r++) {
        const r0 = r * rowBeats, r1 = r0 + rowBeats;
        const row = document.createElement('div');
        row.className = 'ce-row';
        const nums = document.createElement('div');
        nums.className = 'ce-nums';
        for (let b = 0; b < perRow; b++) {
            const bar = r * perRow + b + 1;
            const s = document.createElement('span');
            s.textContent = bar <= nBars ? bar : '';
            nums.appendChild(s);
        }
        const track = document.createElement('div');
        track.className = 'ce-track';
        track.dataset.r0 = r0;
        track.style.setProperty('--beats', rowBeats);
        track.style.setProperty('--bpb', bpb);
        const usedBeats = Math.min(rowBeats, ed.pieceEnd - r0);
        track.style.setProperty('--used', `${(usedBeats / rowBeats) * 100}%`);
        ed.chords.forEach((c, i) => {
            const s = c.startBeat, e = edEndOf(i);
            if (e <= r0 || s >= r1) return;
            const a = Math.max(s, r0), b = Math.min(e, r1);
            const blk = document.createElement('button');
            blk.className = 'ce-block' + (s < r0 ? ' cont' : '') + (c.edited ? ' edited' : '');
            blk.dataset.i = i;
            blk.style.left = `${((a - r0) / rowBeats) * 100}%`;
            blk.style.width = `${((b - a) / rowBeats) * 100}%`;
            blk.style.setProperty('--c', getChordColorHexStr({ ...c, bar: edPos(s).bar }));
            const label = getChordLabel(c);
            const roman = romanLabel(c, keyAtBar(edPos(s).bar), true);
            blk.title = `${label}  ·  ${roman}  ·  ${edPosText(s)}`;
            blk.innerHTML = s < r0 ? `<b>${label}</b>` : `<b>${label}</b><i>${roman}</i>`;
            track.appendChild(blk);
        });
        row.appendChild(nums);
        row.appendChild(track);
        frag.appendChild(row);
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
    document.getElementById('ceCount').textContent =
        `${ed.chords.length} chords` + (ed.chords.some(c => c.edited) ? ` · ${ed.chords.filter(c => c.edited).length} edited` : '');
    document.getElementById('ceUndo').disabled = ed.undo.length === 0;
    if (ed.sel >= 0) grid.querySelectorAll(`.ce-block[data-i="${ed.sel}"]`).forEach(b => b.classList.add('selected'));
}

// ---------------------------------------------------------------- inspector
function edSelect(i, focusName) {
    ed.sel = i;
    document.querySelectorAll('#ceGrid .ce-block').forEach(b => b.classList.toggle('selected', +b.dataset.i === i));
    const insp = document.getElementById('ceInspector');
    const c = ed.chords[i];
    insp.classList.toggle('empty', !c);
    edFieldError('');
    if (!c) return;
    const p = edPos(c.startBeat);
    const nameIn = document.getElementById('ceName');
    nameIn.value = getChordLabel(c);
    nameIn.classList.remove('invalid');
    document.getElementById('ceBar').value = p.bar;
    document.getElementById('ceBeat').value = edFmtBeat(p.beat);
    document.getElementById('ceBeat').max = edBpb() + 0.75;
    document.getElementById('ceBar').classList.remove('invalid');
    document.getElementById('ceBeat').classList.remove('invalid');
    edPreview(c);
    const blk = document.querySelector(`#ceGrid .ce-block.selected`);
    if (blk) blk.scrollIntoView({ block: 'nearest' });
    if (focusName) { nameIn.focus(); nameIn.select(); }
}

function edPreview(chord) {
    const out = document.getElementById('cePreview');
    if (!chord) { out.textContent = ''; return; }
    const bar = ed.chords[ed.sel] ? edPos(ed.chords[ed.sel].startBeat).bar : 1;
    const tones = chord.pcs.slice().sort((a, b) => ((a - chord.root + 12) % 12) - ((b - chord.root + 12) % 12))
        .map(pc => PITCH_NAMES[pc]).join(' ');
    out.innerHTML = `<b>${romanLabel(chord, keyAtBar(bar), true)}</b> in ${keyName(keyAtBar(bar))} · ${tones}`;
}

function edFieldError(msg, hint) {
    const el = document.getElementById('ceError');
    el.hidden = !msg;
    el.innerHTML = msg ? `${msg}${hint ? `<small>${hint}</small>` : ''}` : '';
}

function edStatus(msg, kind) {
    const el = document.getElementById('ceStatus');
    el.textContent = msg;
    el.className = 'ce-status' + (kind ? ` ${kind}` : '');
}

// Live: read what is typed, show the reading or what is wrong. Never commits.
function edOnNameInput() {
    const nameIn = document.getElementById('ceName');
    const r = parseChordName(nameIn.value);
    nameIn.classList.toggle('invalid', !r.ok);
    if (r.ok) { edFieldError(''); edPreview(r.chord); }
    else { edFieldError(r.error, r.hint); document.getElementById('cePreview').textContent = ''; }
    return r;
}

function edCommitName() {
    const c = ed.chords[ed.sel];
    if (!c) return;
    const r = edOnNameInput();
    if (!r.ok) return false;
    const same = getChordLabel(c) === r.label;
    if (same) return true;
    edPushUndo();
    Object.assign(c, r.chord, { edited: true });
    edRender();
    edSelect(ed.sel, false);
    edStatus(`${edPosText(c.startBeat)} is now ${r.label}.`, '');
    return true;
}

function edCommitPosition() {
    const c = ed.chords[ed.sel];
    if (!c) return;
    const barIn = document.getElementById('ceBar'), beatIn = document.getElementById('ceBeat');
    const bpb = edBpb();
    const nBars = Math.ceil(ed.pieceEnd / bpb - 1e-9);
    const bar = Number(barIn.value), beatRaw = Number(beatIn.value);
    barIn.classList.remove('invalid'); beatIn.classList.remove('invalid');
    const bad = (input, msg, hint) => { input.classList.add('invalid'); edFieldError(msg, hint); return false; };
    if (!Number.isInteger(bar) || bar < 1 || bar > nBars) {
        return bad(barIn, `Bar must be a whole number from 1 to ${nBars}.`);
    }
    if (!Number.isFinite(beatRaw) || beatRaw < 1 || beatRaw >= bpb + 1) {
        return bad(beatIn, `Beat must be from 1 to ${bpb + 0.75} (this piece has ${bpb} beats a bar).`,
            'Use .5 for an offbeat: 2.5 is the "and" of beat 2.');
    }
    const beat = Math.round(beatRaw * 4) / 4;
    const startBeat = (bar - 1) * bpb + (beat - 1);
    if (startBeat >= ed.pieceEnd - 1e-6) return bad(barIn, `The piece ends before ${edPosText(startBeat)}.`);
    const clash = ed.chords.findIndex((o, j) => j !== ed.sel && Math.abs(o.startBeat - startBeat) < 1e-6);
    if (clash >= 0) {
        return bad(beatIn, `${getChordLabel(ed.chords[clash])} already starts at ${edPosText(startBeat)}.`,
            'Select that chord to change it, or delete one of the two.');
    }
    edFieldError('');
    if (Math.abs(startBeat - c.startBeat) < 1e-6) { beatIn.value = edFmtBeat(beat); return true; }
    edPushUndo();
    c.startBeat = startBeat;
    c.edited = true;
    ed.chords.sort((a, b) => a.startBeat - b.startBeat);
    edRender();
    edSelect(ed.chords.indexOf(c), false);
    edStatus(`${getChordLabel(c)} now starts at ${edPosText(startBeat)}`
        + (beat !== beatRaw ? ` (rounded to the nearest quarter beat).` : '.'), '');
    return true;
}

function edDelete() {
    if (ed.sel < 0) return;
    if (ed.chords.length <= 1) { edStatus('A piece needs at least one chord.', 'error'); return; }
    edPushUndo();
    const [gone] = ed.chords.splice(ed.sel, 1);
    // the chord before stretches over the gap; flag it so the change is visible
    if (ed.chords[ed.sel - 1]) ed.chords[ed.sel - 1].edited = true;
    else if (ed.chords[0]) ed.chords[0].edited = true;
    edRender();
    edSelect(Math.max(0, ed.sel - 1), false);
    edStatus(`Deleted ${getChordLabel(gone)} at ${edPosText(gone.startBeat)}.`, '');
}

// Double-click on a beat: a new chord starts there, a copy of what sounds
// there until it is renamed.
function edAddAt(track, clientX) {
    const r = track.getBoundingClientRect();
    const beats = +track.style.getPropertyValue('--beats');
    const beat = +track.dataset.r0 + Math.floor(((clientX - r.left) / r.width) * beats);
    if (beat >= ed.pieceEnd) return;
    const at = ed.chords.findIndex(c => Math.abs(c.startBeat - beat) < 1e-6);
    if (at >= 0) { edSelect(at, true); return; }
    let src = 0;
    ed.chords.forEach((c, i) => { if (c.startBeat <= beat) src = i; });
    edPushUndo();
    const copy = { ...edClone([ed.chords[src]])[0], startBeat: beat, edited: true };
    ed.chords.push(copy);
    ed.chords.sort((a, b) => a.startBeat - b.startBeat);
    edRender();
    edSelect(ed.chords.indexOf(copy), true);
    edStatus(`New chord at ${edPosText(beat)} - type its name.`, '');
}

// ---------------------------------------------------------------- binding
function bindChordEditor() {
    const el = document.getElementById('chordEditor');
    if (!el) return;
    document.getElementById('editChordsBtn').onclick = openChordEditor;
    document.getElementById('ceApply').onclick = edApply;
    document.getElementById('ceCancel').onclick = edCancel;
    document.getElementById('ceRevert').onclick = edRevert;
    document.getElementById('ceUndo').onclick = edUndo;
    document.getElementById('ceDelete').onclick = edDelete;

    const grid = document.getElementById('ceGrid');
    grid.addEventListener('click', (e) => {
        const b = e.target.closest('.ce-block');
        if (b) edSelect(+b.dataset.i, false);
    });
    grid.addEventListener('dblclick', (e) => {
        const b = e.target.closest('.ce-block');
        const track = e.target.closest('.ce-track');
        if (!track) return;
        // on a block: add at that beat unless it is the block's own start
        edAddAt(track, e.clientX);
        if (b && window.getSelection) window.getSelection().removeAllRanges();
    });

    const nameIn = document.getElementById('ceName');
    nameIn.addEventListener('input', edOnNameInput);
    nameIn.addEventListener('change', edCommitName);
    nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (edCommitName() !== false) nameIn.select(); }
        if (e.key === 'Escape') {
            e.preventDefault();
            const c = ed.chords[ed.sel];
            if (c) { nameIn.value = getChordLabel(c); edOnNameInput(); edPreview(c); }
            nameIn.blur();
        }
    });
    ['ceBar', 'ceBeat'].forEach((id) => {
        const inp = document.getElementById(id);
        inp.addEventListener('change', edCommitPosition);
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); edCommitPosition(); }
            if (e.key === 'Escape') { e.preventDefault(); edSelect(ed.sel, false); inp.blur(); }
        });
    });

    // While open the editor owns the keyboard: nothing reaches the player
    // (Space), the file shortcut or the AE panel underneath.
    window.addEventListener('keydown', (e) => {
        if (!ed.open) {
            if ((e.key || '').toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey
                && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && progression.length) {
                e.preventDefault(); openChordEditor();
            }
            return;
        }
        e.stopPropagation();
        const typing = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
        if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 'z' && !typing) { e.preventDefault(); edUndo(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); edApply(); return; }
        if (typing) return;
        if (e.key === 'Escape') { e.preventDefault(); edCancel(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const n = ed.chords.length;
            edSelect(Math.max(0, Math.min(n - 1, ed.sel + (e.key === 'ArrowRight' ? 1 : -1))), false);
            const b = grid.querySelector('.ce-block.selected');
            if (b) b.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') { e.preventDefault(); edSelect(ed.sel, true); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); edDelete(); }
    }, true);
    window.addEventListener('resize', () => { if (ed.open) edRender(); });
}
