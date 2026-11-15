// ========== VIEW LAYOUTS (experimental) ==========
// Candidate ways of placing the same chords, kept side by side so they can be
// judged on real music before any is kept:
//
//   original  the current view: sinh-remapped latent coordinates, camera
//             flying with the music, icosahedral boundary
//   space     I-centred, with a morph slider between two ends
//               0 = the LEARNED space, untouched except for a rigid move: I at
//                   the origin, the plane in which the model put the 12 roots
//                   laid flat, and "away from I" pointing up. Seen like this
//                   the roots go round I in circle-of-fifths order (10 of 12
//                   neighbours are a fifth apart) but unevenly, and most chords
//                   sit above I - a bowl.
//               1 = the IDEALISED well: every chord keeps its true distance
//                   from I, but its direction is set by theory - root on an
//                   evenly spaced circle of fifths, a small offset per quality
//                   so one root's family does not stack, and a fixed climb of
//                   29 degrees (the learned chords' median) so distance from I
//                   reads as height up a funnel.
//   tunnel    the idealised cross-section (angle = root on the circle of
//             fifths, radius = distance from I) swept along time: the music is
//             a ribbon winding round the home axis, and the camera glides
//             along it at the tempo.
//
// All but `original` use raw latent distances (no sinh remap), VIEW_UNIT
// display units per latent unit, so 1 ring = 1 latent unit everywhere.

let viewMode = 'original';
let viewMorph = 0;
let viewFrame = null;          // the learned frame around I, see computeViewFrame
let viewGuides = null;         // { bowl, well, tunnel } line groups

const VIEW_UNIT = 0.5;
const VIEW_CONE = THREE.MathUtils.degToRad(29);
const VIEW_RING_R = 11;                    // latent units: reach of the C-direction arrow
const VIEW_SHELLS = [3, 6, 9];             // latent units from I
const VIEW_FRONT_DEG = -90;                // C's direction in the plane: -z, straight ahead
const TUNNEL_BEAT = 0.35;                  // display units per beat along the time axis
const VIEW_CAMERA = {
    original: { radius: CAMERA_START_RADIUS, phi: Math.PI / 2, theta: 0 },
    space:    { radius: 12, phi: 1.1, theta: 0 },      // behind I, so C points away from the viewer
    // theta = pi: the camera stands on the FUTURE side looking back, so the
    // current chord is nearest and the trail recedes behind it like a wake;
    // from the past side every chord just played swept through the lens
    tunnel:   { radius: 7, phi: 1.2, theta: Math.PI }
};
const VIEW_QUALITY_GROUP = {
    major: 'maj', maj7: 'maj', minor: 'min', min7: 'min', minMaj7: 'min', dominant7: 'dom',
    dim: 'dim', dim7: 'dim', m7b5: 'dim', sus2: 'sus', sus4: 'sus', dom7sus4: 'sus', dom7sus2: 'sus', aug: 'aug'
};
const VIEW_QUALITY_OFFSET = { maj: -7, min: 7, dom: 0, dim: 14, sus: -14, aug: 0 };   // degrees
const _fifths = (pc) => (7 * pc) % 12;

