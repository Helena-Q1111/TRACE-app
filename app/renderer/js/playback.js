// ========== AUDIO (selectable timbre) + MIDI PARSING ==========
// The old Tone.Synth was MONOPHONIC: chord notes stole its single voice
// (attack-only clicks), and releases were only fired inside a 50ms window,
// so missed frames left voices droning forever. Now every timbre is
// polyphonic and each note carries its own duration, so nothing can stick.
//
// Piano is a Tone.Sampler over the local Salamander samples; the rest are
// plain Tone.js synths. A voice is built on first use and then kept alive,
// so switching back is instant - the piano in particular costs 13 IPC
// reads + decodes.

let midiSpansSec = [];      // [{startSec, endSec, pitch, velocity}] sorted by start
let midiPlayPtr = 0;        // next span to trigger
let pausedElapsedSec = null;
let samplerReady = false;

const PIANO_SAMPLES = ['C1', 'Fs1', 'C2', 'Fs2', 'C3', 'Fs3', 'C4', 'Fs4', 'C5', 'Fs5', 'C6', 'Fs6', 'C7'];
const sampleNoteName = (n) => n.replace('s', '#');   // Fs1 -> F#1

async function buildPiano() {
    if (window.traceAPI && window.traceAPI.readBinary) {
        // Electron: file:// fetch is blocked, load samples via IPC and decode
        const urls = {};
        for (const name of PIANO_SAMPLES) {
            const raw = await window.traceAPI.readBinary(`vendor/piano/${name}.mp3`);
            const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            const decoded = await Tone.getContext().rawContext.decodeAudioData(ab);
            urls[sampleNoteName(name)] = new Tone.ToneAudioBuffer(decoded);
        }
        return new Tone.Sampler({ urls, release: 1 }).toDestination();
    }
    // Browser dev server: plain URLs
    const sampler = new Tone.Sampler({
        urls: Object.fromEntries(PIANO_SAMPLES.map(n => [sampleNoteName(n), `${n}.mp3`])),
        baseUrl: 'vendor/piano/',
        release: 1
    }).toDestination();
    await Tone.loaded();
    return sampler;
}

// `volume` (dB) is hand-levelled against the piano: raw oscillators are far
// hotter than the samples, and a voiced chord stacks four of them at once.
const TIMBRE_BUILDERS = {
    piano: buildPiano,

    // Pure tone - no harmonics at all, the sound of the chroma vector itself.
    sine: () => new Tone.PolySynth(Tone.Synth, {
        volume: -17,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.012, decay: 0.25, sustain: 0.45, release: 1.1 }
    }).toDestination(),

    // Rhodes-ish: FM with a fast-decaying modulator gives the bell attack.
    epiano: () => new Tone.PolySynth(Tone.FMSynth, {
        volume: -6,
        harmonicity: 3,
        modulationIndex: 9,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 1.4, sustain: 0.08, release: 1.0 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.4 }
    }).toDestination(),

    // Slow detuned saw pad, lowpassed - chords bloom instead of striking,
    // which suits watching a long tension arc more than a percussive voice.
    pad: () => {
        const tone = new Tone.Filter({ type: 'lowpass', frequency: 2000, rolloff: -12 });
        const poly = new Tone.PolySynth(Tone.Synth, {
            volume: -13,
            oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
            envelope: { attack: 0.45, decay: 0.7, sustain: 0.7, release: 1.9 }
        });
        poly.chain(tone, Tone.getDestination());
        poly._traceChain = tone;      // keep the filter referenced with its synth
        return poly;
    }
};

const voiceCache = {};              // timbre id -> built Tone instrument
let currentTimbre = 'piano';

// Built only if the piano samples fail to load - see initAudio().
function buildFallbackVoice() {
    return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.8 }
    }).toDestination();
}

async function getVoice(id) {
    if (!voiceCache[id]) voiceCache[id] = await TIMBRE_BUILDERS[id]();
    return voiceCache[id];
}

async function initAudio() {
    try {
        voiceCache.piano = await buildPiano();
        console.log('Piano sampler ready (13 Salamander samples)');
    } catch (e) {
        console.warn('Piano samples unavailable, falling back to polyphonic synth:', e);
        voiceCache.piano = buildFallbackVoice();
    }
    synth = voiceCache.piano;
    currentTimbre = 'piano';
    samplerReady = true;
}

// Switching mid-playback: release the outgoing voice so its tails do not
// hang around under the new one. Notes already past are not re-triggered -
// the change is audible from the next note on.
async function setTimbre(id) {
    if (!TIMBRE_BUILDERS[id] || id === currentTimbre) return;
    const next = await getVoice(id);
    if (synth && synth.releaseAll) synth.releaseAll();
    synth = next;
    currentTimbre = id;
    samplerReady = true;
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
