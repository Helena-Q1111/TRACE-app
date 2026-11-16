// ========== SPATIAL ANCHORS: BOUNDARY, LANDMARKS, HEADS-UP REFERENCE ==========
// The scene used to be a single beacon in an open starfield, which reads as
// endless - once the camera follows a chord away from the tonic there is
// nothing left to judge position against. Three layers fix that:
//
//   1. a boundary shell   the convex hull of the plain chord vocabulary, so the
//                         space has walls and a readable size
//   2. diatonic landmarks I ii iii IV V vi vii, sized and lit by tonal weight,
//                         so the interior has named fixed points
//   3. a heads-up layer   projected labels, off-screen direction chevrons and a
//                         tether home, so at least one anchor is on screen no
//                         matter where the camera is
//
// Geometry comes from data/latent_space.json (scripts/export_latent_space.py).
// It is expressed in the C-normalised latent frame, so it is a property of the
// model and never moves when the song or its key changes.

let latentSpace = null;
let anchorsVisible = true;

let landmarkGroup = null;      // beacons + their glows
let landmarkNodes = [];        // [{degree, weight, pos:Vector3, mesh, glow}]
let tonicStars = null;         // the orbiting shell, tonic only
let hullLines = null;          // boundary wireframe
let hullSkin = null;           // back-face-only translucent wall
let cageInradius = 0;          // display units from the tonic to a wall
let cageTicks = [];            // the 12 corners + their distance in model units
let tetherLine = null;         // current chord -> tonic
let hudCanvas = null, hudCtx = null;

// Beacon geometry as a function of tonal weight: I and the two dominants
// larger, vii smallest. Kept in the same size range as the progression spheres
// (0.08, 0.12 when current) - at up to 0.245 the landmarks out-shouted the
// music they are only meant to anchor. What separates a landmark from a chord
// now is that it is flat (unlit), translucent and always there.
const BEACON_MIN_R = 0.05 * SCENE_SCALE, BEACON_MAX_R = 0.12 * SCENE_SCALE;
const GLOW_MIN = 0.85, GLOW_MAX = 1.0;

// A landmark is a degree of the (relative-major) key the embedding is built in,
// so it takes the colour a chord of that degree gets under the active scheme:
// T/S/D in the function scheme, major/minor/diminished in the quality one.
// `root` is the interval above the tonic; with no bar, chordFunction measures
// from estimatedTonic, so adding it back makes the function come out by degree.
function landmarkQuality(degree) {
    if (degree.includes('°')) return 'dim';
    return degree === degree.toUpperCase() ? 'major' : 'minor';
}
//
// Except I. Home has to be findable at a glance from anywhere in the space,
// so it keeps only a hint of its scheme colour on the dark theme and is
// otherwise white, with a brighter white glow and a place in the bloom layer;
// on paper it goes near-black instead. Returned in display (sRGB) space.
const TONIC_WHITE_MIX = 0.72;
function landmarkColor(n) {
    const c = getThemedChordColor({ root: (estimatedTonic + n.root) % 12, quality: n.quality });
    if (n.degree !== 'I') return c;
    return isLightBg() ? c.lerp(new THREE.Color(0x14141f), 0.7)
                       : c.lerp(new THREE.Color(0xffffff), TONIC_WHITE_MIX);
}

function anchorColors() {
    return isLightBg()
        ? { ink: '#14141f', dim: 'rgba(30,30,48,0.62)', faint: 'rgba(40,40,64,0.34)',
            hull: 0x5a5a78, tether: 'rgba(40,40,70,0.5)' }
        : { ink: '#e6e9f7', dim: 'rgba(196,204,232,0.66)', faint: 'rgba(150,160,200,0.36)',
            hull: 0x8894c4, tether: 'rgba(170,182,224,0.45)' };
}

