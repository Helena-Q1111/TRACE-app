// ========== AUDIO (polyphonic piano sampler) + MIDI PARSING ==========
// The old Tone.Synth was MONOPHONIC: chord notes stole its single voice
// (attack-only clicks), and releases were only fired inside a 50ms window,
// so missed frames left voices droning forever. Now: Tone.Sampler piano
// (local Salamander samples) + span-based triggerAttackRelease - every note
// carries its own duration, nothing can get stuck.

let midiSpansSec = [];      // [{startSec, endSec, pitch, velocity}] sorted by start
let midiPlayPtr = 0;        // next span to trigger
let pausedElapsedSec = null;
let samplerReady = false;

const PIANO_SAMPLES = ['C1', 'Fs1', 'C2', 'Fs2', 'C3', 'Fs3', 'C4', 'Fs4', 'C5', 'Fs5', 'C6', 'Fs6', 'C7'];
const sampleNoteName = (n) => n.replace('s', '#');   // Fs1 -> F#1

async function initAudio() {
    try {
        if (window.traceAPI && window.traceAPI.readBinary) {
            // Electron: file:// fetch is blocked, load samples via IPC and decode
            const urls = {};
            for (const name of PIANO_SAMPLES) {
                const raw = await window.traceAPI.readBinary(`vendor/piano/${name}.mp3`);
                const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
                const decoded = await Tone.getContext().rawContext.decodeAudioData(ab);
                urls[sampleNoteName(name)] = new Tone.ToneAudioBuffer(decoded);
            }
            synth = new Tone.Sampler({ urls, release: 1 }).toDestination();
        } else {
            // Browser dev server: plain URLs
            synth = new Tone.Sampler({
                urls: Object.fromEntries(PIANO_SAMPLES.map(n => [sampleNoteName(n), `${n}.mp3`])),
                baseUrl: 'vendor/piano/',
                release: 1
            }).toDestination();
            await Tone.loaded();
        }
        samplerReady = true;
        console.log('Piano sampler ready (13 Salamander samples)');
    } catch (e) {
        console.warn('Piano samples unavailable, falling back to polyphonic synth:', e);
        synth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'triangle' },
            envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.8 }
        }).toDestination();
        samplerReady = true;
    }
}

// ---- Transport helpers (wired to the Play / Pause / Restart buttons) ----
function audioPlay() {
    const now = Date.now();
    if (pausedElapsedSec !== null) {
        midiStartTime = now - pausedElapsedSec * 1000;   // resume where we paused
        pausedElapsedSec = null;
    } else {
        midiStartTime = now;
        midiPlayPtr = 0;
    }
}

function audioPause() {
    if (midiStartTime) pausedElapsedSec = (Date.now() - midiStartTime) / 1000;
    if (synth && synth.releaseAll) synth.releaseAll();
}

function audioRestart() {
    midiPlayPtr = 0;
    pausedElapsedSec = null;
    midiStartTime = null;
    if (synth && synth.releaseAll) synth.releaseAll();
}

// Seek audio to an absolute beat position and keep it in lockstep with the
// visuals (used on chord-list jumps and on loop wrap).
function audioSeekToBeat(beat) {
    const targetSec = beat * (60 / bpm);
    if (synth && synth.releaseAll) synth.releaseAll();
    midiPlayPtr = 0;
    while (midiPlayPtr < midiSpansSec.length && midiSpansSec[midiPlayPtr].startSec < targetSec - 0.01) {
        midiPlayPtr++;
    }
    midiStartTime = Date.now() - targetSec * 1000;
    // If paused, remember the position so Play resumes from here
    pausedElapsedSec = isPlaying ? null : targetSec;
}

function audioSeekToChord(idx) {
    const chord = progression[idx];
    if (!chord) return;
    const startBeat = (chord.bar - 1) * beatsPerBar + (chord.beatInBar || 0);
    audioSeekToBeat(startBeat);
}

