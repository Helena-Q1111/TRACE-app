// ========== UI (sidebar, info panel, controls, circle of fifths) ==========

// Jump the playhead to a chord (from the move panel's timeline).
function jumpToChord(idx) {
    if (isExporting || !progression[idx]) return;   // no seeking while recording
    currentIndex = idx;
    snapLightToCurrent();
    audioSeekToChord(idx);           // keep audio in lockstep with the visuals
    lastBeatTime = Date.now();       // visual segment restarts at chord start,
    pausedVisualElapsedMs = null;    // matching the audio seek position
    updateUI();
    renderProgression();
}

function updateUI() {
    updateMovePanel();
    if (typeof markAeVizDirty === 'function') markAeVizDirty();
}

// ---- Move panel ----
// The step just taken, explained three ways: what TPS says it costs
// (delta = i + j + k, the quantity the model is trained to reproduce as
// distance), how each chord tone travelled, and where the piece now stands
// relative to I over the whole piece. `from I` replaced the old `t`, which
// measured from the latent ORIGIN - a point with no musical meaning; the radar
// and the HUD already measured from I.
const MV_HISTORY = 4;
const DELTA_SCALE = 14;              // full stack bar: j <= 6, k rarely > 8
const homeDistance = (c) => euclideanDistance(c.coords, TONIC_I_COORDS);

function updateMovePanel() {
    const panel = document.getElementById('movePanel');
    if (!panel) return;
    panel.hidden = progression.length === 0;
    if (panel.hidden) return;

    const cur = progression[currentIndex];
    const prev = currentIndex > 0 ? progression[currentIndex - 1] : null;
    const chip = (el, chord) => {
        el.querySelector('b').textContent = chord ? chord.absLabel : 'start';
        el.querySelector('.mv-dot').style.background = chord ? getChordColorHexStr(chord) : 'transparent';
    };
    chip(document.getElementById('mvFrom'), prev);
    chip(document.getElementById('mvTo'), cur);
    document.getElementById('mvWhere').textContent = prev
        ? `chord ${currentIndex} → ${currentIndex + 1} · bar ${cur.bar}`
        : `chord 1 / ${progression.length} · bar ${cur.bar}`;

    const t = prev ? tpsMove(prev, cur) : { i: 0, j: 0, k: 0, delta: 0 };
    const dash = (v) => (prev ? String(v) : '–');
    document.getElementById('mvDelta').textContent = dash(t.delta);
    document.getElementById('mvI').textContent = dash(t.i);
    document.getElementById('mvJ').textContent = dash(t.j);
    document.getElementById('mvK').textContent = dash(t.k);
    const [si, sj, sk] = document.getElementById('mvStack').children;
    const w = (v) => `${Math.min(100, 100 * v / DELTA_SCALE)}%`;
    si.style.width = w(t.i); sj.style.width = w(t.j); sk.style.width = w(t.k);
    document.getElementById('mvDz').textContent =
        prev ? euclideanDistance(prev.coords, cur.coords).toFixed(2) : '–';

    drawVoiceLeading(prev, cur);
    drawHomeArc(prev, cur);
    updateMoveHistory();
}

// ---- Chord-tone motion ----
// Pair the tones of the two chords so the total motion is smallest: common
// tones stay put, the rest are matched by the shortest semitone step (either
// direction), and whatever is left over appeared or vanished. Chords hold at
// most ~7 tones, so trying every assignment is cheap.
function voiceLeading(fromPcs, toPcs) {
    const A = [...new Set(fromPcs)], B = [...new Set(toPcs)];
    const common = A.filter(p => B.includes(p));
    const ra = A.filter(p => !common.includes(p)), rb = B.filter(p => !common.includes(p));
    const step = (a, b) => { const d = ((b - a) % 12 + 12) % 12; return d > 6 ? d - 12 : d; };
    const small = ra.length <= rb.length ? ra : rb, big = small === ra ? rb : ra;
    let best = null;
    const used = new Array(big.length).fill(false), pick = [];
    (function search(n, cost) {
        if (best && cost >= best.cost) return;
        if (n === small.length) { best = { cost, pick: pick.slice() }; return; }
        for (let q = 0; q < big.length; q++) {
            if (used[q]) continue;
            used[q] = true; pick.push(q);
            search(n + 1, cost + Math.abs(step(small[n], big[q])));
            used[q] = false; pick.pop();
        }
    })(0, 0);
    const moves = (best ? best.pick : []).map((q, n) => small === ra
        ? { from: ra[n], to: rb[q] } : { from: ra[q], to: rb[n] });
    moves.forEach(m => { m.step = step(m.from, m.to); });
    const matchedA = new Set(moves.map(m => m.from)), matchedB = new Set(moves.map(m => m.to));
    return {
        common, moves,
        dropped: ra.filter(p => !matchedA.has(p)),
        added: rb.filter(p => !matchedB.has(p))
    };
}

