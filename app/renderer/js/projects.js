// ========== PROJECTS: MIDI import + a two-slot project cache ==========
// A "project" is one MIDI file plus what was decided about it here: the key
// (and modulation marks) the user settled on and where they left off. The
// last two are kept, so two pieces can be flipped between without
// re-importing, and they survive a restart.
//
// Stored in localStorage (MIDI files are a few KB; base64 inflates by a third).
// That storage can be missing or full - in a private window, with site data
// cleared - so every access is guarded and the app works without it, just
// without the memory.

const PROJECT_SLOTS = 2;
const PROJECT_STORE_KEY = 'trace.projects.v1';
const PROJECT_MAX_BYTES = 1.5 * 1024 * 1024;   // larger files load but are not cached

let projects = [];          // [{id, name, data (base64), key, mods, lastIndex, openedAt}]
let activeProjectId = null;
let restoringProject = false;

function loadProjectStore() {
    try {
        const raw = localStorage.getItem(PROJECT_STORE_KEY);
        projects = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(projects)) projects = [];
    } catch (e) { projects = []; }
}
function saveProjectStore() {
    try { localStorage.setItem(PROJECT_STORE_KEY, JSON.stringify(projects)); }
    catch (e) { console.warn('projects: could not save the cache', e); }
}

const bufToB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};
const b64ToBuf = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

// Remember the key decisions and position of the project on screen.
function persistActiveProject() {
    if (restoringProject || !activeProjectId) return;
    const p = projects.find(x => x.id === activeProjectId);
    if (!p) return;
    p.key = { tonic: keySignature.tonic, mode: keySignature.mode };
    p.mods = keyModulations.map(m => ({ bar: m.bar, tonic: m.tonic, mode: m.mode }));
    p.lastIndex = currentIndex;
    // user-corrected chords (js/editor.js) replace recognition for this piece
    p.chords = chordsEdited ? analysisSegments.map(s => ({ ...s })) : null;
    saveProjectStore();
    syncEditedBadge();
}

// New file -> new project in the front slot; the least recently opened one
// that is not on screen makes room.
async function openMidiFile(file) {
    if (!file || isExporting) return;
    const buf = await file.arrayBuffer();
    // The same file again (byte for byte) reopens its project - key decisions
    // and position included - instead of filling the second slot with a twin.
    const b64 = buf.byteLength <= PROJECT_MAX_BYTES ? bufToB64(buf) : null;
    const twin = b64 && projects.find(p => p.data === b64);
    if (twin) {
        if (twin.id !== activeProjectId) await openProject(twin.id);
        return;
    }
    const project = { id: `p${Date.now()}`, name: file.name, data: null, key: null, mods: [], lastIndex: 0, chords: null, openedAt: Date.now() };
    project.data = b64;
    persistActiveProject();
    projects = [project, ...projects].slice(0, PROJECT_SLOTS);
    saveProjectStore();
    await showProject(project, buf);
}

async function openProject(id) {
    if (isExporting || id === activeProjectId) return;
    const p = projects.find(x => x.id === id);
    if (!p || !p.data) return;
    persistActiveProject();
    p.openedAt = Date.now();
    saveProjectStore();
    await showProject(p, b64ToBuf(p.data));
}

function closeProject(id) {
    if (id === activeProjectId) return;     // the piece on screen stays; only the other slot can go
    projects = projects.filter(x => x.id !== id);
    saveProjectStore();
    renderProjectUI();
}

