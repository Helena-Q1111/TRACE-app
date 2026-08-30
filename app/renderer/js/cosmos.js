// ========== COSMIC BACKGROUND (star field, nebulae, dust) ==========
// Buffers are allocated ONCE at max budget; the density knob and theme switch
// reuse them via drawRange / material updates (no reallocation).

const cosmos = {
    starLayers: [],
    nebulae: [],
    dust: null
};

// Two precomputed palettes per star: bright (dark bg) and dark (light bg)
function makeStarColors(count) {
    const bright = new Float32Array(count * 3);
    const dark = new Float32Array(count * 3);
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
        const roll = Math.random();
        if (roll < 0.65) tint.setHSL(0, 0, 0.9 + Math.random() * 0.1);
        else if (roll < 0.85) tint.setHSL(0.6, 0.5, 0.8);
        else tint.setHSL(0.08, 0.5, 0.8);
        bright[i * 3] = tint.r; bright[i * 3 + 1] = tint.g; bright[i * 3 + 2] = tint.b;
        // Dark palette: near-black blue-gray dots for the light theme
        tint.setHSL(0.62, 0.14, 0.06 + Math.random() * 0.1);
        dark[i * 3] = tint.r; dark[i * 3 + 1] = tint.g; dark[i * 3 + 2] = tint.b;
    }
    return { bright, dark };
}

function initCosmos() {
    const theme = getBgTheme();

    // --- Multi-layer star field ---
    RENDER_CFG.starLayers.forEach((cfg, li) => {
        const positions = new Float32Array(cfg.count * 3);
        for (let i = 0; i < cfg.count; i++) {
            const [x, y, z] = randomInShell(cfg.rMin, cfg.rMax);
            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;
        }
        const palettes = makeStarColors(cfg.count);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(palettes.bright, 3));

        const material = new THREE.PointsMaterial({
            size: cfg.size,
            map: getGlowTexture(),
            vertexColors: true,
            transparent: true,
            opacity: cfg.opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: true,
            fog: false          // the sky is backdrop, not depth
        });

        const stars = new THREE.Points(geometry, material);
        stars.userData = {
            baseOpacity: cfg.opacity,
            twinkleSpeed: cfg.twinkleSpeed,
            phase: li * 2.1,
            rotSpeed: 0.002 + li * 0.0015,
            rotAxis: new THREE.Vector3(0.2 * li, 1, 0.3).normalize(),
            maxCount: cfg.count,
            palettes: palettes
        };
        scene.add(stars);
        cosmos.starLayers.push(stars);
    });

    // --- Distant nebulae (soft additive sprites, dark theme only) ---
    for (let i = 0; i < RENDER_CFG.nebulaCount; i++) {
        const color = RENDER_CFG.nebulaColors[i % RENDER_CFG.nebulaColors.length];
        const material = new THREE.SpriteMaterial({
            map: makeNebulaTexture(color),
            transparent: true,
            opacity: 0.07 + Math.random() * 0.07,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            rotation: Math.random() * Math.PI * 2,
            fog: false          // sky, not depth
        });
        const sprite = new THREE.Sprite(material);
        const [x, y, z] = randomInShell(110, 210);
        sprite.position.set(x, y, z);
        const s = 76 + Math.random() * 100;
        sprite.scale.set(s, s, 1);
        sprite.userData = {
            rotSpeed: (Math.random() - 0.5) * 0.02,
            baseOpacity: material.opacity,
            phase: Math.random() * Math.PI * 2
        };
        scene.add(sprite);
        cosmos.nebulae.push(sprite);
    }

    // --- Cosmic dust around the chord constellation ---
    const dustPositions = new Float32Array(RENDER_CFG.dustCount * 3);
    for (let i = 0; i < RENDER_CFG.dustCount; i++) {
        const [x, y, z] = randomInShell(0.3, 3.2);
        dustPositions[i * 3] = x;
        dustPositions[i * 3 + 1] = y;
        dustPositions[i * 3 + 2] = z;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
        color: theme.dustColor,
        size: 0.02,
        map: getGlowTexture(),
        transparent: true,
        opacity: theme.dustOpacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });
    cosmos.dust = new THREE.Points(dustGeometry, dustMaterial);
    cosmos.dust.userData.maxCount = RENDER_CFG.dustCount;
    scene.add(cosmos.dust);

    applyBgTheme(bgThemeKey);
    applyStarDensity(starDensity);
}

// Density knob: current budget is the max; only drawRange changes.
// The light theme shows fewer dots than dark at the same knob position.
function applyStarDensity(density) {
    starDensity = Math.max(0.05, Math.min(1, density));
    const themeScale = bgThemeKey === 'light' ? 0.8 : 1.0;
    const effective = starDensity * themeScale;
    cosmos.starLayers.forEach((stars) => {
        stars.geometry.setDrawRange(0, Math.floor(stars.userData.maxCount * effective));
    });
    if (cosmos.dust) {
        cosmos.dust.geometry.setDrawRange(0, Math.floor(cosmos.dust.userData.maxCount * effective));
    }
}

// Switch background theme: scene bg, star palette/blending, nebulae, dust, bloom
function applyBgTheme(key) {
    bgThemeKey = key;
    const theme = getBgTheme();

    scene.background = new THREE.Color(theme.bg);
    if (scene.fog) scene.fog.color.setHex(theme.bg);   // fog must match the sky

    cosmos.starLayers.forEach((stars) => {
        const u = stars.userData;
        const palette = theme.starPalette === 'dark' ? u.palettes.dark : u.palettes.bright;
        stars.geometry.attributes.color.array.set(palette);
        stars.geometry.attributes.color.needsUpdate = true;
        stars.material.blending = theme.starAdditive ? THREE.AdditiveBlending : THREE.NormalBlending;
        stars.material.needsUpdate = true;
        u.opacityScale = theme.starOpacityScale;
    });

    cosmos.nebulae.forEach((sprite) => { sprite.visible = theme.nebulaVisible; });

    if (cosmos.dust) {
        cosmos.dust.material.color.setHex(theme.dustColor);
        cosmos.dust.material.blending = theme.starAdditive ? THREE.AdditiveBlending : THREE.NormalBlending;
        cosmos.dust.material.opacity = theme.dustOpacity;
        cosmos.dust.material.needsUpdate = true;
    }

    if (bloomPass) bloomPass.strength = theme.bloomStrength;

    document.body.classList.toggle('theme-light', key === 'light');

    // Re-apply density (light theme shows fewer dots) and restyle progression visuals
    applyStarDensity(starDensity);
    if (typeof applyVisualTheme === 'function') applyVisualTheme();
}

// Per-frame: slow parallax rotation + twinkle + nebula drift
function updateCosmos(t) {
    cosmos.starLayers.forEach((stars) => {
        const u = stars.userData;
        stars.rotateOnAxis(u.rotAxis, u.rotSpeed * 0.016);
        stars.material.opacity = u.baseOpacity * (u.opacityScale || 1)
            * (0.82 + 0.18 * Math.sin(t * u.twinkleSpeed + u.phase));
    });
    cosmos.nebulae.forEach((sprite) => {
        if (!sprite.visible) return;
        const u = sprite.userData;
        sprite.material.rotation += u.rotSpeed * 0.016;
        sprite.material.opacity = u.baseOpacity * (0.8 + 0.2 * Math.sin(t * 0.3 + u.phase));
    });
    if (cosmos.dust) {
        cosmos.dust.rotation.y = t * 0.01;
    }
}
