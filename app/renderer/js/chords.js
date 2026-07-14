// ========== CHORD TABLE + PROGRESSION RENDERING ==========
// Progressive reveal: chords appear as playback reaches them; each transition
// draws an animated growing path segment (with a comet head) from the previous
// chord to the current one. Looping back to bar 1 resets the journey.

let pathGroup = null;       // accumulated revealed path segments
let activeSegmentTween = null;
let activeSegmentMeta = null;   // {tube, p1} of the currently growing segment
let cometHead = null;
let revealedPoints = [];    // Vector3s of revealed chords (drives trail stardust)
let trailFlow = null;       // stardust flowing along the revealed path
let trailCurve = null;
let activeChordLabels = []; // roman-numeral sprites above progression chords
let originMarker = null;    // tonic reference beacon at the I chord position
let originGlow = null;      // additive glow sprite behind the beacon
let originStars = null;     // small stars orbiting the beacon

// ---- Text label sprites ----
// THREE.Sprite always faces the camera and scales with distance, so labels
// zoom with the scene but never tilt - UI-like tags pinned above each chord.
function makeLabelTexture(text, dim) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '600 44px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.font = font;
    canvas.width = Math.max(64, Math.ceil(ctx.measureText(text).width) + 24);
    canvas.height = 64;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const light = isLightBg();
    ctx.strokeStyle = light ? 'rgba(255,255,255,0.85)' : 'rgba(3,3,8,0.85)';
    ctx.lineWidth = 6;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = light
        ? (dim ? 'rgba(15,15,28,0.7)' : 'rgba(5,5,15,1)')
        : (dim ? 'rgba(215,224,255,0.55)' : 'rgba(240,244,255,0.95)');
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    return { texture: new THREE.CanvasTexture(canvas), aspect: canvas.width / canvas.height };
}

const LABEL_HEIGHT = 0.7;
function makeLabelSprite(text, dim) {
    const { texture, aspect } = makeLabelTexture(text, dim);
    const material = new THREE.SpriteMaterial({
        map: texture, transparent: true, depthWrite: false, depthTest: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(LABEL_HEIGHT * aspect, LABEL_HEIGHT, 1);
    sprite.renderOrder = 10;   // readable over spheres/particles
    sprite.userData.labelText = text;
    sprite.userData.labelDim = !!dim;
    return sprite;
}

// Redraw a label's texture for the current background theme
function refreshLabelTexture(sprite) {
    const { texture, aspect } = makeLabelTexture(sprite.userData.labelText, sprite.userData.labelDim);
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = texture;
    sprite.scale.set(LABEL_HEIGHT * aspect, LABEL_HEIGHT, 1);
    sprite.material.needsUpdate = true;
}

// The background constellation is gone: the scene only shows the tonic
// reference at the origin plus the progression itself. Everything is read
// relative to the I chord.
function initChordSpace() {
    addOriginMarker();
    applyVisualTheme();
}

// Tonic (I) reference beacon at the C major triad embedding position.
// Larger and brighter than any progression sphere. Pure white on the dark
// theme, near-black on light. (MeshBasicMaterial: unlit, so it always reads
// at full brightness and the bloom pass gives it a halo on the dark bg.)
// A soft glow sprite plus a slowly orbiting ring of small stars make the
// beacon read as the gravitational center of the scene.
function addOriginMarker() {
    if (originMarker) return;
    const pos = displayCoords(TONIC_I_COORDS);

    const geometry = new THREE.SphereGeometry(0.22, 24, 24);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    originMarker = new THREE.Mesh(geometry, material);
    originMarker.position.set(pos[0], pos[1], pos[2]);
    scene.add(originMarker);

    // Glow halo (child of the marker so it tracks position automatically)
    originGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    }));
    originGlow.scale.set(1.7, 1.7, 1);
    originMarker.add(originGlow);

    // Small stars in a shell around the beacon (rotated in updateOriginMarker)
    const starCount = 56;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
        const [x, y, z] = randomInShell(0.4, 1.0);
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    originStars = new THREE.Points(starGeo, new THREE.PointsMaterial({
        color: 0xdde4ff,
        size: 0.055,
        map: getGlowTexture(),
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    }));
    originStars.position.set(pos[0], pos[1], pos[2]);
    scene.add(originStars);

    styleOriginMarker();
}