// ---------------------------------------------------------------------- setup
async function initLandmarks() {
    hudCanvas = document.getElementById('anchorCanvas');
    if (hudCanvas) hudCtx = hudCanvas.getContext('2d');
    resizeAnchorHud();
    window.addEventListener('resize', resizeAnchorHud);

    try {
        latentSpace = window.traceAPI
            ? await window.traceAPI.readJSON('latent_space.json')
            : await (await fetch('data/latent_space.json')).json();
    } catch (e) {
        console.error('Failed to load latent_space.json:', e);
        return;
    }
    buildLandmarks();
    buildCage();
    buildTether();
    styleLandmarks();
    console.log(`Loaded latent space: ${latentSpace.extremes.length} extreme chords, `
        + `${latentSpace.landmarks.length} landmarks`);
}

function buildLandmarks() {
    landmarkGroup = new THREE.Group();
    scene.add(landmarkGroup);

    latentSpace.landmarks.forEach((lm) => {
        const pos = new THREE.Vector3(...displayCoords(lm.coords));
        const w = lm.weight;
        const radius = BEACON_MIN_R + (BEACON_MAX_R - BEACON_MIN_R) * w;

        // MeshBasicMaterial: unlit, so a landmark reads the same from any
        // angle. Not in the bloom layer - its only halo is the faint sprite.
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 24, 24),
            new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false })
        );
        mesh.position.copy(pos);
        if (lm.degree === 'I') mesh.layers.enable(BLOOM_LAYER);   // home glows
        landmarkGroup.add(mesh);

        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: getGlowTexture(),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false
        }));
        const g = GLOW_MIN + (GLOW_MAX - GLOW_MIN) * w;
        const gs = g * (lm.degree === 'I' ? 2.4 : 1.3) * SCENE_SCALE * (0.45 + 0.55 * w);
        glow.scale.set(gs, gs, 1);
        mesh.add(glow);

        landmarkNodes.push({ degree: lm.degree, root: lm.root, quality: landmarkQuality(lm.degree),
            weight: w, r: lm.r, coords: lm.coords, pos, mesh, glow });

        // Only the tonic keeps the orbiting star shell - it is what marks it as
        // home rather than just another labelled point.
        if (lm.degree === 'I') {
            const count = 56;
            const positions = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const [x, y, z] = randomInShell(0.4 * SCENE_SCALE, 1.0 * SCENE_SCALE);
                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            tonicStars = new THREE.Points(geo, new THREE.PointsMaterial({
                color: 0xdde4ff, size: 0.055 * SCENE_SCALE, map: getGlowTexture(),
                transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false,
                blending: THREE.AdditiveBlending, sizeAttenuation: true
            }));
            tonicStars.position.copy(pos);
            scene.add(tonicStars);
        }
    });
}

// The boundary: a REGULAR icosahedron centred on the tonic, sized so that its
// INRADIUS reaches the most remote chord in the vocabulary. Its corners are not
// chords - a hull of the chord cloud was, and that is exactly why it failed:
// the music sits right up against such a hull, so any zoom put the camera
// outside it. A regular solid trades "every corner is a real chord" for an
// arena you can actually move around inside.
//
// Two objects, because a wireframe alone does not read as a wall from inside:
// the edges give the cage its shape, and a back-face-only translucent skin
// gives the far side a faint surface to sit against. BackSide means the near
// wall never washes over the music between you and it.
function buildCage() {
    const centre = new THREE.Vector3(...displayCoords(latentSpace.tonic));

    // Furthest chord measured in DISPLAY space - the remap is radial about the
    // origin, not the tonic, so this has to be measured after remapping rather
    // than read off a latent radius.
    let reach = 0;
    for (const v of latentSpace.extremes) {
        reach = Math.max(reach, centre.distanceTo(new THREE.Vector3(...displayCoords(v))));
    }
    cageInradius = reach * CAGE_MARGIN;
    const circumradius = cageInradius / ICOSA_INRADIUS_RATIO;

    const geo = new THREE.IcosahedronGeometry(circumradius, 0);

    hullLines = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
    );
    hullLines.position.copy(centre);
    scene.add(hullLines);

    hullSkin = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, side: THREE.BackSide, toneMapped: false
    }));
    hullSkin.position.copy(centre);
    scene.add(hullSkin);

    // The 12 corners, with each one's distance from the tonic read back in
    // MODEL units so the ticks match the sidebar's d/t metrics.
    const pos = geo.attributes.position;
    const seen = new Set();
    cageTicks = [];
    for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        const id = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const world = v.clone().add(centre);
        const latent = inverseDisplayCoords(world.toArray());
        cageTicks.push({
            pos: world,
            r: Math.hypot(latent[0] - latentSpace.tonic[0],
                          latent[1] - latentSpace.tonic[1],
                          latent[2] - latentSpace.tonic[2])
        });
    }

    // Keep the wheel from taking the camera out through the wall. The orbit
    // centre is a chord, which can itself sit far from the tonic, so leave a
    // healthy fraction rather than the full inradius.
    cameraMaxRadius = Math.max(20, cageInradius * 0.55);
    console.log(`Boundary: regular icosahedron, inradius ${cageInradius.toFixed(1)} `
        + `(furthest chord ${reach.toFixed(1)}), circumradius ${circumradius.toFixed(1)}; `
        + `max zoom ${cameraMaxRadius.toFixed(0)}`);
}

