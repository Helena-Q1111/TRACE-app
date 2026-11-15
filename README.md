# TRACE Visualizer

TRACE Visualizer turns a MIDI performance into an interactive map of its harmony. Open a `.mid` or `.midi` file to hear the piece and watch its chord progression travel through a three-dimensional tonal space.

The app is the interactive companion to the **TRACE-Research** project. The research repository presents the training experiments and evaluation results behind the learned chord space; this app lets you explore that space through music.

## Explore a piece

- **Open a MIDI file** from the app or drag it into the scene. TRACE reads tempo, meter and notes across tracks, then identifies the chord progression and estimates the key.
- **Follow the harmony in 3D.** Chords appear as colored points connected by an animated path. Labels show chord names and Roman-numeral scale degrees; spatial landmarks help orient the progression around its tonal center.
- **Listen as you explore.** Play, pause, seek and jump through the piece while the audio and visualization stay synchronized. Choose piano, sine, electric piano or pad timbres.
- **Inspect chord movement.** Compare each transition's tonal-distance components with the learned embedding distance, see how chord tones move, and follow the progression's distance from the tonic.
- **Watch the circle-of-fifths radar.** Chords move around the wheel as the tonal center changes, with their distance from the tonic shown as radial distance.
- **See the embedding in action.** The live model panel shows how the current chord maps to its point in the 3D space. Its tension view compares theory distances with learned transition distances across the piece.

## Edit the recognized chords

Open **Edit chords…** or press **E** to review and correct the progression on a bar-by-bar grid.

- Select a chord to change its name, bar or beat. Beat positions can be set to quarter-beat precision.
- Double-click a beat to add a chord there; the new chord starts as a copy of the chord sounding at that position.
- Delete chords, undo edits, cancel a session, or revert the progression to the original recognition.
- Apply edits to refresh the visualization and playback. Edited chords are saved with the MIDI project and remain available when you reopen it.
- The editor accepts common chord spellings, extensions and slash-bass notation, with live feedback as you type.

The progress bar also supports clicking and dragging to any point in the piece, including the middle of a chord.

## Make it yours

- Choose chord colors by harmonic function or chord quality, with several palette styles.
- Switch between a starfield and a light theme.
- Adjust star density, path width and how quickly older sections fade.
- Explore the 3D scene by moving the camera; tonal landmarks stay available as visual reference points.
- Export a complete playback as a video with audio. TRACE creates MP4 when the system supports it and uses WebM as a fallback.

TRACE keeps the two most recently opened MIDI projects, including chord edits, key and modulation settings, and the last playback position.

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

The [`demomidi/`](demomidi/) folder contains MIDI examples, from simple triads to more involved progressions. Open any of them in TRACE to compare how the visualization and chord editor respond to different music.

## Research companion

TRACE Research describes the 3D embedding, training setup, chord-feature ablations and evaluation against tonal-organization and sequence-tension references. Together, the two projects provide the experimental results and an interactive way to experience the learned harmonic space.