function styleOriginMarker() {
    if (!originMarker) return;
    const light = isLightBg();
    originMarker.material.color.setHex(light ? 0x0a0a12 : 0xffffff);
    if (originGlow) originGlow.visible = !light;   // additive glow invisible on white
    if (originStars) {
        originStars.material.color.setHex(light ? 0x44445a : 0xdde4ff);
        originStars.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        originStars.material.opacity = light ? 0.55 : 0.8;
        originStars.material.needsUpdate = true;
    }
}

// Per-frame: slow orbital drift of the beacon's star ring
function updateOriginMarker(t) {
    if (!originStars) return;
    originStars.rotation.y = t * 0.12;
    originStars.rotation.x = Math.sin(t * 0.07) * 0.35;
}

// Load the full embedding table (24576 entries: any (root, pcs) -> 3D coords)
async function loadEmbeddingTable() {
    try {
        // v2: keys "root:bass:[pcs]" - bass-aware for inversions (re-exported
        // from outputs/output_ae/best_model.pt; chroma bass mark = 0.75)
        if (window.traceAPI) {
            embeddingTable = await window.traceAPI.readJSON('embedding_table_v2.json');
        } else {
            const response = await fetch('data/embedding_table_v2.json');
            embeddingTable = await response.json();
        }
        console.log(`Loaded embedding table v2: ${Object.keys(embeddingTable).length} entries`);
    } catch (e) {
        console.error('Failed to load embedding_table_v2.json:', e);
    }
}

// Canonical chord tones per quality (core+opt of the analyzer templates).
// The embedding lookup uses these instead of the raw sounding pcs: the same
// recognized chord always hits the same table entry, so coords no longer
// jitter when a 5th is omitted or a passing tension sneaks into the chroma.
const CANONICAL_TONES = (() => {
    const m = {};
    CHORD_TEMPLATES.forEach((t) => {
        m[t.quality] = [...new Set(t.core.concat(t.opt))].sort((a, b) => a - b);
    });
    // Diatonic re-flavors from adjustSeventhFlavor (no analyzer template)
    m.maj11 = [0, 2, 4, 5, 7, 11];
    m.maj13s11 = [0, 2, 4, 6, 7, 9, 11];
    return m;
})();

// (root, quality) -> coords via the canonical template tones, transposing to
// C by the key at this bar (embeddings are C-based: in A major shift +3).
// Falls back to the sounding pcs when the quality has no template.
function lookupEmbedding(root, bass, pcs, bar, quality) {
    const shift = transposeShiftForKey(keyAtBar(bar));
    const b0 = bass ?? root;
    let usePcs = pcs;
    const ivs = CANONICAL_TONES[quality];
    if (ivs) {
        const set = new Set(ivs.map(iv => (root + iv) % 12));
        set.add(b0);   // inversion bass is always part of the lookup set
        usePcs = [...set];
    }
    const r = (root + shift) % 12;
    const b = (b0 + shift) % 12;
    const keyOf = (arr, bassPc) =>
        `${r}:${bassPc}:[${arr.map(pc => (pc + shift) % 12).sort((x, y) => x - y).join(', ')}]`;
    let coords = embeddingTable[keyOf(usePcs, b)];
    if (!coords) coords = embeddingTable[keyOf(pcs, b)];       // sounding pcs
    if (!coords && b !== r) coords = embeddingTable[keyOf(usePcs, r)];  // root position
    if (!coords) console.warn(`Embedding not found: ${keyOf(usePcs, b)}`);
    return coords ? coords.slice() : [0, 0, 0];
}