// ---- The learned frame around I ----
// Same procedure as the offline analysis: for each root, the mean direction
// (from I) of its 14 root-position qualities; the plane holding those 12
// directions (PCA) becomes horizontal; its normal, oriented to the side most
// chords lie on, becomes "up". Then where the evenly spaced ideal circle of
// fifths should sit so it lines up best with the learned one.
function computeViewFrame() {
    const key = (r, b, pcs) => embeddingKeyString({ root: r, bass: b, pcs: [...new Set(pcs)].sort((x, y) => x - y) });
    const Iarr = embeddingTable[key(0, 0, [0, 4, 7])];
    if (!Iarr) return null;
    const I = new THREE.Vector3(...Iarr);
    const offsets = [];
    const meanDir = [];
    for (let r = 0; r < 12; r++) {
        const acc = new THREE.Vector3();
        CORE_QUALITIES.forEach((q) => {
            const c = embeddingTable[key(r, r, CORE_TONES[q.quality].map(iv => (r + iv) % 12))];
            if (!c) return;
            const v = new THREE.Vector3(...c).sub(I);
            offsets.push(v);
            if (v.length() > 1e-6) acc.add(v.clone().normalize());
        });
        meanDir.push(acc.normalize());
    }
    const mean = meanDir.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(12);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    meanDir.forEach((v) => {
        const d = [v.x - mean.x, v.y - mean.y, v.z - mean.z];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
    });
    const eig = eigenSym3(C);
    const ax = new THREE.Vector3(...eig[0].vector);
    let az = new THREE.Vector3(...eig[1].vector);
    const up = new THREE.Vector3(...eig[2].vector);
    if (offsets.reduce((s, v) => s + v.dot(up), 0) < 0) up.negate();

    // Orientation within the plane - display conventions only, no distance
    // changes. The PCA axes are arbitrary, so:
    //  1. mirror if needed so the fifths run clockwise seen from above
    //     (C -> G -> D like the radar and a clock face). Mirroring is an
    //     isometry too; the latent space has no meaningful handedness.
    //  2. rotate so C points to -z: straight ahead from the default camera,
    //     and 12 o'clock in the top view.
    const angOf = (d) => THREE.MathUtils.radToDeg(Math.atan2(d.dot(az), d.dot(ax)));
    if (Math.sin(THREE.MathUtils.degToRad(angOf(meanDir[7]) - angOf(meanDir[0]))) < 0) az.negate();
    const rot = THREE.MathUtils.degToRad(VIEW_FRONT_DEG - angOf(meanDir[0]));
    const ax2 = ax.clone().multiplyScalar(Math.cos(rot)).addScaledVector(az, -Math.sin(rot));
    const az2 = ax.clone().multiplyScalar(Math.sin(rot)).addScaledVector(az, Math.cos(rot));
    const toFrame = (v) => new THREE.Vector3(v.dot(ax2), v.dot(up), v.dot(az2));
    // The idealised ring puts C exactly where the learned one does.
    return { I, ax: ax2, up, az: az2, sgn: 1, offDeg: VIEW_FRONT_DEG, learnedDir: meanDir.map(toFrame), toFrame };
}

// Symmetric 3x3 eigen-decomposition (Jacobi), eigenvalues descending.
function eigenSym3(A) {
    const a = A.map(r => r.slice());
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        if (a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2 < 1e-20) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(a[p][q]) < 1e-15) continue;
            const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = V[k][p], vkq = V[k][q];
                V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
            }
        }
    }
    return [0, 1, 2]
        .map(i => ({ value: a[i][i], vector: [V[0][i], V[1][i], V[2][i]] }))
        .sort((x, y) => y.value - x.value);
}

// ---- Positions ----
function idealAngle(framePc, group) {
    const f = viewFrame;
    return THREE.MathUtils.degToRad(f.offDeg + f.sgn * (30 * _fifths(framePc) + (VIEW_QUALITY_OFFSET[group] || 0)));
}
function learnedPoint(coords) {
    return viewFrame.toFrame(new THREE.Vector3(...coords).sub(viewFrame.I)).multiplyScalar(VIEW_UNIT);
}
function idealPoint(coords, framePc, group) {
    const d = new THREE.Vector3(...coords).distanceTo(viewFrame.I);
    const th = idealAngle(framePc, group);
    return new THREE.Vector3(
        d * Math.cos(VIEW_CONE) * Math.cos(th), d * Math.sin(VIEW_CONE), d * Math.cos(VIEW_CONE) * Math.sin(th)
    ).multiplyScalar(VIEW_UNIT);
}
function spacePoint(coords, framePc, group) {
    return learnedPoint(coords).lerp(idealPoint(coords, framePc, group), viewMorph);
}
function tunnelPoint(coords, framePc, group, beat) {
    const d = new THREE.Vector3(...coords).distanceTo(viewFrame.I);
    const th = idealAngle(framePc, group);
    // -sin: C (at -90 deg) comes out at the top of the tunnel
    return new THREE.Vector3(d * Math.cos(th) * VIEW_UNIT, -d * Math.sin(th) * VIEW_UNIT, -beat * TUNNEL_BEAT);
}
function chordStartBeat(c) { return ((c.bar || 1) - 1) * beatsPerBar + (c.beatInBar || 0); }
function chordFramePc(c) { return transposedChordKey(c.root, c.bass, c.pcs, c.bar).root; }
function viewActive() { return viewMode !== 'original' && !!viewFrame; }

