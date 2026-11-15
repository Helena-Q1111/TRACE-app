// ========== TIMELINE: progress bar + seeking (inside the control strip) ==========
// One hairline track for the whole piece, cut into the chords that make it up
// (each in its own colour), the played part bright, the rest faint. Click or
// drag anywhere to seek - to that moment, not just to the chord's start, so
// audio and visuals resume mid-chord exactly where the head is.

let _tlCanvas = null, _tlCtx = null, _tlTip = null;
let _tlDragging = false;
let _tlPendingSec = null;        // where the head is held while dragging
let _tlLastSeekAt = 0;

const pieceEndSec = () => (progression.length ? chordEndSec(progression[progression.length - 1]) : 0);

// Where playback is now, in seconds from the top of the MIDI
function playheadSec() {
    if (_tlPendingSec !== null) return _tlPendingSec;
    if (!progression.length) return 0;
    if (isPlaying && midiStartTime) return (Date.now() - midiStartTime) / 1000;
    if (pausedElapsedSec !== null) return pausedElapsedSec;
    const c = progression[currentIndex];
    return c ? chordStartSec(c) + (pausedVisualElapsedMs || 0) / 1000 : 0;
}

function chordIndexAtSec(t) {
    let idx = 0;
    for (let i = 0; i < progression.length; i++) {
        if (chordStartSec(progression[i]) <= t + 1e-6) idx = i; else break;
    }
    return idx;
}

// Seek audio + visuals to an arbitrary moment. `rebuild` re-renders the
// revealed path (the expensive part); dragging only does it when the head
// crosses into another chord.
function seekToSec(t, rebuild = true) {
    if (isExporting || !progression.length) return;
    t = Math.max(0, Math.min(pieceEndSec() - 0.01, t));
    const idx = chordIndexAtSec(t);
    const changed = idx !== currentIndex;
    currentIndex = idx;
    const offsetMs = Math.max(0, (t - chordStartSec(progression[idx])) * 1000);
    audioSeekToBeat(t * bpm / 60);
    lastBeatTime = Date.now() - offsetMs;
    pausedVisualElapsedMs = isPlaying ? null : offsetMs;
    if (changed || rebuild) {
        snapLightToCurrent();
        updateUI();
        renderProgression();
    }
}

function timelineX(t, w) { return (t / Math.max(1e-6, pieceEndSec())) * w; }

function updateTimeline() {
    if (!_tlCtx || !progression.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = _tlCanvas.clientWidth, h = _tlCanvas.clientHeight;
    if (!w) return;
    if (_tlCanvas.width !== Math.round(w * dpr) || _tlCanvas.height !== Math.round(h * dpr)) {
        _tlCanvas.width = Math.round(w * dpr); _tlCanvas.height = Math.round(h * dpr);
    }
    const g = _tlCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.body);
    const ink = css.getPropertyValue('--text').trim();
    const faint = css.getPropertyValue('--panel-border').trim();
    const now = playheadSec();
    const y = Math.round(h / 2) - 1.5, th = 3;

    g.fillStyle = faint;
    g.fillRect(0, y, w, th);
    progression.forEach((c, i) => {
        const x0 = timelineX(chordStartSec(c), w), x1 = timelineX(chordEndSec(c), w);
        g.globalAlpha = i <= currentIndex ? 0.95 : 0.28;
        g.fillStyle = getChordColorHexStr(c);
        g.fillRect(x0, y, Math.max(1, x1 - x0 - 1), th);      // 1px gap marks each change
    });
    g.globalAlpha = 1;
    // bar ticks every 4 bars, faint, above the track
    const barSec = beatsPerBar * 60 / bpm;
    const nBars = Math.ceil(pieceEndSec() / barSec);
    const every = nBars > 64 ? 8 : 4;
    g.fillStyle = faint;
    for (let b = every; b < nBars; b += every) g.fillRect(Math.round(timelineX(b * barSec, w)), y - 4, 1, 3);
    // the head
    const hx = Math.round(timelineX(now, w));
    g.fillStyle = ink;
    g.fillRect(hx - 0.5, y - 5, 1.5, th + 10);
}

function bindTimeline() {
    _tlCanvas = document.getElementById('timeline');
    _tlTip = document.getElementById('timelineTip');
    if (!_tlCanvas) return;
    _tlCtx = _tlCanvas.getContext('2d');
    const secAt = (e) => {
        const r = _tlCanvas.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * pieceEndSec();
    };
    const showTip = (e) => {
        if (!progression.length) return;
        const t = secAt(e), c = progression[chordIndexAtSec(t)];
        const beat = t * bpm / 60;
        const bar = Math.floor(beat / beatsPerBar) + 1;
        const r = _tlCanvas.getBoundingClientRect();
        _tlTip.textContent = `bar ${bar} · ${c.absLabel}`;
        _tlTip.hidden = false;
        _tlTip.style.left = `${e.clientX - r.left}px`;
    };
    _tlCanvas.addEventListener('pointerdown', (e) => {
        if (isExporting || !progression.length) return;
        _tlDragging = true;
        _tlCanvas.setPointerCapture(e.pointerId);
        _tlPendingSec = secAt(e);
        seekToSec(_tlPendingSec, false);
        showTip(e);
    });
    _tlCanvas.addEventListener('pointermove', (e) => {
        showTip(e);
        if (!_tlDragging) return;
        _tlPendingSec = secAt(e);
        const now = performance.now();
        if (now - _tlLastSeekAt > 60) { _tlLastSeekAt = now; seekToSec(_tlPendingSec, false); }
    });
    const end = (e) => {
        if (!_tlDragging) return;
        _tlDragging = false;
        const t = secAt(e);
        _tlPendingSec = null;
        seekToSec(t, true);
    };
    _tlCanvas.addEventListener('pointerup', end);
    _tlCanvas.addEventListener('pointercancel', end);
    _tlCanvas.addEventListener('pointerleave', () => { if (!_tlDragging) _tlTip.hidden = true; });
}
