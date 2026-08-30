// ========== CHORD TABLE + PROGRESSION RENDERING ==========
// Progressive reveal: chords appear as playback reaches them; each transition
// draws an animated growing path segment (with a comet head) from the previous
// chord to the current one. Looping back to bar 1 resets the journey.

let pathGroup = null;       // accumulated revealed path segments
let activeSegmentTween = null;
let activeSegmentMeta = null;   // {tube, p1} of the currently growing segment
let cometHead = null;       // bright meteor head
let cometTail = null;       // the streak trailing behind it

// The transition reads as a meteor: a bright head with a tapering streak behind
// it, flying from the previous chord to the new one. What it LEAVES is
// unchanged - the tube grows to exactly the head's position, so the meteor
// appears to draw the permanent line and then hands it over.
// The streak rides on top of the line it is drawing, so it can only read as a
// meteor if it is clearly FATTER and LONGER than that line: the tube is
// 0.0033 world units thick, the grains are ~25x that, giving a glowing sheath
// around a hairline. Grain size must also exceed the spacing (tail length /
// points) or the trail breaks up into dots.
const METEOR_TAIL_POINTS = 64;
const METEOR_TAIL_FRACTION = 0.3;    // of the segment length
const METEOR_TAIL_MAX = 11 * SCENE_SCALE;
const METEOR_TAIL_FALLOFF = 1.15;    // higher = shorter-looking streak
let revealedPoints = [];    // Vector3s of revealed chords (drives trail stardust)
let trailFlow = null;       // stardust flowing along the revealed path
let trailCurve = null;
let activeChordLabels = []; // roman-numeral sprites above progression chords

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