// Full pipeline after a MIDI is parsed: recognize chords, guess the key,
// then build the progression (key can be corrected in the sidebar afterwards)
function analyzeAndBuildProgression() {
    analysisSegments = analyzeMidiToSegments(midiNoteSpans, beatsPerBar);
    console.log(`Recognized ${analysisSegments.length} chord segments`);

    const guess = guessKey(midiNoteSpans);
    keySignature = guess;
    keyModulations = [];
    estimatedTonic = guess.tonic;
    console.log(`Guessed key: ${keyName(guess)} (confirm in the sidebar)`);
    if (typeof syncKeyUI === 'function') syncKeyUI();

    rebuildProgressionFromAnalysis();
}

// (Re)build progression from cached segments - called after key changes too;
// recognition is key-independent, only the embedding lookup shifts.
function rebuildProgressionFromAnalysis() {
    progression = analysisSegments.map(seg => {
        // Diatonic 7th default: no sounding 7th -> flavor by the current key
        // (pcs unchanged, so the embedding lookup is unaffected)
        const quality = adjustSeventhFlavor(seg, seg.bar);
        const adjusted = { ...seg, quality, bass: seg.bass ?? seg.root };
        // Display label is the roman-numeral analysis (relative to the key at
        // this bar); the absolute name is kept for tooltips/debugging.
        return {
            bar: seg.bar,
            beatInBar: seg.beatInBar,
            durBeats: seg.durBeats,
            root: seg.root,
            bass: seg.bass ?? seg.root,
            quality: quality,
            pcs: seg.pcs,
            label: romanLabel(adjusted, keyAtBar(seg.bar)),
            absLabel: getChordLabel(adjusted),
            coords: lookupEmbedding(seg.root, seg.bass, seg.pcs, seg.bar, quality),
            offKey: isOffKey(seg.pcs, seg.bar)
        };
    });

    currentIndex = 0;
    isPlaying = false;
    lastBeatTime = Date.now();
    snapLightToCurrent();
    updateUI();
    renderProgression();
    applyChordColors();
}

// ---- Progressive reveal machinery ----

function clearProgressionObjects() {
    activeChordSpheres.forEach(s => scene.remove(s));
    activeChordSpheres = [];
    activeChordClouds.forEach(c => { if (c) scene.remove(c); });
    activeChordClouds = [];
    activeChordLabels.forEach(l => {
        scene.remove(l);
        if (l.material.map) l.material.map.dispose();
        l.material.dispose();
    });
    activeChordLabels = [];
    if (pathGroup) {
        pathGroup.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        scene.remove(pathGroup);
        pathGroup = null;
    }
    removeComet();
    if (activeSegmentTween) { activeSegmentTween.stop(); activeSegmentTween = null; }
    activeSegmentMeta = null;
    if (trailFlow) { scene.remove(trailFlow); trailFlow = null; trailCurve = null; }
    revealedPoints = [];
}

// Create all spheres + particle clouds once, hidden until revealed
function buildProgressionObjects() {
    pathGroup = new THREE.Group();
    scene.add(pathGroup);

    progression.forEach((chord, idx) => {
        const color = getThemedChordColor(chord);
        const pos = displayCoords(chord.coords);
        const geometry = new THREE.SphereGeometry(0.08, 32, 32);
        const material = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.3,
            roughness: 0.3,
            metalness: 0.7,
            transparent: true,   // enables per-chord fade-out
            opacity: 1.0
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(...pos);
        sphere.castShadow = true;
        sphere.visible = false;
        sphere.userData = { label: chord.label, idx, isActive: true };
        scene.add(sphere);
        activeChordSpheres.push(sphere);

        // Off-key chords get a larger, denser halo (extra brightness comes
        // from the emissive boost in the animation loop)
        const cloudRadius = chord.offKey ? 0.34 : 0.26;
        const cloudSize = chord.offKey ? 0.048 : 0.038;
        const cloud = createChordCloud(pos, color.getHex(), cloudRadius, RENDER_CFG.cloudPerChord, cloudSize);
        cloud.visible = false;
        scene.add(cloud);
        activeChordClouds.push(cloud);

        const tag = makeLabelSprite(chord.label, false);
        tag.position.set(pos[0], pos[1] + 0.55, pos[2]);
        tag.visible = false;
        scene.add(tag);
        activeChordLabels.push(tag);
    });
}

