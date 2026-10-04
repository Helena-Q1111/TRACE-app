// ========== PARTICLE UTILITIES (textures + chord particle clouds) ==========

// Soft radial glow sprite texture (shared by stars / halos / clouds)
let _glowTexture = null;
function getGlowTexture() {
    if (_glowTexture) return _glowTexture;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    _glowTexture = new THREE.CanvasTexture(canvas);
    return _glowTexture;
}

// Cloudy nebula texture: layered offset radial gradients for wispiness
function makeNebulaTexture(hexColor) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const c = new THREE.Color(hexColor);
    const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    for (let i = 0; i < 14; i++) {
        const x = size / 2 + (Math.random() - 0.5) * size * 0.5;
        const y = size / 2 + (Math.random() - 0.5) * size * 0.5;
        const r = size * (0.12 + Math.random() * 0.3);
        const a = 0.05 + Math.random() * 0.1;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${rgb},${a})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;   // canvas pixels are sRGB (see sceneColor)
    return texture;
}

// Random point in a spherical shell [rMin, rMax]
function randomInShell(rMin, rMax) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = rMin + Math.random() * (rMax - rMin);
    return [
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
    ];
}

// Particle cloud swirling around one chord position.
// Returns THREE.Points centered at `position`, self-rotating in updateChordClouds().
function createChordCloud(position, colorHex, radius, count, baseSize) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const [x, y, z] = randomInShell(radius * 0.25, radius);
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
        color: colorHex,
        size: baseSize,
        map: getGlowTexture(),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: bgThemeKey === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
        toneMapped: false,     // colorHex arrives already linear (getSceneChordColor)
        sizeAttenuation: true
    });

    const points = new THREE.Points(geometry, material);
    points.position.set(...position);
    points.userData.spin = {
        axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        speed: 0.15 + Math.random() * 0.25,
        phase: Math.random() * Math.PI * 2
    };
    return points;
}

// Per-frame animation of active chord particle clouds (swirl + pulse)
function updateChordClouds(t) {
    activeChordClouds.forEach((cloud, idx) => {
        if (!cloud) return;
        const s = cloud.userData.spin;
        cloud.rotateOnAxis(s.axis, s.speed * 0.016);
        const fade = (typeof getFadeFactor === 'function') ? getFadeFactor(idx) : 1;
        if (idx === currentIndex) {
            // Bigger breathing pulse for the current chord
            const pulse = 1.4 + 0.25 * Math.sin(t * 2.2 + s.phase);
            cloud.scale.setScalar(pulse);
            cloud.material.opacity = 0.7;
        } else {
            cloud.scale.setScalar(1.0);
            // Off-key chords keep a denser, brighter halo
            const boost = (progression[idx] && progression[idx].offKey) ? 1.6 : 1.0;
            cloud.material.opacity =
                Math.min(0.55, Math.max(0.08, 0.3 - Math.abs(currentIndex - idx) * 0.05) * boost) * fade;
        }
    });
}
