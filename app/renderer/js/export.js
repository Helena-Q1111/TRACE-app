// ========== VIDEO EXPORT (MediaRecorder over the WebGL canvas) ==========
// The user frames a STARTING viewpoint by dragging/zooming, then clicks
// export: playback restarts from bar 1 and one full pass of the progression
// is recorded (canvas video + Tone.js master audio). The camera is NOT
// frozen - it keeps the normal follow/auto-orbit behaviour, just beginning
// from wherever the user left the orbit. Output prefers MP4 (H.264/AAC) and
// falls back to WebM when the Chromium build can't encode MP4. The file
// downloads automatically when the loop wraps; a second click stops early.

let isExporting = false;
let _exportRecorder = null;
let _exportChunks = [];
let _exportAudioDest = null;
let _exportStopping = false;
let _exportMime = '';
let _exportExt = 'webm';
let _exportRequestFrame = null;   // manual per-frame capture (called after each render)
let _exportCanvas = null;         // offscreen 2D mirror canvas (fixed even dimensions)
let _exportCtx = null;

// Prefer MP4, but ONLY with explicit H.264 video + AAC audio: a bare
// "video/mp4" request makes Chromium mux VP9/Opus into the MP4 container,
// which most players cannot decode (file saves but won't play). If no
// H.264+AAC combo is supported by this Chromium build, fall back to WebM.
// Profile order: High 4.0 -> High 3.1 -> Main 3.1 -> Baseline 3.0.
function pickRecorderMime() {
    const candidates = [
        { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1.64001F,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1.4D401F,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/webm;codecs=vp9,opus',             ext: 'webm' },
        { mime: 'video/webm;codecs=vp8,opus',             ext: 'webm' },
        { mime: 'video/webm',                             ext: 'webm' }
    ];
    // Encoding diagnostics: log what this build claims to support
    if (window.MediaRecorder) {
        console.log('MediaRecorder codec support:');
        candidates.forEach(c => console.log(`  ${MediaRecorder.isTypeSupported(c.mime) ? 'YES' : 'no '}  ${c.mime}`));
    }
    for (const c of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(c.mime)) return c;
    }
    return { mime: '', ext: 'webm' };
}

async function startVideoExport() {
    if (isExporting) { finishVideoExport(); return; }   // second click = stop early
    if (progression.length === 0) {
        alert('Import a MIDI file before exporting a video.');
        return;
    }
    isExporting = true;
    _exportStopping = false;
    setExportBtnState(true);

    // Record via an offscreen 2D mirror canvas, NOT the WebGL canvas itself.
    // Two real failure modes of direct WebGL capture (symptom: audio-only file):
    // - H.264 encoders require EVEN width/height; the DPR-scaled canvas is
    //   often odd -> the encoder silently emits zero video frames
    // - resizing the source canvas mid-recording kills the video track
    // Each frame is drawImage'd into the mirror right after composer.render().
    const src = renderer.domElement;
    const w = Math.min(1920, src.width) & ~1;
    const h = Math.round(w * src.height / src.width) & ~1;
    _exportCanvas = document.createElement('canvas');
    _exportCanvas.width = w;
    _exportCanvas.height = h;
    _exportCtx = _exportCanvas.getContext('2d');
    _exportCtx.drawImage(src, 0, 0, w, h);   // prime the first frame
    console.log(`Export resolution: ${w}x${h} (source canvas ${src.width}x${src.height})`);

    let canvasStream = _exportCanvas.captureStream(0);
    const vTrack = canvasStream.getVideoTracks()[0];
    if (typeof canvasStream.requestFrame === 'function') {
        _exportRequestFrame = () => canvasStream.requestFrame();
    } else if (vTrack && typeof vTrack.requestFrame === 'function') {
        _exportRequestFrame = () => vTrack.requestFrame();
    } else {
        // No manual frame API in this browser: fall back to auto 60fps capture
        // (the mirror updates every rAF via exportCaptureFrame, so frames flow)
        _exportRequestFrame = null;
        canvasStream = _exportCanvas.captureStream(60);
    }
    console.log(`Frame capture mode: ${_exportRequestFrame ? 'manual requestFrame' : 'auto 60fps'}`);

    // Tone.js master routed into an audio track when possible
    let stream = canvasStream;
    try {
        _exportAudioDest = Tone.getContext().rawContext.createMediaStreamDestination();
        Tone.getDestination().connect(_exportAudioDest);
        stream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ..._exportAudioDest.stream.getAudioTracks()
        ]);
    } catch (e) {
        console.warn('Audio capture unavailable, exporting video only:', e);
    }

    const chosen = pickRecorderMime();
    _exportChunks = [];
    _exportRecorder = new MediaRecorder(stream, {
        mimeType: chosen.mime || undefined,
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000
    });
    // Trust what the recorder actually negotiated, not what we asked for
    _exportMime = _exportRecorder.mimeType || chosen.mime;
    _exportExt = _exportMime.includes('mp4') ? 'mp4' : 'webm';
    console.log(`Video export container: ${_exportMime || 'browser default'} (.${_exportExt})`);
    if (_exportExt !== 'mp4') {
        console.warn('This Chromium build cannot encode H.264+AAC MP4; falling back to WebM (remux with ffmpeg if needed)');
    }
    _exportRecorder.ondataavailable = (e) => { if (e.data.size > 0) _exportChunks.push(e.data); };
    _exportRecorder.onstop = saveExportedVideo;

    // Restart from bar 1. The camera keeps its current orbit (the user's chosen
    // starting angle) and resumes the normal follow logic - not frozen.
    isPlaying = false;
    currentIndex = 0;
    pausedVisualElapsedMs = null;
    audioRestart();
    snapLightToCurrent();
    updateUI();
    renderProgression();

    await Tone.start();
    _exportRecorder.start();
    isPlaying = true;
    lastBeatTime = Date.now();
    audioPlay();
}