// Two rows of a 12-column chromatic ruler (starting on the key's tonic): the
// last chord's tones on top, this chord's below. Held tones are straight
// verticals, moved tones slant by their step (labelled in semitones), and a
// tone with no partner is marked as dropped (x) or added (ring).
function mvCanvas(id) {
    const cv = document.getElementById(id);
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 244, h = cv.clientHeight || 50;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.body);
    return { ctx, w, h, text: css.getPropertyValue('--text').trim(), dim: css.getPropertyValue('--text-dim').trim() };
}

function drawVoiceLeading(prev, cur) {
    const { ctx, w, h, text, dim } = mvCanvas('mvVoices');
    const k = keyAtBar(cur.bar);
    const origin = k.tonic;
    const col = (pc) => ((pc - origin) % 12 + 12) % 12;
    const cw = w / 12, x = (c) => cw * (c + 0.5);
    const yTop = 9, yBot = h - 9, yMid = h / 2;
    const cTo = getChordColorHexStr(cur), cFrom = prev ? getChordColorHexStr(prev) : dim;

    // ruler: note names on the middle line, the tonic column marked
    ctx.font = '500 8px "IBM Plex Mono", Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let c = 0; c < 12; c++) {
        ctx.fillStyle = dim;
        ctx.globalAlpha = c === 0 ? 0.9 : 0.45;
        ctx.fillText(PITCH_NAMES[(origin + c) % 12], x(c), yMid);
    }
    ctx.globalAlpha = 1;

    const dot = (pc, y, color, r) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(col(pc)), y, r, 0, Math.PI * 2); ctx.fill(); };
    if (!prev) {
        cur.pcs.forEach(pc => dot(pc, yBot, cTo, 4));
        document.getElementById('mvVoiceNote').textContent = '';
        return;
    }
    const vl = voiceLeading(prev.pcs, cur.pcs);

    ctx.lineWidth = 1.4;
    // held
    vl.common.forEach((pc) => {
        ctx.strokeStyle = text; ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(x(col(pc)), yTop + 4); ctx.lineTo(x(col(pc)), yMid - 6);
        ctx.moveTo(x(col(pc)), yMid + 6); ctx.lineTo(x(col(pc)), yBot - 4); ctx.stroke();
    });
    // moved: slant by the step; a move across the ruler's edge leaves one side
    // and re-enters the other, so it is drawn in two halves
    ctx.globalAlpha = 0.85;
    vl.moves.forEach((m) => {
        const x0 = x(col(m.from)), x1raw = x0 + m.step * cw;
        const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
        grad.addColorStop(0, cFrom); grad.addColorStop(1, cTo);
        ctx.strokeStyle = grad;
        const seg = (dx) => { ctx.beginPath(); ctx.moveTo(x0 + dx, yTop + 4); ctx.lineTo(x1raw + dx, yBot - 4); ctx.stroke(); };
        seg(0);
        if (x1raw < 0) seg(w); else if (x1raw > w) seg(-w);
        // step label beside the line, where it crosses the ruler row
        const lx = ((x0 + x1raw) / 2 + w) % w;
        ctx.globalAlpha = 1;
        ctx.fillStyle = text;
        ctx.font = '700 8px "IBM Plex Mono", Consolas, monospace';
        ctx.fillText((m.step > 0 ? '+' : '') + m.step, lx + (m.step > 0 ? 7 : -7), yMid - 8);
        ctx.globalAlpha = 0.85;
    });
    ctx.globalAlpha = 1;

    // the tones themselves
    prev.pcs.forEach(pc => dot(pc, yTop, cFrom, 3));
    cur.pcs.forEach(pc => dot(pc, yBot, cTo, 4));
    ctx.lineWidth = 1.3;
    vl.dropped.forEach((pc) => {        // vanished: an x over the old tone
        const cx = x(col(pc)); ctx.strokeStyle = text; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(cx - 4, yTop + 6); ctx.lineTo(cx + 4, yTop + 14);
        ctx.moveTo(cx + 4, yTop + 6); ctx.lineTo(cx - 4, yTop + 14); ctx.stroke();
    });
    vl.added.forEach((pc) => {          // appeared: a ring round the new tone
        ctx.strokeStyle = cTo; ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x(col(pc)), yBot, 6.5, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.globalAlpha = 1;

    const parts = [];
    if (vl.common.length) parts.push(`${vl.common.length} held`);
    if (vl.moves.length) parts.push(`${vl.moves.length} moved`);
    if (vl.added.length) parts.push(`+${vl.added.length}`);
    if (vl.dropped.length) parts.push(`−${vl.dropped.length}`);
    document.getElementById('mvVoiceNote').textContent = parts.join(' · ');
}

// Distance from I over the whole piece: played part solid, the rest faint,
// the last chord hollow and this one solid. Click anywhere to jump there.
function drawHomeArc(prev, cur) {
    const { ctx, w, h, text, dim } = mvCanvas('mvArc');
    const n = progression.length;
    const far = Math.max(1, ...progression.map(homeDistance)) * 1.08;
    const px = (i) => (n === 1 ? w / 2 : 4 + (w - 8) * i / (n - 1));
    const py = (d) => h - 4 - (h - 10) * d / far;

    // baseline = home
    ctx.strokeStyle = dim; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, py(0)); ctx.lineTo(w, py(0)); ctx.stroke();
    ctx.globalAlpha = 0.6; ctx.fillStyle = dim;
    ctx.font = '500 8px "IBM Plex Mono", Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('I', 1, py(0) - 1);

    const path = (a, b) => { ctx.beginPath(); for (let i = a; i <= b; i++) { const X = px(i), Y = py(homeDistance(progression[i])); i === a ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); } ctx.stroke(); };
    ctx.lineWidth = 1.2; ctx.strokeStyle = text;
    ctx.globalAlpha = 0.18; path(0, n - 1);                 // the whole piece, faint
    ctx.globalAlpha = 0.9;  path(0, currentIndex);          // what has been played
    // coloured stops for the played chords
    for (let i = 0; i <= currentIndex; i++) {
        ctx.globalAlpha = i === currentIndex ? 1 : 0.55;
        ctx.fillStyle = getChordColorHexStr(progression[i]);
        ctx.beginPath(); ctx.arc(px(i), py(homeDistance(progression[i])), i === currentIndex ? 3.6 : 1.8, 0, Math.PI * 2); ctx.fill();
    }
    if (prev) {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = text; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px(currentIndex - 1), py(homeDistance(prev)), 3.6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const now = homeDistance(cur), was = prev ? homeDistance(prev) : now;
    const arrow = !prev || Math.abs(now - was) < 0.05 ? '' : now > was ? ' ↗ away' : ' ↘ home';
    document.getElementById('mvHome').textContent = prev
        ? `${was.toFixed(1)} → ${now.toFixed(1)}${arrow}` : now.toFixed(1);
}