// Where chord `idx` of the progression sits in the current view. In the
// original view this is exactly the old displayCoords() placement.
function chordScenePos(idx) {
    const c = progression[idx];
    if (!c) return new THREE.Vector3();
    if (!viewActive()) return new THREE.Vector3(...displayCoords(c.coords));
    const pc = chordFramePc(c), g = VIEW_QUALITY_GROUP[c.quality] || 'maj';
    return viewMode === 'tunnel' ? tunnelPoint(c.coords, pc, g, chordStartBeat(c)) : spacePoint(c.coords, pc, g);
}

// The point the camera orbits: null = the original follow-the-chord logic.
function playheadBeat() {
    const c = progression[currentIndex];
    if (!c) return 0;
    const into = isPlaying ? Math.min(c.durBeats || beatsPerBar, (Date.now() - lastBeatTime) / beatDurationMs) : 0;
    return chordStartBeat(c) + into;
}
function viewCameraTarget() {
    if (!viewActive()) return null;
    if (viewMode === 'tunnel') return new THREE.Vector3(0, 0, -playheadBeat() * TUNNEL_BEAT);
    // a little above I: most chords sit above it, so this centres the bowl/funnel
    return new THREE.Vector3(0, 5 * Math.sin(VIEW_CONE) * VIEW_UNIT, 0);
}
// Home, for the tether: I itself, or the point of the home axis level with the chord.
function viewHomeFor(pos) {
    if (!viewActive()) return null;
    return viewMode === 'tunnel' ? new THREE.Vector3(0, 0, pos.z) : new THREE.Vector3(0, 0, 0);
}