// A permanent thin line from the current chord back to the tonic: whatever the
// camera is doing, the direction and distance home stay on screen.
function buildTether() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    tetherLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
        transparent: true, depthWrite: false, toneMapped: false
    }));
    tetherLine.frustumCulled = false;
    scene.add(tetherLine);
}

function styleLandmarks() {
    const c = anchorColors();
    const light = isLightBg();
    landmarkNodes.forEach((n) => {
        const isHome = n.degree === 'I';
        n.color = landmarkColor(n);
        n.css = '#' + n.color.getHexString();   // the HUD marker uses it too (sRGB)
        n.sceneColor = n.color.clone().convertSRGBToLinear();
        n.mesh.material.color.copy(n.sceneColor);
        // On paper-white there is no glow, and a translucent dot just turns
        // pale - so weight is carried almost entirely by size there, and
        // opacity stays near solid.
        n.baseOpacity = isHome ? 0.95
            : light ? 0.78 + 0.22 * n.weight : 0.45 + 0.40 * n.weight;
        n.mesh.material.opacity = n.baseOpacity * (n.reveal ?? 1);
        // Additive glow does nothing on white, and the falloff texture under
        // normal blending only lands ~5% ink - not worth the draw. On paper the
        // HUD's marker dot is what makes a landmark findable instead.
        n.glow.visible = !light;
        n.glow.material.color.copy(n.sceneColor);
        n.baseGlow = isHome ? 0.55 : 0.10 + 0.20 * n.weight;
        n.glow.material.opacity = n.baseGlow * (n.reveal ?? 1);
    });
    if (tonicStars) {
        const tonic = landmarkNodes.find(n => n.degree === 'I');
        if (tonic) tonicStars.material.color.copy(tonic.sceneColor);
        tonicStars.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        tonicStars.material.opacity = light ? 0.55 : 0.4;
        tonicStars.material.needsUpdate = true;
    }
    if (hullLines) {
        hullLines.material.color.copy(sceneColor(c.hull));
        // a thin grey line on white carries far less than an additive one on black
        hullLines.material.opacity = light ? 0.50 : 0.24;
        hullLines.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        hullLines.material.needsUpdate = true;
    }
    if (hullSkin) {
        hullSkin.material.color.copy(sceneColor(c.hull));
        // Barely there. Additive blending over a near-black sky makes this go a
        // long way: at 0.028 the facets read as solid grey panels and the scene
        // turns into the inside of a polyhedron rather than open space.
        hullSkin.material.opacity = light ? 0.055 : 0.012;
        hullSkin.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        hullSkin.material.needsUpdate = true;
    }
    if (tetherLine) {
        tetherLine.material.color.copy(sceneColor(c.hull));
        tetherLine.material.opacity = light ? 0.45 : 0.22;
        tetherLine.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
        tetherLine.material.needsUpdate = true;
    }
}