// Recent moves under the current one. Rows are keyed by the chord a move
// arrives at, so a row that is still wanted is reused (it just gets fainter)
// and one that ages out fades away instead of vanishing.
function updateMoveHistory() {
    const box = document.getElementById('mvHistory');
    const want = [];
    for (let a = currentIndex - 1; a >= 1 && want.length < MV_HISTORY; a--) want.push(a);
    const rows = new Map([...box.children].filter(r => !r.classList.contains('leaving')).map(r => [+r.dataset.to, r]));
    rows.forEach((row, key) => {
        if (want.includes(key)) return;
        row.classList.add('leaving');
        setTimeout(() => row.remove(), 460);
    });
    want.forEach((to, age) => {
        let row = rows.get(to);
        if (!row) {
            const a = progression[to - 1], b = progression[to];
            const t = tpsMove(a, b);
            row = document.createElement('div');
            row.className = 'mv-hist entering';
            row.dataset.to = to;
            row.innerHTML = `<i class="mv-dot" style="background:${getChordColorHexStr(a)}"></i><span class="nm"></span>`
                + `<span class="ar">→</span><i class="mv-dot" style="background:${getChordColorHexStr(b)}"></i><span class="nm"></span>`
                + `<span class="dl">δ ${t.delta} · ${euclideanDistance(a.coords, b.coords).toFixed(1)}</span>`;
            const names = row.querySelectorAll('.nm');
            names[0].textContent = a.absLabel; names[1].textContent = b.absLabel;
        }
        box.appendChild(row);                  // (re)order: newest first
        row.style.opacity = String(0.85 - age * 0.18);
        if (row.classList.contains('entering')) {
            // Flush the entering style before dropping it, so the fade-in runs.
            // (Not rAF: that never fires while the window is in the background.)
            void row.offsetHeight;
            row.classList.remove('entering');
        }
    });
    // leaving rows stay at the end while they fade
    [...box.children].filter(r => r.classList.contains('leaving')).forEach(r => box.appendChild(r));
}