// ---- Guides: shells (learned), funnel rings (ideal), tunnel walls ----
function guideMaterial(opacity) {
    return new THREE.LineBasicMaterial({
        color: sceneColor(anchorColors().hull), transparent: true, opacity, depthWrite: false, toneMapped: false
    });
}
function circlePoints(radius, map, n = 96) {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push(map(Math.cos(a) * radius, Math.sin(a) * radius)); }
    return new THREE.BufferGeometry().setFromPoints(pts);
}
function buildViewGuides() {
    if (viewGuides) Object.values(viewGuides).forEach((g) => { scene.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); });
    const U = VIEW_UNIT;
    // learned: distance rings in the plane the roots lie in (full spheres,
    // drawn as great circles, turned the view into a cage of ellipses)
    const bowl = new THREE.Group();
    VIEW_SHELLS.forEach((d) => {
        bowl.add(new THREE.Line(circlePoints(d * U, (x, y) => new THREE.Vector3(x, 0, y)), guideMaterial(0.32)));
    });
    // ideal: rings of equal distance on the funnel, and the 12 fifths rays
    const well = new THREE.Group();
    [...VIEW_SHELLS, 12].forEach((d) => {
        const r = d * Math.cos(VIEW_CONE) * U, h = d * Math.sin(VIEW_CONE) * U;
        well.add(new THREE.Line(circlePoints(r, (x, y) => new THREE.Vector3(x, h, y)), guideMaterial(0.3)));
    });
    for (let pc = 0; pc < 12; pc++) {
        const th = idealAngle(pc, 'dom'), R = 12 * U;
        const end = new THREE.Vector3(R * Math.cos(VIEW_CONE) * Math.cos(th), R * Math.sin(VIEW_CONE), R * Math.cos(VIEW_CONE) * Math.sin(th));
        well.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]), guideMaterial(0.12)));
    }
    // tunnel: the home axis and a set of rings every bar
    const tunnel = new THREE.Group();
    const lastBeat = progression.length
        ? chordStartBeat(progression[progression.length - 1]) + (progression[progression.length - 1].durBeats || beatsPerBar)
        : 16 * beatsPerBar;
    tunnel.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 4), new THREE.Vector3(0, 0, -lastBeat * TUNNEL_BEAT - 4)]), guideMaterial(0.45)));
    // one ring per bar at distance 6, the full 3-6-9 set every 4 bars: three
    // rings every bar stacked into a moire wall
    for (let bar = 0, b = 0; b <= lastBeat; bar++, b += beatsPerBar) {
        const shells = bar % 4 === 0 ? VIEW_SHELLS : [6];
        shells.forEach((d) => {
            const ring = new THREE.Line(circlePoints(d * U, (x, y) => new THREE.Vector3(x, y, -b * TUNNEL_BEAT), 64),
                guideMaterial(bar % 4 === 0 ? 0.16 : 0.07));
            ring.userData.z = -b * TUNNEL_BEAT;
            tunnel.add(ring);
        });
    }
    // C's direction, drawn in the plane through I: a ray with an arrowhead and
    // a single "C" label, so "which way is C" is readable in either space view.
    // (The per-note ring that used to sit around the space is gone: twelve
    // labels lighting up with every chord was the busiest thing on screen.)
    const front = new THREE.Group();
    const reach = VIEW_RING_R * U;
    front.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -reach)]), guideMaterial(0.55)));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 12),
        new THREE.MeshBasicMaterial({ color: sceneColor(0x7d96e8), transparent: true, opacity: 0.8, toneMapped: false }));
    head.rotation.x = -Math.PI / 2;           // cone tip from +y to -z
    head.position.set(0, 0, -reach - 0.14);
    front.add(head);
    const cLabel = makeLabelSprite('C', true);
    cLabel.position.set(0, 0.22, -reach - 0.45);
    front.add(cLabel);
    viewGuides = { bowl, well, tunnel, front };
    Object.values(viewGuides).forEach(g => scene.add(g));
    styleViewGuides();
}
function styleViewGuides() {
    if (!viewGuides) return;
    const col = sceneColor(anchorColors().hull);
    const light = isLightBg();
    const set = (g, k) => g.children.forEach((l) => {
        if (l.userData.base === undefined) l.userData.base = l.material.opacity;
        l.material.color.copy(col);
        l.material.opacity = l.userData.base * k * (light ? 1.6 : 1);
        l.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        l.material.needsUpdate = true;
    });
    const space = viewMode === 'space' && !!viewFrame;
    viewGuides.bowl.visible = space && viewMorph < 0.98;
    viewGuides.well.visible = space && viewMorph > 0.02;
    viewGuides.tunnel.visible = viewMode === 'tunnel' && !!viewFrame;
    viewGuides.front.visible = space;
    refreshLabelTexture(viewGuides.front.children[2]);      // theme-dependent ink
    viewGuides.front.children[0].material.color.copy(sceneColor(0x7d96e8));
    set(viewGuides.bowl, 1 - viewMorph);
    set(viewGuides.well, viewMorph);
    set(viewGuides.tunnel, 1);
}


// ---- Landmarks follow the view (hidden in the tunnel: they have no time) ----
function repositionLandmarks() {
    if (!landmarkNodes.length) return;
    landmarkNodes.forEach((n) => {
        let p;
        if (!viewActive()) p = new THREE.Vector3(...displayCoords(n.coords));
        else if (viewMode === 'tunnel') return;
        else p = spacePoint(n.coords, n.root, VIEW_QUALITY_GROUP[n.quality] || 'maj');
        n.pos.copy(p);
        n.mesh.position.copy(p);
        if (n.degree === 'I' && tonicStars) tonicStars.position.copy(p);
    });
}
function applyViewVisibility() {
    const orig = !viewActive();
    if (hullLines) hullLines.visible = anchorsVisible && orig;
    if (hullSkin) hullSkin.visible = anchorsVisible && orig;
    if (landmarkGroup) landmarkGroup.visible = anchorsVisible && viewMode !== 'tunnel';
    if (tonicStars) tonicStars.visible = anchorsVisible && viewMode !== 'tunnel';
    styleViewGuides();
}