// Called from the animation loop when the progression wraps (full pass done),
// or by a second button click. A short tail captures the final release.
function finishVideoExport() {
    if (!isExporting || _exportStopping) return;
    _exportStopping = true;
    isPlaying = false;
    audioPause();
    setTimeout(() => {
        if (_exportRecorder && _exportRecorder.state !== 'inactive') _exportRecorder.stop();
    }, 700);
}

// ---- Byte-level codec self-check on the exported blob ----
// Scans head+tail for container/codec fourccs and prints a verdict, so a
// "saves but won't play" file can be diagnosed straight from the console.
function _findBytes(haystack, ascii) {
    const needle = Array.from(ascii, ch => ch.charCodeAt(0));
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return true;
    }
    return false;
}

async function logExportCodecCheck(blob) {
    try {
        const head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
        const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 512 * 1024)).arrayBuffer());
        const has = (tag) => _findBytes(head, tag) || _findBytes(tail, tag);

        const isMp4 = _findBytes(head.slice(0, 16), 'ftyp');
        const isWebm = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
        const lines = [`Export check: container=${isMp4 ? 'MP4' : isWebm ? 'WebM' : 'unknown!'} size=${(blob.size / 1e6).toFixed(1)}MB`];

        if (isMp4) {
            const h264 = has('avc1') || has('avc3');
            const vp9 = has('vp09') || has('vpcC');
            const aac = has('mp4a');
            const opus = has('Opus') || has('dOps');
            lines.push(`Video: ${h264 ? 'H.264 ✓' : vp9 ? 'VP9 ✗ (most players reject VP9 inside MP4)' : 'not found!'}`);
            lines.push(`Audio: ${aac ? 'AAC ✓' : opus ? 'Opus ✗ (most players reject Opus inside MP4)' : 'not found (may be silent)'}`);
            if (!has('moov')) lines.push('Warning: no moov index - the file may be truncated or not finalised');
        } else if (isWebm) {
            lines.push(`Video: ${has('V_VP9') ? 'VP9' : has('V_VP8') ? 'VP8' : '?'}  Audio: ${has('A_OPUS') ? 'Opus' : '?'}  (play WebM in VLC or Chrome)`);
        }
        console.log(lines.join('\n'));
    } catch (e) {
        console.warn('Export check failed:', e);
    }
}

function saveExportedVideo() {
    const blob = new Blob(_exportChunks, { type: _exportMime || 'video/webm' });
    logExportCodecCheck(blob);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trace_export_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${_exportExt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    if (_exportAudioDest) {
        try { Tone.getDestination().disconnect(_exportAudioDest); } catch (e) { /* already gone */ }
        _exportAudioDest = null;
    }
    _exportRecorder = null;
    _exportChunks = [];
    _exportRequestFrame = null;
    _exportCanvas = null;
    _exportCtx = null;
    isExporting = false;
    _exportStopping = false;
    setExportBtnState(false);
    console.log('Video export saved.');
}

// Called from the animation loop right after composer.render(): mirror the
// freshly rendered WebGL frame into the recording canvas and push it.
function exportCaptureFrame() {
    if (!isExporting || !_exportCtx) return;
    _exportCtx.drawImage(renderer.domElement, 0, 0, _exportCanvas.width, _exportCanvas.height);
    if (_exportRequestFrame) _exportRequestFrame();
}

function setExportBtnState(recording) {
    const btn = document.getElementById('exportBtn');
    if (!btn) return;
    btn.textContent = recording ? '● Recording' : 'Export video';
    btn.classList.toggle('recording', recording);
}