function setAnchorsVisible(on) {
    anchorsVisible = !!on;
    if (landmarkGroup) landmarkGroup.visible = on;
    if (tonicStars) tonicStars.visible = on;
    if (hullLines) hullLines.visible = on;
    if (hullSkin) hullSkin.visible = on;
    if (tetherLine) tetherLine.visible = on;
    if (hudCanvas) hudCanvas.hidden = !on;
    applyViewVisibility();       // views.js: the cage only belongs to the original view
}

// ------------------------------------------------------------------ per frame
function resizeAnchorHud() {
    if (!hudCanvas) return;
    const container = document.getElementById('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    hudCanvas.width = Math.round(container.clientWidth * dpr);
    hudCanvas.height = Math.round(container.clientHeight * dpr);
    hudCanvas.style.width = container.clientWidth + 'px';
    hudCanvas.style.height = container.clientHeight + 'px';
    hudCanvas._dpr = dpr;
}

const _proj = new THREE.Vector3();

// Project a world point to CSS pixels. `behind` is true when the point is
// outside the frustum along the view direction, where the NDC x/y flip sign
// and have to be mirrored before they mean anything.
function projectPoint(v, w, h) {
    _proj.copy(v).project(camera);
    const behind = _proj.z > 1;
    let x = _proj.x, y = _proj.y;
    if (behind) { x = -x; y = -y; }
    return {
        x: (x * 0.5 + 0.5) * w,
        y: (-y * 0.5 + 0.5) * h,
        behind,
        onScreen: !behind && Math.abs(_proj.x) <= 1 && Math.abs(_proj.y) <= 1
    };
}

// ---- Landmarks appear as the music reaches them ----
// All seven at once read as chords waiting to be connected before the piece
// had played them. Home (I) is always there; every other degree fades in the
// first time a chord on that degree sounds (by C-frame root and quality
// family, so V7 or V/inversion counts for V), and stays.
const LANDMARK_FADE_MS = 500;
let landmarkRevealKey = '';
function landmarkFamily(q) {
    const g = QUALITY_GROUP[q] || 'major';
    return g === 'dominant' ? 'major' : g === 'altered' ? (q === 'aug' ? 'aug' : 'dim') : g;
}
function updateLandmarkReveal() {
    const key = progression.length ? `${progression.length}:${progression[0].coords}:${currentIndex}` : '';
    if (key !== landmarkRevealKey) {
        landmarkRevealKey = key;
        const reached = new Set(['0:major']);
        for (let i = 0; i <= currentIndex && i < progression.length; i++) {
            const c = progression[i];
            reached.add(`${chordFramePc(c)}:${landmarkFamily(c.quality)}`);
        }
        const now = performance.now();
        landmarkNodes.forEach((n) => {
            const on = reached.has(`${n.root}:${n.quality}`);
            if (on && !n.reachedAt) n.reachedAt = now;
            if (!on) n.reachedAt = 0;
        });
    }
    const now = performance.now();
    landmarkNodes.forEach((n) => {
        const r = n.reachedAt ? Math.min(1, (now - n.reachedAt) / LANDMARK_FADE_MS) : 0;
        if (r === n.reveal) return;
        n.reveal = r;
        n.mesh.visible = r > 0;
        n.mesh.material.opacity = (n.baseOpacity ?? 1) * r;
        n.glow.material.opacity = (n.baseGlow ?? 0) * r;
    });
}

function updateLandmarks(t) {
    updateLandmarkReveal();
    if (tonicStars) {
        tonicStars.rotation.y = t * 0.12;
        tonicStars.rotation.x = Math.sin(t * 0.07) * 0.35;
    }
    if (!anchorsVisible) return;
    updateTether();
    drawAnchorHud();
}

function updateTether() {
    if (!tetherLine || !landmarkNodes.length || progression.length === 0) return;
    const chord = progression[currentIndex];
    if (!chord) return;
    const from = chordScenePos(currentIndex).toArray();
    const home = viewHomeFor(new THREE.Vector3(...from)) || landmarkNodes[0].pos;   // I is exported first
    const attr = tetherLine.geometry.attributes.position;
    attr.setXYZ(0, from[0], from[1], from[2]);
    attr.setXYZ(1, home.x, home.y, home.z);
    attr.needsUpdate = true;
}

// The overlay panels, as exclusion boxes in the HUD's own coordinates. Hidden
// panels contribute nothing, so turning the autoencoder panel off immediately
// frees that corner up for anchors again.
function panelRects(w, h) {
    const host = document.getElementById('canvas');
    if (!host) return [];
    const base = host.getBoundingClientRect();
    const out = [];
    ['circleCanvas', 'movePanel', 'aePanel', 'viewBar'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        out.push({
            x: r.left - base.left + r.width / 2,
            y: r.top - base.top + r.height / 2,
            halfW: r.width / 2 + 6,
            halfH: r.height / 2 + 6
        });
    });
    return out;
}