// Timeline click -> nearest chord
function bindMovePanel() {
    const arc = document.getElementById('mvArc');
    if (!arc) return;
    arc.addEventListener('click', (e) => {
        const n = progression.length;
        if (!n) return;
        const r = arc.getBoundingClientRect();
        const f = (e.clientX - r.left - 4) / Math.max(1, r.width - 8);
        jumpToChord(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
    });
}

// Single entry points for play/pause: guard against repeated triggers
// (double-play used to reset the audio pointer -> overlapping notes) and
// preserve elapsed-in-segment across pauses so the visuals resume exactly
// where the audio does (repeated space no longer drifts them apart).
async function startPlayback() {
    if (isPlaying || isExporting) return;
    isPlaying = true;
    lastBeatTime = Date.now() - (pausedVisualElapsedMs ?? 0);
    pausedVisualElapsedMs = null;
    audioPlay();          // fresh start or resume from pause
    await Tone.start();   // resume Tone.js context if needed
}

function pausePlayback() {
    if (!isPlaying || isExporting) return;
    isPlaying = false;
    pausedVisualElapsedMs = Date.now() - lastBeatTime;
    audioPause();         // release all sounding voices, remember position
}

function bindControls() {
    document.getElementById('playBtn').onclick = startPlayback;
    document.getElementById('pauseBtn').onclick = pausePlayback;
    document.getElementById('restartBtn').onclick = () => {
        if (isExporting) return;
        currentIndex = 0;
        isPlaying = false;
        pausedVisualElapsedMs = null;
        audioRestart();
        snapLightToCurrent();
        updateUI();
        renderProgression();
    };
    document.getElementById('exportBtn').onclick = () => startVideoExport();

    // MIDI import (file picker, drag and drop, cached projects) lives in projects.js

    document.getElementById('bpmSlider').oninput = (e) => {
        setTiming(parseInt(e.target.value), null, 'manual override');
    };

    // Spacebar toggles play/pause (ignore when typing in inputs)
    window.addEventListener('keydown', (e) => {
        if (e.code !== 'Space') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        e.preventDefault();
        if (isPlaying) pausePlayback(); else startPlayback();
    });

    bindSidebar();
    bindAppearance();
    bindKeyUI();
}

// ---- Key / modulation UI ----
const KEY_OPTIONS = (() => {
    const opts = [];
    for (let t = 0; t < 12; t++) opts.push({ tonic: t, mode: 'major' });
    for (let t = 0; t < 12; t++) opts.push({ tonic: t, mode: 'minor' });
    return opts;
})();

function keyOptionHtml(selected) {
    return KEY_OPTIONS.map((k, i) => {
        const sel = (k.tonic === selected.tonic && k.mode === selected.mode) ? ' selected' : '';
        return `<option value="${i}"${sel}>${keyName(k)}${k.mode === 'major' ? ' 大调' : ' 小调'}</option>`;
    }).join('');
}

// Refresh key section widgets from state (called after auto-guess)
function syncKeyUI() {
    const mainSel = document.getElementById('mainKeySelect');
    mainSel.innerHTML = keyOptionHtml(keySignature);
    renderModList();
}

function renderModList() {
    const listEl = document.getElementById('modList');
    listEl.innerHTML = '';
    keyModulations.forEach((m, idx) => {
        const row = document.createElement('div');
        row.className = 'mod-row';
        row.innerHTML = `
            <span>第</span>
            <input type="number" class="mod-bar" min="1" value="${m.bar}">
            <span>小节 →</span>
            <select class="key-select mod-key">${keyOptionHtml(m)}</select>
            <button class="icon-btn mod-del" title="删除">×</button>
        `;
        row.querySelector('.mod-bar').onchange = (e) => {
            m.bar = Math.max(1, parseInt(e.target.value) || 1);
            sortModulations();
            rebuildProgressionFromAnalysis();
        };
        row.querySelector('.mod-key').onchange = (e) => {
            const k = KEY_OPTIONS[parseInt(e.target.value)];
            m.tonic = k.tonic; m.mode = k.mode;
            rebuildProgressionFromAnalysis();
        };
        row.querySelector('.mod-del').onclick = () => {
            keyModulations.splice(idx, 1);
            renderModList();
            rebuildProgressionFromAnalysis();
        };
        listEl.appendChild(row);
    });
}

function sortModulations() {
    keyModulations.sort((a, b) => a.bar - b.bar);
    renderModList();
}

function bindKeyUI() {
    document.getElementById('mainKeySelect').onchange = (e) => {
        const k = KEY_OPTIONS[parseInt(e.target.value)];
        keySignature = { tonic: k.tonic, mode: k.mode };
        estimatedTonic = k.tonic;
        rebuildProgressionFromAnalysis();
    };
    document.getElementById('addModBtn').onclick = () => {
        const lastBar = progression.length ? progression[progression.length - 1].bar : 1;
        keyModulations.push({
            bar: Math.min(lastBar, Math.floor(lastBar / 2) + 1),
            tonic: keySignature.tonic,
            mode: keySignature.mode
        });
        sortModulations();
        rebuildProgressionFromAnalysis();
    };
}

// ---- Sidebar: collapse / expand / drag-stretch ----
function bindSidebar() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('collapseBtn');
    const expandBtn = document.getElementById('expandBtn');
    const handle = document.getElementById('resizeHandle');

    collapseBtn.onclick = () => {
        sidebar.dataset.lastWidth = sidebar.style.width || '';
        sidebar.style.width = '';
        sidebar.classList.add('collapsed');
        expandBtn.hidden = false;
    };
    expandBtn.onclick = () => {
        sidebar.classList.remove('collapsed');
        if (sidebar.dataset.lastWidth) sidebar.style.width = sidebar.dataset.lastWidth;
        expandBtn.hidden = true;
    };

    // Drag the right edge to stretch the sidebar (200-420px)
    let resizing = false;
    handle.addEventListener('mousedown', (e) => {
        resizing = true;
        sidebar.style.transition = 'none';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        sidebar.style.width = Math.max(200, Math.min(420, e.clientX)) + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        sidebar.style.transition = '';
    });
}

