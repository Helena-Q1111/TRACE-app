# TRACE Visualizer

TRACE Visualizer turns a MIDI performance into an interactive map of its harmony. Open a `.mid` or `.midi` file to hear the piece, follow its chord progression through a three-dimensional tonal space, and edit the analysis as you listen.

The app is the interactive companion to **TRACE-Research**, which studies how tonal-theory distances shape a learned 3D chord space and evaluates that space against human tonal-organization and tension data. TRACE Visualizer brings that research into a form people can hear, explore and use.

## Starting point

Music software can show chord names, play a recording or draw a piano roll. TRACE began with a different question: what would it feel like to move through a song's harmony as a place?

The starting point was the learned 3D chord embedding from the TRACE research. The development goal was to connect that representation to a complete musical experience: read a real MIDI performance, identify its harmony, let listeners compare theory with the learned space, and keep the analysis open to correction.

## Explore a piece

### Recognize chords and tonal context

TRACE analyzes the notes across MIDI tracks and turns them into a progression of named chords. Its recognizer covers 14 common chord qualities, from major and minor triads to suspended and seventh chords, then identifies extensions such as ♭9, 9, ♯9, 11, ♯11, ♭13 and 13. It also uses bass and register to distinguish inversions, slash-bass chords and suspended notes from extensions. Chord names, Roman numerals and off-key status update with the selected key and modulation points.

### Follow the harmony in 3D

After a MIDI file is opened, TRACE draws its chord progression as a route through the tonal space. Chords appear one by one during playback as colored spheres with chord-name and Roman-numeral labels. The connecting path blends the colors of adjacent chords, while four line-width levels show the size of each move in the learned space. A soft chord halo and particle field make each point easy to follow against either the starfield or paper background.

Spatial anchors keep the route interpretable as the camera moves. The tonic and the seven diatonic scale degrees remain available as landmarks, and a surrounding reference shape shows the tonal distances radiating from the home chord. Off-key chords stand out in the scene, so listeners can see where a progression moves beyond its current key.

### See what changes from chord to chord

The **Now** panel follows the current transition, showing the previous chord and the chord being played. It compares the theoretical distance `δ = i + j + k` with the learned embedding distance `‖Δz‖`, displays how chord tones move, and plots the progression's distance from the tonic. The four most recent transitions provide a compact history; selecting a point on the tonic-distance curve jumps playback to that chord.

The **circle-of-fifths radar** provides a second view of the same journey. Its twelve pitch classes rotate with the current tonal center. Each chord is plotted by root, with its distance from the tonic shown as its radius; a five-chord fading trail keeps the recent path visible.

### Inspect the learned representation

The live **Autoencoder** panel shows how the current chord's features map to its point in the 3D scene. Its Forward view follows that chord from its input features to its latent coordinate. Its Tension view compares theory distances with learned distances across the piece and shows the M2 and M0 reference models. This makes the relationship between tonal theory and the visual route available while the song plays.

### Listen, navigate and compare

TRACE reads the MIDI tempo and meter and keeps audio playback aligned with the visual progression. Play or pause with the transport controls or space bar, choose among piano, sine, electric piano and pad timbres, and use the color-coded timeline—with bar markers every four bars—to click or drag to any moment, including the middle of a chord. The playhead, audio and 3D scene move together.

### Review the key and modulations

TRACE estimates the piece's main key and presents it for review. You can select another key or add modulation points by bar. Roman-numeral labels, tonal anchors and the circle-of-fifths radar update with the selected tonal centers, letting you compare the same chord in its changing harmonic context.

## Edit the recognized chords

Automatic analysis is designed to make a progression easy to explore, and the editor gives you direct control over the result. Open **Edit chords…** or press **E** to review the whole piece on a bar-by-bar grid.

- Select a chord to edit its name, bar or beat. Positions support quarter-beat precision.
- Double-click a beat to add a chord there; the new entry starts from the chord sounding at that moment.
- Delete chords, undo up to 100 edits, cancel a session, or revert to the original recognized progression.
- Apply edits to rebuild the route and playback while keeping the current play position.
- See Roman-numeral analysis and chord tones as you edit. Common spellings, extensions and slash-bass chords are accepted, with immediate feedback on invalid input.
- Edited chords are saved with the MIDI project and marked in the editor and sidebar when you reopen it.

## Make the view your own

- Color chords by harmonic function or chord quality, then choose a bright saturated, bright soft or deep saturated palette.
- Switch between the deep-space starfield and a light paper theme.
- Adjust star density, path width and how many bars of the route remain visible.
- Move the camera to explore the route; keep spatial anchors visible as reference points.
- Export a complete playback as a video with sound. TRACE uses H.264/AAC MP4 when supported and falls back to WebM.

TRACE keeps the two most recently opened MIDI projects, including chord edits, key and modulation settings, and the last playback position.

## How the experience was developed

Development followed the journey a listener takes through a piece. First, the research embedding became an explorable 3D route. MIDI import and chord analysis then connected that route to real performances. Key detection, tonal landmarks, the circle-of-fifths radar and transition details added context to the space. Playback and a seekable timeline made the route unfold with the music. The chord editor and saved projects made the analysis practical for pieces whose automatic labels need a musician's judgment. Video export made a complete journey easy to share.

### Design challenges

**A MIDI contains notes, not chord labels.** Notes overlap, bass lines can imply inversions, and the same pitch class can function as a suspension or an extension depending on its register. TRACE weighs pitch, duration, meter and bass evidence while identifying chord boundaries. It distinguishes common chord qualities from extensions and uses register to separate suspended notes from ninths and elevenths. The editor keeps the result understandable and lets a musician correct names, voicings or timing directly.

**A progression needs context.** A chord's role changes with the key, and that key can change during a piece. TRACE combines automatic key estimation with editable modulation points, then updates Roman numerals and spatial references by bar. The transition panel, tonic-distance curve and fifths radar offer complementary views of that context.

**The visual route has to follow the performance.** A MIDI's tempo map, meter and chord onsets determine when each sound and visual event should occur. TRACE reads timing from the file and uses one timeline for playback, seeking and chord transitions. Users can seek to an exact moment and continue with the sound and scene aligned.

**An analytical space should invite exploration.** A three-dimensional plot can be hard to read without musical landmarks. Chord labels, tonal anchors, color schemes, distance readouts and the radar connect the spatial path to familiar musical ideas. The forward and tension panels let curious listeners follow how a chord reaches its place in the space.

## Get started

### Desktop app

Requires Node.js and npm.

```bash
cd app
npm install
npm start
```

To create the portable Windows build:

```bash
npm run dist
```

The build is written to `webapp/build/`.

### Run in a browser

From the `webapp` directory, serve the renderer files locally:

```bash
python -m http.server 8000 --directory app/renderer
```

Then open [http://localhost:8000](http://localhost:8000). Start playback or select a timbre once to enable browser audio.

## Try the examples

The [`demomidi/`](demomidi/) folder contains MIDI examples, from simple triads to jazz and classical progressions. Open one in TRACE to explore the automatic analysis, playback and chord editor.

## Research companion

TRACE-Research documents the experiment design, feature ablations and evaluation results behind the learned chord space. Together, the two projects connect the research question—how tonal relationships can shape a compact chord representation—with an interactive way to experience those relationships in music.