// Called after every progression (re)build, so new music and view switches
// both land here.
function onProgressionRendered() {
    if (!viewFrame) return;
    if (viewMode === 'tunnel') buildViewGuides();
    repositionLandmarks();
    applyViewVisibility();
}

// ---- Switching ----
function setView(mode, morph) {
    if (mode !== 'original' && !viewFrame) return;      // table not loaded yet
    const changedMode = mode !== viewMode;
    viewMode = mode;
    if (morph !== undefined) viewMorph = morph;
    if (changedMode) {
        const cam = VIEW_CAMERA[mode];
        camSpherical.set(cam.radius, cam.phi, cam.theta);
        if (mode === 'tunnel' || !viewGuides) buildViewGuides();
    }
    renderProgression();                  // rebuilds spheres, lines, labels at the new places
    snapLightToCurrent();
    repositionLandmarks();
    applyViewVisibility();
    if (changedMode) {
        const t = viewCameraTarget();
        followTarget.copy(t || lightFollower.position);
    }
    syncViewBar();
}

function syncViewBar() {
    const active = viewMode === 'original' ? 'original' : viewMode === 'tunnel' ? 'tunnel'
        : viewMorph < 0.5 ? 'bowl' : 'well';
    document.querySelectorAll('#viewBar [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === active));
    const morph = document.getElementById('viewMorphWrap');
    if (morph) morph.hidden = viewMode !== 'space';
    const slider = document.getElementById('viewMorph');
    if (slider) slider.value = String(Math.round(viewMorph * 100));
    const top = document.getElementById('viewTop');
    if (top) top.hidden = viewMode !== 'space';
}

function bindViewBar() {
    document.querySelectorAll('#viewBar [data-view]').forEach((btn) => {
        btn.onclick = () => {
            const v = btn.dataset.view;
            if (v === 'original') setView('original');
            else if (v === 'tunnel') setView('tunnel');
            else setView('space', v === 'bowl' ? 0 : 1);
        };
    });
    const slider = document.getElementById('viewMorph');
    let pending = false;
    slider.oninput = () => {
        viewMorph = slider.value / 100;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; setView('space', viewMorph); });
    };
    document.getElementById('viewTop').onclick = () => {
        camSpherical.phi = 0.02;          // looking straight down: the well becomes the 2D target
        mouseInteracting = false;
    };
}

function initViews() {
    viewFrame = computeViewFrame();
    if (!viewFrame) { console.warn('views: embedding table missing the I chord'); return; }
    buildViewGuides();
    applyViewVisibility();
    bindViewBar();
    syncViewBar();
    const ang = viewFrame.learnedDir.map(d => THREE.MathUtils.radToDeg(Math.atan2(d.z, d.x)));
    const order = [...Array(12).keys()].sort((a, b) => ang[a] - ang[b]).map(pc => PITCH_NAMES[pc]);
    console.log(`views: learned ring order ${order.join(' ')}`);
}

// Tunnel walls exist only around the playhead and fade with distance behind
// it; drawn end to end, every ring converged on the vanishing point as a
// whirlpool. TUNNEL_WAKE is how far back (display units) they stay visible.
const TUNNEL_WAKE = 8;
function updateTunnelWalls() {
    if (!viewGuides || viewMode !== 'tunnel') return;
    const z0 = followTarget.z;
    viewGuides.tunnel.children.forEach((l) => {
        if (l.userData.z === undefined) return;          // the home axis
        const back = l.userData.z - z0;                  // > 0: already played
        const on = back > -1.5 && back < TUNNEL_WAKE;
        l.visible = on;
        if (on) l.material.opacity = l.userData.base * (1 - Math.max(0, back) / TUNNEL_WAKE);
    });
}

function updateViews() {
    updateTunnelWalls();
}
