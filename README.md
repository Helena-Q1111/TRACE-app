# TRACE Visualizer

Interactive 3D visualization of chord progressions in TPS (Tonal Pitch Space) latent geometry.

## Overview

TRACE (Tension-Regularized Autoencoded Chord Embeddings) maps musical chords to a 3D latent space learned by a VAE trained with TPS regularization. This visualizer animates chord progressions through that space, showing how chords relate to each other geometrically.

The pipeline:
```
MIDI file (offline) → chord recognition → embedding → 3D coordinates (lookup)
                                           ↓
                                    chord_table.json
                                           ↓
                                    Browser (Three.js)
                                     visualizes path
```

## Quick Start

### 1. Generate Chord Table (Offline, Python)

Run once with your trained VAE:

```bash
python generate_table.py
```

This:
- Loads your trained VAE model (path configured at top of script)
- Encodes all 108 diatonic chord combinations (12 roots × 9 qualities)
- Outputs `chord_table.json` (lookup table)

**Configuration:** Edit the top of `generate_table.py` to set:
- `VAE_MODEL_PATH`: path to your trained model checkpoint
- `LATENT_DIM`: VAE latent dimension (default 3)
- `MEAN_DURATION`: average chord duration from training (in quarter notes)

### 2. Convert MIDI to Progression (Python)

For each MIDI file you want to visualize:

```bash
python midi_to_chords.py my_song.mid
```

This:
- Parses MIDI file, quantizes to bars (4/4 assumed)
- **Advanced chord recognition:**
  1. **Strong-beat filtering**: extracts notes that start on beat 1 or 3 (±0.25 quarter notes tolerance)
  2. **Duration-weighted voting**: weights notes by duration, filters < 20% bar length
  3. **Passing tone removal**: heuristic to remove stepwise neighbors (major/minor 2nd intervals)
  4. **Chord identification**: uses music21 to identify root and quality
  5. **Empty bars**: skipped if no chord detected (gap in trajectory)
- Looks up each chord in `chord_table.json` (or uses random coords if not found)
- Outputs `my_song_progression.json` (ordered list of chords)

**Limitations:**
- Chord recognition relies on music21's analysis (imperfect for complex voicings)
- Passing tone removal is heuristic-based, not music-theory-driven
- Expects 4/4 time signature (configurable in code)
- Slash chords: bass note recognized but not modeled separately (will resolve to root position)

The Python pipeline is more accurate than browser-based MIDI parsing and is recommended.

### 3. Run the Desktop App (Electron)

The visualizer is now a desktop app under `app/`:

```bash
cd app
npm install        # first time only
npm start          # launch the app
npm run dist       # package a Windows installer (electron-builder)
```

Structure:

```
app/
  main.js            Electron main process (window + JSON IPC)
  preload.js         contextBridge (traceAPI.readJSON)
  renderer/
    index.html       markup only
    css/style.css
    js/              config / scene / cosmos / particles / chords / playback / ui / app
    vendor/          three.js r128 + bloom passes + Tone.js + tween + midi-parser (offline)
    data/            chord_table.json + sample progressions
```

After regenerating `chord_table.json`, copy it into `app/renderer/data/`.

Rendering upgrades (logic unchanged): multi-layer twinkling star field, nebula sprites, cosmic dust, per-chord particle clouds (current chord pulses), stardust flowing along the trail, UnrealBloom + ACES tone mapping.

MIDI-only pipeline (v2): the progression JSON entry is removed. A single MIDI import drives everything: tempo/time-signature from MIDI meta events; chords recognized in the frontend (HarmAn-style template scoring S=P-N-M over beat-quantized weighted chroma with metric-position and bass weighting to suppress passing tones, per-bar DP segmentation capped at 4 segments/bar, adjacent same-root+quality segments merged); the key is auto-guessed (Krumhansl-Schmuckler) and user-confirmed in the sidebar Key section, with "at bar N modulate to key X" rows. Before the embedding lookup, (root, pcs) are transposed so the current tonic maps to C (tension embeddings are C-based; minor keys align to the relative major). Coords come from embedding_table.json (24576 entries, full coverage). Playback advances per segment by its actual duration in beats. A fade slider (below line width) fades chords/lines older than N bars over 4 bars (slider max = off) so long pieces stay readable; the trail stardust curve shrinks to the visible window. Segment growth tweens are finalized (never stranded) when the next chord arrives early - this was the cause of randomly missing lines with short segments. Analysis resolves boundaries at half-beat precision (change penalty 0.45) and merges adjacent segments only when root+bass+quality+pcs are all identical.