// The heads-up layer. Labels are drawn at a constant pixel size rather than as
// world-space sprites, so a landmark stays legible whether the camera is 3 or
// 120 units away; anything off screen becomes an edge chevron pointing at it.
function drawAnchorHud() {
    if (!hudCtx || !latentSpace) return;
    const dpr = hudCanvas._dpr;
    const w = hudCanvas.width / dpr, h = hudCanvas.height / dpr;
    hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hudCtx.clearRect(0, 0, w, h);

    const c = anchorColors();
    const margin = 26;
    const cx = w / 2, cy = h / 2;

    // Drawn labels, so a later one can stand down rather than overprint an
    // earlier one. Landmarks are visited in weight order, so when two collide
    // it is always the less important degree that yields.
    // Seeded with the overlay panels: chevrons naturally pile up on the right
    // edge, which is exactly where the radar and the autoencoder panel live.
    const placed = panelRects(w, h);
    const fits = (x, y, halfW, halfH) => {
        for (const b of placed) {
            if (Math.abs(x - b.x) < halfW + b.halfW && Math.abs(y - b.y) < halfH + b.halfH) return false;
        }
        return true;
    };
    const claim = (x, y, halfW, halfH) => placed.push({ x, y, halfW, halfH });

    // --- boundary ticks: distance from the tonic, read off the shell itself ---
    hudCtx.font = '500 9px "IBM Plex Mono", Consolas, monospace';
    hudCtx.textAlign = 'center';
    hudCtx.textBaseline = 'middle';
    if (!viewActive()) cageTicks.forEach((tick) => {
        const p = projectPoint(tick.pos, w, h);
        if (!p.onScreen) return;
        hudCtx.fillStyle = c.faint;
        hudCtx.beginPath();
        hudCtx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        hudCtx.fill();
        const label = tick.r.toFixed(1);
        if (fits(p.x, p.y - 9, 12, 7)) {
            hudCtx.fillText(label, p.x, p.y - 9);
            claim(p.x, p.y - 9, 12, 7);
        }
    });

    // --- landmarks: on-screen label, or an edge chevron pointing off-screen ---
    if (viewMode !== 'tunnel') landmarkNodes.forEach((n) => {
        if (!n.reveal) { n.labelAt = null; return; }      // not reached yet
        const p = projectPoint(n.pos, w, h);
        const alpha = (0.45 + 0.55 * n.weight) * n.reveal;
        const size = 9 + 4 * n.weight;

        if (p.onScreen) {
            // A crisp marker dot at a constant pixel size. The 3D sphere is
            // only a few pixels across at any sane camera distance, and on the
            // paper theme it has neither bloom nor glow behind it, so this dot
            // is what actually locates a landmark. Radius carries the weight.
            const dot = 1.8 + 3.2 * n.weight;
            hudCtx.globalAlpha = alpha;
            hudCtx.fillStyle = n.css || c.ink;
            hudCtx.beginPath();
            hudCtx.arc(p.x, p.y, dot, 0, Math.PI * 2);
            hudCtx.fill();
            hudCtx.globalAlpha = 1;

            const ly = p.y - 14 - 4 * n.weight;
            const halfW = 4 + n.degree.length * size * 0.32;
            if (!fits(p.x, ly, halfW, size * 0.7)) return;
            claim(p.x, ly, halfW, size * 0.7);
            hudCtx.font = `${n.weight > 0.7 ? 600 : 500} ${size}px "IBM Plex Mono", Consolas, monospace`;
            hudCtx.textAlign = 'center';
            hudCtx.textBaseline = 'middle';
            hudCtx.globalAlpha = alpha;
            hudCtx.fillStyle = c.ink;
            hudCtx.fillText(n.degree, p.x, ly);
            hudCtx.globalAlpha = 1;
            n.labelAt = { x: p.x, y: ly };
            return;
        }
        n.labelAt = null;

        // Off screen: clamp the direction to the viewport edge and draw a
        // chevron there, so home is never more than a glance away.
        const dx = p.x - cx, dy = p.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const tx = (w / 2 - margin) / Math.max(1e-6, Math.abs(ux));
        const ty = (h / 2 - margin) / Math.max(1e-6, Math.abs(uy));
        const s = Math.min(tx, ty);

        // Slide the whole marker inward until it clears the panels and the
        // markers already placed - chevron and label move together, so the
        // arrow never ends up hidden under the autoencoder panel with its
        // label stranded somewhere else. Weight order means the least
        // important degree is the one that gets dropped if nothing fits.
        const fs = size - 1;
        const halfW = 4 + n.degree.length * fs * 0.32;
        const halfH = fs * 0.7;
        let ex = cx + ux * s, ey = cy + uy * s;
        let ok = false;
        for (let step = 0; step < 40; step++) {
            const lx = ex - ux * 13, ly = ey - uy * 13;
            if (fits(ex, ey, 8, 8) && fits(lx, ly, halfW, halfH)) { ok = true; break; }
            ex -= ux * 14;
            ey -= uy * 14;
            if (Math.hypot(ex - cx, ey - cy) < 40) break;   // gave up near the middle
        }
        if (!ok) { hudCtx.globalAlpha = 1; return; }
        const lx = ex - ux * 13, ly = ey - uy * 13;

        hudCtx.globalAlpha = alpha * 0.75;
        hudCtx.fillStyle = n.css || c.dim;
        hudCtx.save();
        hudCtx.translate(ex, ey);
        hudCtx.rotate(Math.atan2(uy, ux));
        const a = 4 + 2.5 * n.weight;
        hudCtx.beginPath();
        hudCtx.moveTo(a, 0);
        hudCtx.lineTo(-a * 0.8, a * 0.75);
        hudCtx.lineTo(-a * 0.8, -a * 0.75);
        hudCtx.closePath();
        hudCtx.fill();
        hudCtx.restore();
        claim(ex, ey, 8, 8);
        claim(lx, ly, halfW, halfH);
        hudCtx.font = `500 ${fs}px "IBM Plex Mono", Consolas, monospace`;
        hudCtx.textAlign = 'center';
        hudCtx.textBaseline = 'middle';
        hudCtx.fillStyle = c.dim;
        hudCtx.fillText(n.degree, lx, ly);
        hudCtx.globalAlpha = 1;
    });

    // --- distance home, printed once next to the tonic's marker or chevron ---
    if (viewMode !== 'tunnel' && progression.length > 0 && progression[currentIndex] && landmarkNodes.length) {
        const d = euclideanDistance(progression[currentIndex].coords, latentSpace.tonic);
        const home = landmarkNodes[0];
        const p = projectPoint(home.pos, w, h);
        // Sit just under whatever marks home on screen right now - its label if
        // it got drawn, otherwise the clamped edge position of its chevron.
        const at = home.labelAt
            ? { x: home.labelAt.x, y: home.labelAt.y - 12 }
            : {
                x: Math.max(margin, Math.min(w - margin, p.x)),
                y: Math.max(margin, Math.min(h - margin, p.y)) + 22
            };
        const txt = `${d.toFixed(1)} from I`;
        if (fits(at.x, at.y, 26, 6)) {
            hudCtx.font = '500 9px "IBM Plex Mono", Consolas, monospace';
            hudCtx.textAlign = 'center';
            hudCtx.textBaseline = 'middle';
            hudCtx.fillStyle = c.faint;
            hudCtx.fillText(txt, at.x, at.y);
        }
    }
}
