// ========== THREE.JS SCENE, CAMERA, RENDERER, POST-PROCESSING ==========

function initScene() {
    const container = document.getElementById('canvas');
    scene = new THREE.Scene();
    scene.background = sceneColor(BG_THEMES.dark.bg);
    // Linear distance fog. Only the contents of the latent space take it; the
    // sky opts out in cosmos.js (see FOG_NEAR / FOG_FAR in config.js).
    scene.fog = new THREE.Fog(sceneColor(BG_THEMES.dark.bg), FOG_NEAR, FOG_FAR);

    // Before any progression loads, look at the tonic (I) reference beacon
    tonicDisplayPos = new THREE.Vector3(...displayCoords(TONIC_I_COORDS));
    followTarget = tonicDisplayPos.clone();
    camSpherical = new THREE.Spherical().setFromVector3(new THREE.Vector3(0, 0, CAMERA_START_RADIUS));
    lightTarget = tonicDisplayPos.clone();

    camera = new THREE.PerspectiveCamera(
        60,  // Reduced FOV for more zoom-out effect
        container.clientWidth / container.clientHeight,
        0.1,
        1000
    );
    camera.position.copy(tonicDisplayPos).add(new THREE.Vector3(0, 0, CAMERA_START_RADIUS));

    // preserveDrawingBuffer: video export reads the canvas via captureStream;
    // without it the buffer is cleared after composite and recordings go black
    renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_CFG.maxPixelRatio));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER_CFG.exposure;
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    // Post-processing: render pass + Unreal bloom (cosmic glow)
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        RENDER_CFG.bloom.strength,
        RENDER_CFG.bloom.radius,
        RENDER_CFG.bloom.threshold
    );
    composer.addPass(bloomPass);
    // The scene is already tone-mapped when it is rendered into the composer's
    // target (r128 applies toneMapping to render targets too). The bloom pass
    // then copies to screen through a MeshBasicMaterial, which tone-maps a
    // SECOND time - ACES twice lifts mid-tones and bleaches colour. The copy
    // only has to sRGB-encode.
    bloomPass.basic.toneMapped = false;
    setupSelectiveBloom(container.clientWidth, container.clientHeight);

    // Log GPU context loss explicitly (helps diagnose "particles vanished")
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.warn('WebGL context lost - reload the app');
    });

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    lightFollower = new THREE.PointLight(0xffffff, 1.2);
    scene.add(lightFollower);

    // OrbitControls-like manual camera control
    setupCameraControls();

    // Handle resize (window + sidebar collapse/stretch)
    window.addEventListener('resize', onWindowResize);
    if (window.ResizeObserver) {
        new ResizeObserver(() => onWindowResize()).observe(container);
    }

    // Mouse interaction listeners
    renderer.domElement.addEventListener('mousedown', () => {
        mouseInteracting = true;
    });
    renderer.domElement.addEventListener('mouseup', () => {
        setTimeout(() => {
            mouseInteracting = false;
        }, 500);
    });
}

// Orbit controls around followTarget using spherical coordinates.
// Radius only changes on wheel zoom -> no drift; camera always tracks the target.
function setupCameraControls() {
    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };

    renderer.domElement.addEventListener('mousedown', (e) => {
        isDragging = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;

        camSpherical.theta -= deltaX * 0.005;
        camSpherical.phi -= deltaY * 0.005;
        camSpherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, camSpherical.phi));

        previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener('mouseup', () => {
        isDragging = false;
    });

    renderer.domElement.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomSpeed = 0.1;
        const direction = e.deltaY > 0 ? 1 : -1;
        camSpherical.radius = Math.max(CAMERA_MIN_RADIUS,
            Math.min(cameraMaxRadius, camSpherical.radius * (1 + direction * zoomSpeed)));
    }, { passive: false });
}

// Snap light follower to the current chord (used on load / restart / manual jump)
function snapLightToCurrent() {
    if (progression.length === 0) return;
    lightFollower.position.copy(chordScenePos(currentIndex));
    lightTarget.copy(lightFollower.position);
    lightInitialized = true;
}

// Per-frame camera update: smooth-follow the light (current chord), orbit around it
const _camOffset = new THREE.Vector3();
let tonicDisplayPos = null;   // set in initScene; idle camera target
function updateCamera() {
    // The experimental views (views.js) orbit a fixed point - I, or the
    // playhead on the tunnel's home axis - instead of chasing the chord.
    const viewTarget = viewCameraTarget();
    if (viewTarget) {
        followTarget.lerp(viewTarget, viewMode === 'tunnel' ? 0.12 : 0.05);
    } else {
        const desired = (progression.length > 0 && lightInitialized)
            ? lightFollower.position
            : tonicDisplayPos;
        followTarget.lerp(desired, 0.018);
    }

    // The I-centred views hold still so their orientation (C ahead) stays readable.
    if (!mouseInteracting && !viewTarget) {
        camSpherical.theta += 0.00012;
    }

    _camOffset.setFromSpherical(camSpherical);
    camera.position.copy(followTarget).add(_camOffset);
    camera.lookAt(followTarget);
    // The renderer refreshes camera.matrixWorldInverse only inside render(),
    // but the HUD (landmark dots, labels, chevrons) projects points with it
    // BEFORE that - so without this it drew with last frame's view. Any
    // rotation then showed each landmark twice, the 3D ball and its 2D marker
    // one frame apart, which read as a doubled I and ghosting on every
    // landmark.
    camera.updateMatrixWorld();
}

function onWindowResize() {
    const container = document.getElementById('canvas');
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    bloomSource.setSize(w * pr, h * pr);
}

// ---- Selective bloom ----
// UnrealBloomPass extracts its bright areas from the frame it is handed and
// adds the blurred result back onto that same frame. Only the FIRST step is
// redirected here: the bright-area filter reads a second render that contains
// just the BLOOM_LAYER objects, while the blur, the composite and the final
// copy to screen are untouched - so tone mapping and colour encoding go through
// exactly the path they always did, and nothing outside the layer changes.
//
// The bloom render also leaves the lights out (they live on layer 0), so a
// sphere contributes only its EMISSIVE colour. That is what makes a chord's
// halo its own hue: the lit render's white specular highlight was the part
// that used to clip, and a clipped halo is white.
let bloomSource = null;

function setupSelectiveBloom(w, h) {
    const pr = renderer.getPixelRatio();
    bloomSource = new THREE.WebGLRenderTarget(w * pr, h * pr, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat
    });
    // The pass assigns readBuffer.texture to tDiffuse every frame; this
    // uniform ignores that and always serves the layer-only render. The
    // material shares this uniforms object, so replacing the entry is enough.
    bloomPass.highPassUniforms.tDiffuse = {
        get value() { return bloomSource.texture; },
        set value(_) { /* keep the bloom-layer source */ }
    };
}

// One frame: the bloom-layer render first (skipped when bloom is off, as on
// the paper theme - strength 0 already zeroes its contribution), then the
// composer exactly as before.
function renderFrame() {
    if (bloomPass.strength > 0) {
        const mask = camera.layers.mask;
        const bg = scene.background;
        camera.layers.set(BLOOM_LAYER);
        scene.background = null;             // clear to black: only the layer counts
        renderer.setRenderTarget(bloomSource);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        scene.background = bg;
        camera.layers.mask = mask;
    }
    composer.render();
}