Extended vocabulary (v3): 27 templates - triads, 7ths (incl. m7b5/dim7/mMaj7), 9/11/13 with alterations (7b9, 7#9, 7#11, 7b13, add9...) using core/optional template scoring (missing optional tones like the 5th are free; missing core tones are penalized; slight complexity bias prefers simpler explanations). Inversions are detected when the sounding bass differs from the chord root (slash labels like Cmaj7/E). Embeddings come from embedding_table_v2.json (159,744 entries, 8.6MB), re-exported from outputs/output_ae/best_model.pt by webapp/generate_table_v2.py with a bass-aware chroma encoding: root=1.0, bass=0.75 when != root, other actives=0.5 - so inversions get their own coordinates. chord_table.json (background constellation) was re-exported with the same checkpoint for a consistent space (the old tables came from an older training run and no longer matched any current checkpoint). The chord section shows a live d (distance from previous chord) / t (tension = norm in the C-based space) / Roman-numeral degree readout (degree relative to the current key; lowercase for minor-family, ° for diminished). When no 7th actually sounds, dominant-vs-major flavor defaults to the diatonic 7th of the current key (F13 with no 7th in C major -> Fmaj13; G stays dominant since F is diatonic); the sounding-note pcs and embedding lookup are unaffected. Boundary grid is whole-beat; inversions require the bass to be a template tone, dominate the low voice by time, and carry >=55% of max chroma weight.

Audio: polyphonic piano via Tone.Sampler with 13 bundled Salamander samples (vendor/piano/, loaded over IPC in Electron since file:// fetch is blocked; PolySynth fallback if samples fail). Notes are triggered span-wise with triggerAttackRelease so every note schedules its own release - the old monophonic Synth (chord notes stole one voice; attack-only clicks) and window-based release logic (missed frames left voices droning after pause) are gone. Pause releases all voices and remembers the position; Play resumes from it; Restart rewinds.

UI: collapsible left sidebar (SeeMusic-style, drag right edge to stretch) with playback, file loading, appearance controls and placeholder sections for future features. Chord colors are a two-step choice: (1) chord scheme - functional T/S/D 3-color (tonic estimated as the most frequent root) or major/minor/dominant/altered 4-color; (2) palette - vivid-bright / soft-bright / vivid-deep. Plus 3 comet color schemes, dark/light background themes (light mode: darker spheres, sparse gray dots, bloom off), star-density knob (default budget = max) and a path line-width slider (middle = default). The chord list sits directly under the Key section, auto-scrolls to keep the current bar centered, and shows per-chord metrics (d = distance from the previous chord, t = tension = norm in the C-based embedding space); the old Info panel and comet-color picker are removed. Appearance/More sections are collapsible; palettes are picked via mini color-wheel swatches (conic gradients). Audio stays in lockstep with the visuals: the loop wrap reseeks audio to beat 0 (this was why replays went silent), chord-list jumps seek audio to that chord, and Restart rewinds both. Progression coords are normalized on load (table lookup first, else first occurrence wins) to fix inconsistent random positions from midi_to_chords.py for chords missing from chord_table.json. Particle buffers are allocated once at a capped budget (pixel ratio ≤1.5); the density knob only changes drawRange. Bloom is disabled on the light theme (a white background exceeds the bloom threshold and washes out dark lines).

Browser fallback still works: serve `app/renderer/` with any static server (`python -m http.server`) — data loads via fetch instead of IPC.

The visualizer:
- Auto-loads `chord_table.json`
- Shows file picker to upload a progression JSON
- Plays back with tempo control (BPM slider)
- Shows 3D path, circle-of-fifths inset, chord list sidebar

## File Formats

### `chord_table.json`

Generated by `generate_table.py`. Example:

```json
{
  "Cmajor": {
    "coords": [-0.2014, -0.4274, -0.0474],
    "root": 0,
    "quality": "major"
  },
  "Dminor": {
    "coords": [0.3372, -0.4073, -0.1587],
    "root": 2,
    "quality": "minor"
  }
}
```

Format: `{Root}{quality}` where:
- Root: pitch name (C, C#, D, Eb, E, F, F#, G, G#, A, Bb, B)
- Quality: major, minor, dominant7, maj7, min7, dim, aug, sus2, sus4

### `*_progression.json`

Generated by `midi_to_chords.py`. Example:

```json
[
  {
    "bar": 1,
    "label": "Cmajor",
    "root": 0,
    "quality": "major",
    "coords": [-0.2014, -0.4274, -0.0474],
    "onset": 0.0
  },
  {
    "bar": 2,
    "label": "Aminor",
    "root": 9,
    "quality": "minor",
    "coords": [0.3716, -0.4073, -0.1587],
    "onset": 4.0
  }
]
```

## Features

### 3D Visualization (Three.js)

- **Background spheres**: all chords in chord_table.json (dim, translucent)
- **Active path**: bright spheres for chords in progression, connected by tube trail
- **Current chord**: larger sphere with outline, label floating above
- **Lighting**: point light following current chord, soft glow on nearby spheres
- **Camera**: auto-orbit (slow rotation), mouse drag to rotate, scroll to zoom

### Sidebar

- **Chord list**: all chords in progression; click to jump
- **Play/Pause/Restart**: playback controls
- **BPM slider**: tempo (60–200 BPM)
- **Info panel**: current chord, next chord, harmonic distance, bar number

### Circle of Fifths

- **Inset (top-right)**: 12 pitch classes in circle-of-fifths order
- **Highlight**: current chord's root in its quality color
- **Ring**: last 4 chord roots fading out

## Chord Recognition Pipeline (midi_to_chords.py)

### Overview

The chord recognition process balances accuracy with simplicity:

```
MIDI notes (quantized to bars)
    ↓
[1] Strong-beat filtering (beat 1, 3)
    ↓
[2] Duration-weighted voting (threshold: 20% of bar)
    ↓
[3] Passing tone removal (stepwise neighbor heuristic)
    ↓
[4] music21 chord analysis (root + quality)
    ↓
[5] Label format: {Root}{quality}
```

### Step-by-Step

**1. Strong-Beat Filtering**
- Only consider notes that **start** on beat 1 or 3 (in 4/4)
- Tolerance: ±0.25 quarter notes (allows slight timing variations)
- If no strong-beat notes found, fallback: use all notes in bar
- This emphasizes harmonic structure over passing tones

**2. Duration-Weighted Voting**
- Each note contributes a weight proportional to its duration
- Filter out notes that contribute < 20% of total bar duration
- This removes quick passing chords and fragments
- Example: in a bar with quarter notes, a sixteenth note would be filtered

**3. Passing Tone Removal**
- Heuristic: identify pitches that are major/minor 2nd intervals to neighbors
- Flag as likely passing tones and remove if they're short duration
- **Limitation:** This is not perfect — complex voicings may confuse the heuristic
- Document all identified passing tones in console output

**4. music21 Chord Analysis**
- Construct `music21.chord.Chord` from cleaned pitch set
- Call `removeRedundantPitchClasses()` to remove octave duplicates
- Extract root via `chord.root()` (music21's analysis)
- Extract quality via `chord.quality` and `chord.commonName`
- Map to TRACE label format (see `QUALITY_MAP`)

**5. Empty Bars**
- If a bar has no notes after filtering: skip it, leave a gap in visualization
- Logged as `(empty)` in console

### Example

Input MIDI bar (4/4):
```
Beat 1: C, E, G (quarter note)   -> weight 1.0
Beat 2: E, G (eighth notes)      -> weight 0.5 each
Beat 3: A, D, F (quarter note)   -> weight 1.0
Beat 4: C (half note)            -> weight 2.0
```

Processing:
- Strong beats: beat 1 (C, E, G) and beat 3 (A, D, F)
- Duration votes: C:1.0, E:1.0, G:1.0, A:1.0, D:1.0, F:1.0
- Total bar duration: 4.0
- Threshold: 4.0 × 0.2 = 0.8
- All notes pass threshold
- Passing tone check: D is 5th above A; F is 7th above A; all are chord tones
- Result: **Chord(A, D, F, C) → F major** or **Dm** depending on voicing

### Customization

To adjust the pipeline, edit these in `midi_to_chords.py`:

```python
# Strong beat positions (beat 1, 3 in 4/4)
strong_beats = [1, 3]
beat_tolerance = 0.25  # Quarter notes

# Duration threshold (20% of bar)
threshold = total_duration * 0.2

# Fallback if strong beats yield no chords
# (automatically uses all notes in bar)
```

### Known Limitations

1. **Chord recognition**: Relies on music21's heuristics, which can misidentify complex voicings
2. **Passing tone removal**: Heuristic-only, not music-theoretically rigorous
3. **Slash chords**: Bass note recognized but not modeled separately
4. **Time signature**: Assumes 4/4 (can be hardcoded to other signatures)
5. **Polyphony**: Works best on monophonic or well-voiced harmonic MIDI
6. **Microtiming**: Quantizes to bar level (loses intra-bar timing info)

---

## Architecture Notes

### MLP Encoder (Context-Free)

The VAE encoder is a simple MLP:
```
input [B, T, 15] → reshape [B*T, 15] → MLP → [B*T, 3] → reshape [B, T, 3]
```

This means:
- Each chord is encoded independently
- No sequential/contextual information in the encoder
- Context effects only appear in the loss function (TPS regularization)

Therefore:
- Same chord gets same latent coordinates regardless of context
- Chords are **deterministic** (no sampling from encoder)
- Simple lookup table is sufficient

### Three.js Compatibility

- Uses Three.js r128 from CDN
- Manual OrbitControls (no external dependency)
- Fallback colors if quality not found
- All code in single HTML file (no build step)

## Embedding Format

Both Python scripts construct embeddings identically:

```python
chroma = torch.zeros(12)
chroma[root] = 1.0
# (chord tones would be 0.5, not used in VAE encoder baseline)

angle = 2 * pi * root / 12
root_circle = [sin(angle), cos(angle)]

log_duration = log(1 + duration)

embedding = [chroma (12D), root_circle (2D), log_duration (1D)]  # 15D total
```

**Important:** The embedding construction must match exactly in both scripts, or lookups will fail.

## Future Enhancements

1. **Video export**: render progression to MP4 with audio
2. **Audio playback**: synth playback of chord progression
3. **Standalone app**: Electron/Tauri wrapper for desktop
4. **Browser MIDI parsing**: drag-and-drop MIDI for instant preview (approximate)
5. **Inversion handling**: model slash chords as bass variations
6. **Harmony analysis**: overlay Krumhansl similarity or functional analysis
7. **Multi-track layout**: visualize multiple voices simultaneously
8. **Collaborative mode**: WebSocket-based real-time playback sharing

## Troubleshooting

**Q: `chord_table.json` not found**  
A: Run `generate_table.py` first. Ensure it's in the same directory as `index.html`.

**Q: Progression JSON not loading**  
A: Check that JSON format matches expected schema (see above). Use browser DevTools console to see errors.

**Q: Model path error in `generate_table.py`**  
A: Edit `VAE_MODEL_PATH` at the top of the script. Use absolute or relative path.

**Q: Embedding mismatch (chords not found in table)**  
A: Ensure `midi_to_chords.py` imports the same embedding function as `generate_table.py`. Both must construct 15D vectors identically.

**Q: MIDI chords recognized incorrectly**  
A: music21 chord recognition is approximate. Use the Python pipeline output as ground truth. Adjust `QUALITY_MAP` in `midi_to_chords.py` if needed.

## License

Research project. Use and modify freely for academic/personal purposes.