const LABEL_HEIGHT = 0.7 * SCENE_SCALE;
function makeLabelSprite(text, dim) {
    const { texture, aspect } = makeLabelTexture(text, dim);
    const material = new THREE.SpriteMaterial({
        map: texture, transparent: true, depthWrite: false, depthTest: false,
        fog: false   // labels are UI: they read at any depth or not at all
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
    initLandmarks().then(applyVisualTheme);
    applyVisualTheme();
}

// The tonic beacon, the other diatonic landmarks, the boundary shell and the
// heads-up anchors all live in landmarks.js now.

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

// The recognizer already emits the exact lookup tone set (core tones + the
// confirmed tensions + the bass), so the lookup only has to transpose it into
// the C-based frame the embeddings live in (in A major, shift +3).
// Returns {root, bass, pcs} in that frame - also what aeviz.js encodes to
// rebuild the 15D model input, so both go through one definition.
function transposedChordKey(root, bass, pcs, bar) {
    const shift = transposeShiftForKey(keyAtBar(bar));
    const r = (root + shift) % 12;
    const b = ((bass ?? root) + shift) % 12;
    const set = new Set(pcs.map(pc => (pc + shift) % 12));
    set.add(r);
    set.add(b);
    return { root: r, bass: b, pcs: [...set].sort((x, y) => x - y) };
}

function embeddingKeyString(k) {
    return `${k.root}:${k.bass}:[${k.pcs.join(', ')}]`;
}

// The table is exhaustive over (root, bass, pcs), so the first lookup always
// hits; the root-position fallback only guards against a truncated table.
function lookupEmbedding(root, bass, pcs, bar) {
    const k = transposedChordKey(root, bass, pcs, bar);
    let coords = embeddingTable[embeddingKeyString(k)];
    if (!coords && k.bass !== k.root) {
        coords = embeddingTable[embeddingKeyString({ ...k, bass: k.root })];
    }
    if (!coords) console.warn(`Embedding not found: ${embeddingKeyString(k)}`);
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
        const quality = seg.quality;
        const adjusted = { ...seg, quality, bass: seg.bass ?? seg.root };
        const key = keyAtBar(seg.bar);
        return {
            bar: seg.bar,
            beatInBar: seg.beatInBar,
            durBeats: seg.durBeats,
            root: seg.root,
            bass: seg.bass ?? seg.root,
            quality: quality,
            tensions: seg.tensions || [],
            pcs: seg.pcs,
            soundingPcs: seg.soundingPcs || seg.pcs,
            // 3D sprite label: core quality only, tensions would not fit
            label: romanLabel(adjusted, key, false),
            // sidebar: the full reading, tension figures included
            labelFull: romanLabel(adjusted, key, true),
            absLabel: getChordLabel(adjusted),
            coords: lookupEmbedding(seg.root, seg.bass, seg.pcs, seg.bar),
            // off-key is judged on what actually rang, not on a filled-in 5th
            offKey: isOffKey(seg.soundingPcs || seg.pcs, seg.bar)
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
        const geometry = new THREE.SphereGeometry(0.08 * SCENE_SCALE, 32, 32);
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
        const cloudRadius = (chord.offKey ? 0.34 : 0.26) * SCENE_SCALE;
        const cloudSize = (chord.offKey ? 0.048 : 0.038) * SCENE_SCALE;
        const cloud = createChordCloud(pos, color.getHex(), cloudRadius, RENDER_CFG.cloudPerChord, cloudSize);
        cloud.visible = false;
        scene.add(cloud);
        activeChordClouds.push(cloud);

        const tag = makeLabelSprite(chord.label, false);
        tag.position.set(pos[0], pos[1] + 0.55 * SCENE_SCALE, pos[2]);
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

const _tierTint = new THREE.Color();

function styleTubeMaterial(material, rawD) {
    const scheme = getCometScheme();
    const tier = tensionTier(rawD ?? 4);
    // Blend the tier's hue over the scheme's tube colour: the palette still
    // sets the overall look, the tier says how far the harmony jumped.
    material.color.setHex(scheme.tube).lerp(_tierTint.setHex(tier.tint), tier.tintMix);
    material.emissive.setHex(scheme.tubeEmissive).lerp(_tierTint, tier.tintMix * 0.8);
    if (isLightBg()) {
        material.color.multiplyScalar(0.45);
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
    if (cometTail) styleCometMaterial(cometTail.material);
    activeChordLabels.forEach(refreshLabelTexture);
    styleLandmarks();
    const pointsBlending = isLightBg() ? THREE.NormalBlending : THREE.AdditiveBlending;
    activeChordClouds.forEach((cloud) => {
        if (!cloud) return;
        cloud.material.blending = pointsBlending;
        cloud.material.needsUpdate = true;
    });
    // Re-apply chord colors (theme darkening factor differs per background)
    applyChordColors();
}

// Head + streak. Two objects because PointsMaterial has one size for the whole
// buffer: the head needs to be visibly larger than the grains behind it, and
// the taper itself rides on per-vertex colour (which multiplies the material's
// scheme colour, so the vertices carry brightness only).
function buildMeteor(p0) {
    removeComet();

    const headGeo = new THREE.BufferGeometry();
    headGeo.setAttribute('position', new THREE.Float32BufferAttribute([p0.x, p0.y, p0.z], 3));
    const headMat = new THREE.PointsMaterial({
        size: 0.19 * SCENE_SCALE,
        map: getGlowTexture(),
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true
    });
    styleCometMaterial(headMat);
    cometHead = new THREE.Points(headGeo, headMat);
    cometHead.frustumCulled = false;
    scene.add(cometHead);

    const n = METEOR_TAIL_POINTS;
    const tailGeo = new THREE.BufferGeometry();
    tailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    tailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const tailMat = new THREE.PointsMaterial({
        size: 0.26 * SCENE_SCALE,
        map: getGlowTexture(),
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
        vertexColors: true
    });
    styleCometMaterial(tailMat);
    cometTail = new THREE.Points(tailGeo, tailMat);
    cometTail.frustumCulled = false;
    scene.add(cometTail);
}

function updateMeteor(seg, segLen, f) {
    if (!cometHead || !cometTail) return;

    const head = seg.getPointAt(f);
    cometHead.geometry.attributes.position.setXYZ(0, head.x, head.y, head.z);
    cometHead.geometry.attributes.position.needsUpdate = true;

    // Tail length is a fraction of the flight, capped so a long leap does not
    // trail a streak halfway across the space.
    const tailLen = Math.min(segLen * METEOR_TAIL_FRACTION, METEOR_TAIL_MAX);
    const span = segLen > 1e-6 ? tailLen / segLen : 0;
    const pos = cometTail.geometry.attributes.position;
    const col = cometTail.geometry.attributes.color;
    const n = METEOR_TAIL_POINTS;
    const launch = Math.min(1, f / 0.08);        // no streak before it sets off
    for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const p = seg.getPointAt(Math.max(0, f - span * k));
        pos.setXYZ(i, p.x, p.y, p.z);
        const b = Math.pow(1 - k, METEOR_TAIL_FALLOFF) * launch;
        col.setXYZ(i, b, b, b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
}

function removeComet() {
    if (cometHead) {
        scene.remove(cometHead);
        cometHead.geometry.dispose();
        cometHead.material.dispose();
        cometHead = null;
    }
    if (cometTail) {
        scene.remove(cometTail);
        cometTail.geometry.dispose();
        cometTail.material.dispose();
        cometTail = null;
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

    buildMeteor(p0);

    const seg = new THREE.LineCurve3(p0, p1);
    const segLen = p0.distanceTo(p1);
    const state = { f: 0 };
    // Growth never longer than the segment's own duration (short segments!)
    const segDurMs = (progression[idx].durBeats || beatsPerBar) * beatDurationMs;
    const growMs = Math.min(beatDurationMs * 2, segDurMs * 0.9);
    activeSegmentTween = new TWEEN.Tween(state)
        .to({ f: 1 }, growMs)
        .easing(TWEEN.Easing.Quadratic.InOut)
        .onUpdate(() => {
            tube.geometry.setDrawRange(0, Math.floor(totalIndexCount * state.f));
            updateMeteor(seg, segLen, state.f);
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
        size: 0.04 * SCENE_SCALE,
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
        const j = 0.012 * SCENE_SCALE;
        attr.setXYZ(
            i,
            v.x + Math.sin(t * 1.3 + i) * j,
            v.y + Math.cos(t * 1.1 + i * 2) * j,
            v.z + Math.sin(t * 0.9 + i * 3) * j
        );
    }
    attr.needsUpdate = true;
}

function euclideanDistance(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
