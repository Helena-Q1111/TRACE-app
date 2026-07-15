// ========== UI (sidebar, info panel, controls, circle of fifths) ==========

function updateUI() {
    // Update chord list
    const listEl = document.getElementById('chordList');
    listEl.innerHTML = '';
    progression.forEach((chord, idx) => {
        const div = document.createElement('div');
        div.className = 'chord-item' + (idx === currentIndex ? ' active' : '');
        const bv = (chord.beatInBar || 0) + 1;
        const beatTag = (chord.beatInBar && chord.beatInBar > 0)
            ? `·${bv % 1 ? bv.toFixed(1) : bv.toFixed(0)}` : '';
        div.innerHTML = `
            <span class="dot" style="background:${getChordColorHexStr(chord)}"></span>
            <span class="chord-name">Bar ${chord.bar || idx + 1}${beatTag}: ${chord.absLabel || chord.label || '?'}</span>
        `;
        div.onclick = () => {
            if (isExporting) return;   // no seeking while recording
            currentIndex = idx;
            snapLightToCurrent();
            audioSeekToChord(idx);   // keep audio in lockstep with the visuals
            lastBeatTime = Date.now();       // visual segment restarts at chord start,
            pausedVisualElapsedMs = null;    // matching the audio seek position
            updateUI();
            renderProgression();
        };
        listEl.appendChild(div);
    });

    // Keep the current chord centered in the list
    const activeItem = listEl.querySelector('.chord-item.active');
    if (activeItem) {
        const top = activeItem.offsetTop - listEl.clientHeight / 2 + activeItem.clientHeight / 2;
        listEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    // Live metrics: d = distance from previous chord, t = tension (C-space norm),
    // and the Roman-numeral degree relative to the current key
    if (progression.length > 0) {
        const cur = progression[currentIndex];
        const prev = currentIndex > 0 ? progression[currentIndex - 1] : null;
        document.getElementById('liveD').textContent =
            prev ? euclideanDistance(prev.coords, cur.coords).toFixed(2) : '—';
        document.getElementById('liveT').textContent = Math.hypot(...cur.coords).toFixed(2);
        document.getElementById('liveDegree').textContent = romanDegree(cur, keyAtBar(cur.bar));
    }
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

    // Single MIDI entry: parse -> recognize chords -> guess key -> build scene
    document.getElementById('midiInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const arrayBuffer = await file.arrayBuffer();
        if (parseMidiFile(arrayBuffer)) {
            console.log(`MIDI loaded: ${file.name}`);
            analyzeAndBuildProgression();
            document.getElementById('keySection').style.display = '';
        }
    };

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
}

// (The old hidden circle-of-fifths inset was replaced by the tension radar
// in radar.js, which reuses the #circleCanvas element.)