async function showProject(p, buf) {
    if (isPlaying) pausePlayback();
    currentIndex = 0;
    pausedVisualElapsedMs = null;
    audioRestart();
    await embeddingTableReady;          // chords are looked up in it right away
    if (!parseMidiFile(buf)) { console.warn(`projects: could not parse ${p.name}`); return; }
    activeProjectId = p.id;
    restoringProject = true;
    try {
        analyzeAndBuildProgression();   // recognition + key guess
        chordsEdited = false;
        if (Array.isArray(p.chords) && p.chords.length) {   // ...or the chords corrected by hand
            analysisSegments = p.chords.map(s => ({ ...s }));
            chordsEdited = true;
        }
        if (p.key || chordsEdited) {    // ...then the key this project was left in
            if (p.key) keySignature = { ...p.key };
            keyModulations = (p.mods || []).map(m => ({ ...m }));
            estimatedTonic = keySignature.tonic;
            syncKeyUI();
            rebuildProgressionFromAnalysis();
        }
        const idx = Math.min(p.lastIndex || 0, Math.max(0, progression.length - 1));
        if (idx > 0) jumpToChord(idx);
    } finally {
        restoringProject = false;
    }
    console.log(`MIDI loaded: ${p.name}`);
    document.getElementById('keySection').style.display = '';
    persistActiveProject();
    renderProjectUI();
}

// ---- UI: the start prompt, the sidebar project chips, drag and drop ----
function timeAgo(t) {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
}

function renderProjectUI() {
    const hasActive = !!activeProjectId;
    const prompt = document.getElementById('startPrompt');
    if (prompt) prompt.hidden = hasActive;
    document.body.classList.toggle('has-project', hasActive);

    const recent = document.getElementById('startRecent');
    if (recent) {
        recent.innerHTML = '';
        projects.filter(p => p.data).forEach((p) => {
            const b = document.createElement('button');
            b.className = 'start-recent-btn';
            b.title = 'Open this project';
            const nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = p.name;
            const when = document.createElement('span');
            when.className = 'when';
            when.textContent = timeAgo(p.openedAt);
            b.append(nm, when);
            b.onclick = () => openProject(p.id);
            recent.appendChild(b);
        });
        recent.parentElement.hidden = recent.children.length === 0;
    }

    const chips = document.getElementById('projectChips');
    if (chips) {
        chips.innerHTML = '';
        projects.forEach((p) => {
            const chip = document.createElement('div');
            chip.className = 'project-chip' + (p.id === activeProjectId ? ' active' : '');
            chip.title = p.data ? p.name : `${p.name} (too large to cache)`;
            const name = document.createElement('span');
            name.className = 'project-name';
            name.textContent = p.name;
            chip.appendChild(name);
            if (p.id !== activeProjectId) {
                chip.onclick = () => openProject(p.id);
                const x = document.createElement('button');
                x.className = 'project-close';
                x.title = 'Remove from the cache';
                x.textContent = '×';
                x.onclick = (e) => { e.stopPropagation(); closeProject(p.id); };
                chip.appendChild(x);
            }
            chips.appendChild(chip);
        });
        chips.hidden = projects.length === 0;
    }
    const uploadLabel = document.getElementById('uploadLabel');
    if (uploadLabel) uploadLabel.textContent = hasActive ? 'Open another MIDI…' : 'Open MIDI…';
}

function bindProjects() {
    loadProjectStore();
    const input = document.getElementById('midiInput');
    input.onchange = async (e) => {
        const file = e.target.files[0];
        input.value = '';                   // so picking the same file again still fires
        await openMidiFile(file);
    };
    document.querySelectorAll('[data-pick-midi]').forEach(b => { b.onclick = () => input.click(); });

    // Drop a MIDI anywhere on the scene. Electron would otherwise navigate to
    // the dropped file, so the window swallows drops that miss the scene.
    const host = document.getElementById('canvas');
    ['dragover', 'drop'].forEach(t => window.addEventListener(t, e => e.preventDefault()));
    host.addEventListener('dragover', (e) => { e.preventDefault(); host.classList.add('dragging'); });
    host.addEventListener('dragleave', (e) => {
        if (!host.contains(e.relatedTarget)) host.classList.remove('dragging');
    });
    host.addEventListener('drop', async (e) => {
        e.preventDefault();
        host.classList.remove('dragging');
        const file = [...(e.dataTransfer.files || [])].find(f => /\.midi?$/i.test(f.name));
        if (file) await openMidiFile(file);
    });
    // Ctrl/Cmd+O opens the file picker, as the start screen advertises
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            input.click();
        }
    });
    window.addEventListener('beforeunload', persistActiveProject);
    renderProjectUI();
}
