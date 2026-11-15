// ========== APP ENTRY + ANIMATION LOOP ==========
// Playback/camera/light logic identical to the original app.
// Additions: cosmos update, chord particle clouds, trail stardust, bloom composer.

const _clock = new THREE.Clock();

// A chord's start/end on the audio timeline (seconds from the top of the MIDI)
const chordStartSec = (c) => ((c.bar - 1) * beatsPerBar + (c.beatInBar || 0)) * 60 / bpm;
const chordEndSec = (c) => chordStartSec(c) + (c.durBeats || beatsPerBar) * 60 / bpm;

function animate() {
    requestAnimationFrame(animate);
    const t = _clock.getElapsedTime();

    // Update playback. The audio clock leads: a chord becomes current when
    // the audio reaches the chord's own start time. Advancing by summing
    // segment durations from "the frame we noticed" lost up to a frame per
    // chord (0.47 s behind by the end of a 15-chord piece), and ignored where
    // the first chord starts - pieces with a pickup or leading rest showed
    // every chord over a second before it sounded.
    if (isPlaying && progression.length > 0) {
        const now = Date.now();
        const nextIndex = (currentIndex + 1) % progression.length;
        const boundary = nextIndex === 0
            ? chordEndSec(progression[currentIndex])
            : chordStartSec(progression[nextIndex]);
        const audioSec = midiStartTime
            ? (now - midiStartTime) / 1000
            : chordStartSec(progression[currentIndex]) + (now - lastBeatTime) / 1000;

        if (audioSec >= boundary) {

            // Create interpolation animation to next chord
            if (progression[nextIndex]) {
                lightTarget.copy(chordScenePos(nextIndex));
                const nextDurMs = (progression[nextIndex].durBeats || beatsPerBar) * beatDurationMs;

                // Animate light follower (never longer than the segment itself)
                new TWEEN.Tween(lightFollower.position)
                    .to(lightTarget, Math.min(beatDurationMs * 2, nextDurMs * 0.8))
                    .easing(TWEEN.Easing.Quadratic.InOut)
                    .start();
            }

            currentIndex = nextIndex;
            // the chord's true start on the audio clock, not this frame
            lastBeatTime = midiStartTime && nextIndex !== 0 ? midiStartTime + boundary * 1000 : now;
            if (currentIndex === 0) {
                if (isExporting) {
                    finishVideoExport();    // full pass recorded: stop and save
                } else {
                    resetReveal();          // looped back to bar 1: start the journey again
                    audioSeekToBeat(0);     // FIX: audio restarts with the visual loop
                }
            } else {
                revealChord(currentIndex, true);  // reveal + animated path segment
            }
            updateUI();
        }

        // Update MIDI playback
        if (midiNotes.length > 0 && midiStartTime) {
            const elapsedSecs = (now - midiStartTime) / 1000;
            playMidiNotes(elapsedSecs);
        }
    }

    // Update tweens
    TWEEN.update();

    // Light follower (animated via Tween)
    if (progression.length > 0) {
        const chord = progression[currentIndex];
        // Set initial position if first time
        if (!lightInitialized) {
            lightFollower.position.copy(chordScenePos(currentIndex));
            lightTarget.copy(lightFollower.position);
            lightInitialized = true;
        }
    }

    // Camera: smooth-follow current chord, orbit around it
    updateCamera();

    // Sphere highlight: the current chord is larger with a stronger halo.
    // Emissive stays low so the ball keeps its own hue: measured on a #3d9bff
    // chord, emissive 0.9 rendered 205,217,222 (white), 0.35 still 174,202,214,
    // 0.15 gives 141,185,204. The glow is the halo sprite
    // (chords.js), in the chord's colour. Off-key (离调) chords keep an
    // elevated halo even when not current.
    const emissiveScale = bgThemeKey === 'light' ? 0.35 : 1.0;
    activeChordSpheres.forEach((sphere, idx) => {
        const fade = getFadeFactor(idx);
        const offKeyBoost = progression[idx] && progression[idx].offKey ? 1.6 : 1.0;
        const halo = sphere.userData.halo;
        if (idx === currentIndex) {
            sphere.material.emissiveIntensity = 0.15 * emissiveScale;
            sphere.scale.setScalar(1.5);
            sphere.material.opacity = 1.0;
            halo.material.opacity = Math.min(0.9, 0.55 * offKeyBoost);
        } else {
            sphere.material.emissiveIntensity =
                Math.max(0.05, 0.12 - (currentIndex - idx) * 0.035) * emissiveScale * fade;
            sphere.scale.setScalar(1.0);
            sphere.material.opacity = fade;
            halo.material.opacity =
                Math.max(0.05, 0.18 - (currentIndex - idx) * 0.03) * offKeyBoost * fade;
        }
        const label = activeChordLabels[idx];
        if (label && label.visible) {
            label.material.opacity = idx === currentIndex ? 1.0 : 0.75 * fade;
        }
    });

    // Fade old path segments (tube connects chord toIdx-1 -> toIdx); a tube
    // follows its MORE-FADED endpoint (the older chord), so when a sphere
    // vanishes every line touching it vanishes with it - no dangling lines.
    // Each tube keeps its tension-tier opacity as the fade baseline.
    // (getFadeFactor returns 1 when fading is off, which also restores tubes
    // hidden before the slider was moved back to ∞)
    if (pathGroup) {
        pathGroup.children.forEach((tube) => {
            const base = bgThemeKey === 'light' ? 0.9 : 0.5;
            const tier = tensionTier(tube.userData.rawD ?? 4);
            const toIdx = tube.userData.toIdx ?? currentIndex;
            const fade = Math.min(getFadeFactor(Math.max(0, toIdx - 1)), getFadeFactor(toIdx));
            tube.material.opacity = Math.min(1, base * tier.opacityMul) * fade;
            tube.visible = fade > 0;
        });
    }

    // Enhanced rendering updates
    updateChordLabels();
    updateViews();
    updateCosmos(t);
    updateChordClouds(t);
    updateTrailFlow(t);
    updateLandmarks(t);
    updateRadar();
    updateAeViz();
    updateTimeline();

    // Render with (selective) bloom post-processing
    renderFrame();

    // Video export: mirror this freshly rendered frame into the recording
    // (same task as the render, so the buffer is guaranteed still valid)
    exportCaptureFrame();
}

// Initialize
initScene();
initCosmos();
initAudio();
bindControls();
bindProjects();          // MIDI import, start prompt, two-slot project cache
bindMovePanel();        // move panel timeline: click to jump
bindTimeline();         // progress bar in the control strip: click / drag to seek
bindChordEditor();      // full-screen chord editor (E)
initChordSpace();       // diatonic landmarks + boundary shell + heads-up anchors
initRadar();            // circle-of-fifths tension radar (top-right)
initAeViz();            // autoencoder panel (bottom-right)
embeddingTableReady = loadEmbeddingTable();   // full (root, pcs) -> coords table
embeddingTableReady.then(initViews);           // experimental view layouts need the table
// Canvas panels draw text before webfonts are used anywhere in the DOM:
// load Plex up front and redraw the AE panel once it is in.
if (document.fonts) {
    Promise.all(['500 10px "IBM Plex Mono"', '600 10px "IBM Plex Mono"', '400 10px "IBM Plex Mono"']
        .map(f => document.fonts.load(f))).then(() => { aeDirty = true; }).catch(() => {});
}
animate();