// Recolor everything after a chord-scheme / palette / theme change
function applyChordColors() {
    // Progression spheres + clouds
    activeChordSpheres.forEach((sphere, idx) => {
        const c = getThemedChordColor(progression[idx]);
        sphere.material.color.copy(c);
        sphere.material.emissive.copy(c);
        if (activeChordClouds[idx]) activeChordClouds[idx].material.color.copy(c);
    });
    // Sidebar dots
    updateUI();
}

// Path line width: rebuild segment tube geometries at the new radius.
// The slider factor scales all three tension tiers together; each tube
// keeps its own tier multiplier (stored rawD = model-space distance).
function applyLineWidth(factor) {
    lineWidthFactor = factor;
    if (!pathGroup) return;
    pathGroup.children.forEach((tube) => {
        const { p0, p1, rawD } = tube.userData;
        if (!p0 || !p1) return;
        const tier = tensionTier(rawD ?? p0.distanceTo(p1));
        const g = new THREE.TubeGeometry(
            new THREE.LineCurve3(p0, p1), 32, BASE_TUBE_RADIUS * lineWidthFactor * tier.widthMul, 8);
        tube.geometry.dispose();
        tube.geometry = g;   // full drawRange by default; the active tween re-clamps
    });
}

// Theme-aware styling: on the light background additive glow is invisible,
// so switch to normal blending with darkened colors and no emissive wash.
function isLightBg() { return bgThemeKey === 'light'; }

function styleTubeMaterial(material, rawD) {
    const scheme = getCometScheme();
    const tier = tensionTier(rawD ?? 4);
    material.color.setHex(scheme.tube);
    material.emissive.setHex(scheme.tubeEmissive);
    if (isLightBg()) {
        material.color.multiplyScalar(0.35);
        material.emissiveIntensity = 0.0;
        material.opacity = Math.min(1, 0.9 * tier.opacityMul);
    } else {
        material.emissiveIntensity = 0.18 * tier.emissiveMul;
        material.opacity = Math.min(1, 0.5 * tier.opacityMul);
    }
}

function styleFlowMaterial(material) {
    material.color.setHex(getCometScheme().flow);
    if (isLightBg()) {
        material.color.multiplyScalar(0.5);
        material.blending = THREE.NormalBlending;
        material.opacity = 0.6;
    } else {
        material.blending = THREE.AdditiveBlending;
        material.opacity = 0.45;
    }
    material.needsUpdate = true;
}

function styleCometMaterial(material) {
    material.color.setHex(getCometScheme().comet);
    if (isLightBg()) {
        material.color.multiplyScalar(0.55);
        material.blending = THREE.NormalBlending;
        material.opacity = 0.8;
    } else {
        material.blending = THREE.AdditiveBlending;
        material.opacity = 0.65;
    }
    material.needsUpdate = true;
}

// rawD = model-space distance between the two chords (pre-remap); it picks
// the tension tier. Display positions p0/p1 may be remapped.
function makeSegmentTube(p0, p1, rawD) {
    const d = rawD ?? p0.distanceTo(p1);
    const tier = tensionTier(d);
    const curve = new THREE.LineCurve3(p0, p1);
    const geometry = new THREE.TubeGeometry(curve, 32, BASE_TUBE_RADIUS * lineWidthFactor * tier.widthMul, 8);
    const material = new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.5 });
    styleTubeMaterial(material, d);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { p0: p0.clone(), p1: p1.clone(), rawD: d };
    return mesh;
}

// Live-update comet/path colors when the user picks another scheme
function applyCometScheme(key) {
    cometSchemeKey = key;
    applyVisualTheme();
}