// Parse MIDI file: notes merged from ALL tracks, tempo map from setTempo
// events, time signature from meta 0x58. Times converted tick -> seconds.
function parseMidiFile(arrayBuffer) {
    try {
        const midiArray = new Uint8Array(arrayBuffer);
        const midiData = MidiParser.parse(midiArray);
        midiNotes = [];

        const tracks = midiData.track ? midiData.track.map(t => t.event) : (midiData.tracks || []);
        if (tracks.length === 0) return false;

        const ticksPerBeat = midiData.timeDivision || (midiData.header && midiData.header.ticksPerBeat) || 480;

        const noteEvents = [];
        const tempoEvents = [];
        let timeSig = null;

        tracks.forEach((track) => {
            let tick = 0;
            for (let evt of track) {
                tick += evt.deltaTime || 0;
                if (evt.type === 255 && evt.metaType === 81) {
                    const usPerBeat = Array.isArray(evt.data)
                        ? ((evt.data[0] << 16) | (evt.data[1] << 8) | evt.data[2])
                        : Number(evt.data);
                    if (usPerBeat > 0) tempoEvents.push({ tick, usPerBeat });
                } else if (evt.type === 255 && evt.metaType === 88) {
                    const d = evt.data;
                    if (Array.isArray(d) && d.length >= 2) {
                        timeSig = { numerator: d[0], denominator: Math.pow(2, d[1]) };
                    }
                } else if (evt.type === 9 && evt.data[1] > 0) {
                    noteEvents.push({ tick, pitch: evt.data[0], velocity: evt.data[1], type: 'on' });
                } else if (evt.type === 8 || (evt.type === 9 && evt.data[1] === 0)) {
                    noteEvents.push({ tick, pitch: evt.data[0], type: 'off' });
                }
            }
        });

        noteEvents.sort((a, b) => a.tick - b.tick);
        tempoEvents.sort((a, b) => a.tick - b.tick);
        if (tempoEvents.length === 0) {
            tempoEvents.push({ tick: 0, usPerBeat: 60e6 / DEFAULT_TIMING.bpm });
        } else if (tempoEvents[0].tick > 0) {
            tempoEvents.unshift({ tick: 0, usPerBeat: tempoEvents[0].usPerBeat });
        }

        let accSec = 0;
        tempoEvents.forEach((te, i) => {
            te.startSec = accSec;
            if (i < tempoEvents.length - 1) {
                accSec += ((tempoEvents[i + 1].tick - te.tick) / ticksPerBeat) * (te.usPerBeat / 1e6);
            }
        });
        const tickToSec = (tick) => {
            let seg = tempoEvents[0];
            for (let te of tempoEvents) {
                if (te.tick <= tick) seg = te; else break;
            }
            return seg.startSec + ((tick - seg.tick) / ticksPerBeat) * (seg.usPerBeat / 1e6);
        };

        midiNotes = noteEvents.map(e => ({
            time: tickToSec(e.tick), pitch: e.pitch, velocity: e.velocity, type: e.type
        }));

        // Note spans: beat-domain (chord analyzer) + second-domain (audio playback)
        midiNoteSpans = [];
        midiSpansSec = [];
        const active = {};
        noteEvents.forEach((e) => {
            const beat = e.tick / ticksPerBeat;
            if (e.type === 'on') {
                (active[e.pitch] = active[e.pitch] || []).push({ beat, tick: e.tick, velocity: e.velocity || 90 });
            } else if (active[e.pitch] && active[e.pitch].length) {
                const st = active[e.pitch].shift();
                if (beat > st.beat) {
                    midiNoteSpans.push({ startBeat: st.beat, endBeat: beat, pitch: e.pitch });
                    midiSpansSec.push({
                        startSec: tickToSec(st.tick), endSec: tickToSec(e.tick),
                        pitch: e.pitch, velocity: st.velocity
                    });
                }
            }
        });
        const lastTick = noteEvents.length ? noteEvents[noteEvents.length - 1].tick : 0;
        const lastBeat = lastTick / ticksPerBeat;
        Object.entries(active).forEach(([pitch, list]) => list.forEach((st) => {
            if (lastBeat > st.beat) {
                midiNoteSpans.push({ startBeat: st.beat, endBeat: lastBeat, pitch: +pitch });
                midiSpansSec.push({
                    startSec: tickToSec(st.tick), endSec: tickToSec(lastTick),
                    pitch: +pitch, velocity: st.velocity
                });
            }
        }));
        midiSpansSec.sort((a, b) => a.startSec - b.startSec);
        midiPlayPtr = 0;
        pausedElapsedSec = null;

        const midiBpm = Math.round(60e6 / tempoEvents[0].usPerBeat);
        const midiBeatsPerBar = timeSig ? timeSig.numerator * (4 / timeSig.denominator) : null;
        setTiming(midiBpm, midiBeatsPerBar, 'MIDI');

        console.log(`Parsed ${midiSpansSec.length} notes from ${tracks.length} track(s), `
            + `${tempoEvents.length} tempo event(s)${timeSig ? `, ${timeSig.numerator}/${timeSig.denominator}` : ''}`);
        return true;
    } catch (e) {
        console.error('Failed to parse MIDI:', e);
        return false;
    }
}

// Per-frame: trigger every note whose start time has passed since last frame.
// Each trigger schedules its own release (duration) - robust to frame drops.
function playMidiNotes(currentSec) {
    if (!synth || !samplerReady || midiSpansSec.length === 0) return;
    while (midiPlayPtr < midiSpansSec.length && midiSpansSec[midiPlayPtr].startSec <= currentSec) {
        const n = midiSpansSec[midiPlayPtr++];
        if (currentSec - n.startSec > 0.25) continue;   // long past (lag/seek): skip
        const dur = Math.max(0.05, n.endSec - n.startSec);
        synth.triggerAttackRelease(
            Tone.Frequency(n.pitch, 'midi').toNote(), dur, undefined, n.velocity / 127);
    }
}
