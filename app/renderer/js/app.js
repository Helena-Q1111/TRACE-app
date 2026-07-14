// ========== APP ENTRY + ANIMATION LOOP ==========
// Playback/camera/light logic identical to the original app.
// Additions: cosmos update, chord particle clouds, trail stardust, bloom composer.

const _clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = _clock.getElapsedTime();

    // Update playback: advance per chord segment using its actual duration
    if (isPlaying && progression.length > 0) {
        const now = Date.now();
        const elapsed = now - lastBeatTime;
        const segDurMs = (progression[currentIndex].durBeats || beatsPerBar) * beatDurationMs;

        if (elapsed > segDurMs) {
            const nextIndex = (currentIndex + 1) % progression.length;

            // Create interpolation animation to next chord
            if (progression[nextIndex]) {
                const nextCoords = displayCoords(progression[nextIndex].coords);
                lightTarget.set(...nextCoords);
                const nextDurMs = (progression[nextIndex].durBeats || beatsPerBar) * beatDurationMs;

                // Animate light follower (never longer than the segment itself)
                new TWEEN.Tween(lightFollower.position)
                    .to(lightTarget, Math.min(beatDurationMs * 2, nextDurMs * 0.8))
                    .easing(TWEEN.Easing.Quadratic.InOut)
                    .start();
            }

            currentIndex = nextIndex;
            lastBeatTime = now;
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
            lightFollower.position.set(...displayCoords(chord.coords));
            lightTarget.copy(lightFollower.position);
            lightInitialized = true;
        }
    }

    // Camera: smooth-follow current chord, orbit around it
    updateCamera();

    // Sphere highlight: current chord glows brighter and larger
    // (emissive scaled down on the light theme so colors don't wash out)
    // Off-key (离调) chords keep an elevated glow even when not current.
    const emissiveScale = bgThemeKey === 'light' ? 0.35 : 1.0;
    activeChordSpheres.forEach((sphere, idx) => {
        const fade = getFadeFactor(idx);
        const offKeyBoost = progression[idx] && progression[idx].offKey ? 2.2 : 1.0;
        if (idx === currentIndex) {
            sphere.material.emissiveIntensity = (offKeyBoost > 1 ? 1.4 : 1.0) * emissiveScale;
            sphere.scale.setScalar(1.5);
            sphere.material.opacity = 1.0;
        } else {
            sphere.material.emissiveIntensity =
                Math.max(0.1, 0.3 - (currentIndex - idx) * 0.1) * offKeyBoost * emissiveScale * fade;
            sphere.scale.setScalar(1.0);
            sphere.material.opacity = fade;
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
    updateCosmos(t);
    updateChordClouds(t);
    updateTrailFlow(t);
    updateOriginMarker(t);

    // Render with bloom post-processing
    composer.render();
}

// Initialize
initScene();
initCosmos();
initAudio();
bindControls();
initChordSpace();       // tonic reference beacon (no preset constellation)
loadEmbeddingTable();   // full (root, pcs) -> coords table
animate();