// Restyle all progression visuals for the current scheme + background theme
// (called on scheme pick and from applyBgTheme)
function applyVisualTheme() {
    if (pathGroup) pathGroup.children.forEach((tube) => styleTubeMaterial(tube.material, tube.userData.rawD));
    if (trailFlow) styleFlowMaterial(trailFlow.material);
    if (cometHead) styleCometMaterial(cometHead.material);
    activeChordLabels.forEach(refreshLabelTexture);
    styleOriginMarker();
    const pointsBlending = isLightBg() ? THREE.NormalBlending : THREE.AdditiveBlending;
    activeChordClouds.forEach((cloud) => {
        if (!cloud) return;
        cloud.material.blending = pointsBlending;
        cloud.material.needsUpdate = true;
    });
    // Re-apply chord colors (theme darkening factor differs per background)
    applyChordColors();
}

function removeComet() {
    if (cometHead) {
        scene.remove(cometHead);
        cometHead = null;
    }
}

// FIX "missing lines": if a new reveal arrives while the previous segment is
// still growing, stop() used to strand that tube at a partial drawRange and
// skip its revealedPoint (short segments made this frequent). Finalize instead.
function finalizeActiveSegment() {
    if (activeSegmentTween) { activeSegmentTween.stop(); activeSegmentTween = null; }
    if (activeSegmentMeta) {
        activeSegmentMeta.tube.geometry.setDrawRange(0, Infinity);
        pushRevealedPoint(activeSegmentMeta.p1);
        activeSegmentMeta = null;
    }
    removeComet();
}

// ---- Fade-out for long pieces ----
// Chords/lines whose bar is more than fadeBars behind the current bar fade
// out over FADE_SPAN_BARS. Returns 1 (opaque) .. 0 (gone).
function getFadeFactor(idx) {
    if (fadeBars >= FADE_OFF || progression.length === 0) return 1;
    const chord = progression[idx];
    if (!chord || idx > currentIndex) return 1;
    const curBar = progression[currentIndex] ? progression[currentIndex].bar : 1;
    const age = (curBar - chord.bar) - fadeBars;
    if (age <= 0) return 1;
    return Math.max(0, 1 - age / FADE_SPAN_BARS);
}

// Reveal chord idx. When animatePath is true, grow the segment from the
// previous chord with a comet head travelling along it.
function revealChord(idx, animatePath) {
    const sphere = activeChordSpheres[idx];
    if (!sphere) return;
    sphere.visible = true;
    if (activeChordClouds[idx]) activeChordClouds[idx].visible = true;
    if (activeChordLabels[idx]) activeChordLabels[idx].visible = true;

    const p1 = new THREE.Vector3(...displayCoords(progression[idx].coords));
    if (idx === 0) {
        revealedPoints = [p1];
        rebuildTrailFlow();
        return;
    }
    const p0 = new THREE.Vector3(...displayCoords(progression[idx - 1].coords));
    // Tier from raw model distance (matches the d metric in the sidebar)
    const rawD = euclideanDistance(progression[idx - 1].coords, progression[idx].coords);

    if (!animatePath) {
        const tube0 = makeSegmentTube(p0, p1, rawD);
        tube0.userData.toIdx = idx;
        pathGroup.add(tube0);
        pushRevealedPoint(p1);
        return;
    }

    // Finalize any still-growing segment before starting the next
    finalizeActiveSegment();

    // Animated growth via index drawRange (tube indices are ordered along its length)
    const tube = makeSegmentTube(p0, p1, rawD);
    tube.userData.toIdx = idx;
    const totalIndexCount = tube.geometry.index.count;
    tube.geometry.setDrawRange(0, 0);
    pathGroup.add(tube);
    activeSegmentMeta = { tube, p1 };

    // Comet head travelling with the tip
    const cometGeo = new THREE.BufferGeometry();
    cometGeo.setAttribute('position', new THREE.Float32BufferAttribute([p0.x, p0.y, p0.z], 3));
    const cometMaterial = new THREE.PointsMaterial({
        size: 0.075,           // softer, less blown-out glow
        map: getGlowTexture(),
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true
    });
    styleCometMaterial(cometMaterial);
    cometHead = new THREE.Points(cometGeo, cometMaterial);
    scene.add(cometHead);

    const seg = new THREE.LineCurve3(p0, p1);
    const state = { f: 0 };
    // Growth never longer than the segment's own duration (short segments!)
    const segDurMs = (progression[idx].durBeats || beatsPerBar) * beatDurationMs;
    const growMs = Math.min(beatDurationMs * 2, segDurMs * 0.9);
    activeSegmentTween = new TWEEN.Tween(state)
        .to({ f: 1 }, growMs)
        .easing(TWEEN.Easing.Quadratic.InOut)
        .onUpdate(() => {
            tube.geometry.setDrawRange(0, Math.floor(totalIndexCount * state.f));
            const p = seg.getPointAt(state.f);
            cometHead.geometry.attributes.position.setXYZ(0, p.x, p.y, p.z);
            cometHead.geometry.attributes.position.needsUpdate = true;
        })
        .onComplete(() => {
            tube.geometry.setDrawRange(0, totalIndexCount);
            removeComet();
            activeSegmentTween = null;
            activeSegmentMeta = null;
            pushRevealedPoint(p1);
        })
        .start();
}

