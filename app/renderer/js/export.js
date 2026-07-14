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
        alert('请先导入 MIDI，再导出视频');
        return;
    }
    isExporting = true;
    _exportStopping = false;
    setExportBtnState(true);

    // Canvas video stream; Tone.js master routed into an audio track when possible
    const canvasStream = renderer.domElement.captureStream(60);
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
        console.warn('此 Chromium 版本不支持 H.264+AAC MP4 编码，回退为 WebM（可用 ffmpeg 转封装）');
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

function saveExportedVideo() {
    const blob = new Blob(_exportChunks, { type: _exportMime || 'video/webm' });
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
    isExporting = false;
    _exportStopping = false;
    setExportBtnState(false);
    console.log('Video export saved.');
}

function setExportBtnState(recording) {
    const btn = document.getElementById('exportBtn');
    if (!btn) return;
    btn.textContent = recording ? '● 录制中… 点击提前结束' : '导出视频（当前视角为起点，跟随录制整曲）';
    btn.classList.toggle('recording', recording);
}