// ---- Appearance: chord colors, comet schemes, background theme, sliders ----
function bindAppearance() {
    // Step 1: chord scheme (function3 / quality4)
    document.querySelectorAll('#chordModeButtons .theme-btn').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#chordModeButtons .theme-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chordColorMode = btn.dataset.mode;
            applyChordColors();
        };
    });

    // Step 2: palette swatch balls (mini color wheels)
    document.querySelectorAll('#paletteSwatches .swatch').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#paletteSwatches .swatch').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chordPaletteKey = btn.dataset.palette;
            applyChordColors();
        };
    });

    // Collapsible section toggles
    document.querySelectorAll('.section-title.toggle').forEach((title) => {
        title.onclick = () => {
            document.getElementById(title.dataset.target).classList.toggle('folded');
        };
    });

    document.querySelectorAll('#themeButtons .theme-btn').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#themeButtons .theme-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyBgTheme(btn.dataset.theme);
        };
    });

    const densitySlider = document.getElementById('densitySlider');
    const densityValue = document.getElementById('densityValue');
    densitySlider.oninput = (e) => {
        const pct = parseInt(e.target.value);
        densityValue.textContent = pct + '%';
        applyStarDensity(pct / 100);
    };

    // Line width: slider middle (50) = current thickness
    const lineSlider = document.getElementById('lineWidthSlider');
    const lineValue = document.getElementById('lineWidthValue');
    lineSlider.oninput = (e) => {
        const v = parseInt(e.target.value);            // 10..100
        const factor = v / 50;                          // 0.2x .. 2x, 1x at middle
        lineValue.textContent = factor.toFixed(1) + 'x';
        applyLineWidth(factor);
    };

    // Fade-out: trail older than N bars fades; slider max = off
    const fadeSlider = document.getElementById('fadeSlider');
    const fadeValue = document.getElementById('fadeValue');
    fadeSlider.oninput = (e) => {
        fadeBars = parseInt(e.target.value);
        fadeValue.textContent = fadeBars >= FADE_OFF ? '∞' : fadeBars;
        applyFadeSetting();
    };

    document.querySelectorAll('#anchorButtons .theme-btn').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#anchorButtons .theme-btn')
                .forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setAnchorsVisible(btn.dataset.anchor === 'on');
        };
    });

    // Timbre: the voice is built on first pick, so disable the row until the
    // swap lands - otherwise a fast double-click can leave the wrong button lit.
    document.querySelectorAll('#timbreButtons .theme-btn').forEach((btn) => {
        btn.onclick = async () => {
            const row = document.querySelectorAll('#timbreButtons .theme-btn');
            row.forEach(b => { b.classList.remove('active'); b.disabled = true; });
            btn.classList.add('active');
            try { await setTimbre(btn.dataset.timbre); }
            finally { row.forEach(b => { b.disabled = false; }); }
        };
    });

    document.querySelectorAll('#aePanelButtons .theme-btn').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('#aePanelButtons .theme-btn')
                .forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setAeVizVisible(btn.dataset.ae === 'on');
        };
    });
}

// (The old hidden circle-of-fifths inset was replaced by the tension radar
// in radar.js, which reuses the #circleCanvas element.)