// Called when the fade slider moves: refresh the stardust window
function applyFadeSetting() {
    rebuildTrailFlow();
}

function pushRevealedPoint(p) {
    revealedPoints.push(p);
    rebuildTrailFlow();
}

// Stardust flowing along the revealed portion of the path.
// With fade-out on, the curve only covers the non-faded window.
function rebuildTrailFlow() {
    if (trailFlow) { scene.remove(trailFlow); trailFlow = null; trailCurve = null; }
    let points = revealedPoints;
    if (fadeBars < FADE_OFF) {
        let first = 0;
        while (first < revealedPoints.length - 1 && getFadeFactor(first) <= 0) first++;
        points = revealedPoints.slice(first);
    }
    if (points.length < 2) return;

    trailCurve = new THREE.CatmullRomCurve3(points);
    const flowCount = Math.min(RENDER_CFG.trailFlowCount, points.length * 12);
    const flowGeometry = new THREE.BufferGeometry();
    flowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flowCount * 3), 3));
    const flowMaterial = new THREE.PointsMaterial({
        size: 0.04,
        map: getGlowTexture(),
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true
    });
    styleFlowMaterial(flowMaterial);
    trailFlow = new THREE.Points(flowGeometry, flowMaterial);
    scene.add(trailFlow);
}

// Hide everything and reveal only the current chord (used on restart / loop wrap)
function resetReveal() {
    activeChordSpheres.forEach(s => { s.visible = false; });
    activeChordClouds.forEach(c => { if (c) c.visible = false; });
    activeChordLabels.forEach(l => { l.visible = false; });
    if (pathGroup) {
        pathGroup.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
        pathGroup.clear();
    }
    removeComet();
    if (activeSegmentTween) { activeSegmentTween.stop(); activeSegmentTween = null; }
    activeSegmentMeta = null;
    if (trailFlow) { scene.remove(trailFlow); trailFlow = null; trailCurve = null; }
    revealedPoints = [];
    revealChord(currentIndex, false);
}

// Rebuild objects and reveal instantly up to currentIndex
// (called on load and manual jumps from the chord list)
function renderProgression() {
    clearProgressionObjects();
    if (progression.length === 0) return;
    buildProgressionObjects();
    for (let i = 0; i <= currentIndex; i++) {
        revealChord(i, false);
    }
}

// Per-frame: move stardust along the revealed path
function updateTrailFlow(t) {
    if (!trailFlow || !trailCurve) return;
    const attr = trailFlow.geometry.attributes.position;
    const n = attr.count;
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
        const u = (i / n + t * 0.03) % 1;
        trailCurve.getPointAt(u, v);
        attr.setXYZ(
            i,
            v.x + Math.sin(t * 1.3 + i) * 0.012,
            v.y + Math.cos(t * 1.1 + i * 2) * 0.012,
            v.z + Math.sin(t * 0.9 + i * 3) * 0.012
        );
    }
    attr.needsUpdate = true;
}

function euclideanDistance(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
