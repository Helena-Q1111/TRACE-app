// ========== THREE.JS SCENE, CAMERA, RENDERER, POST-PROCESSING ==========

function initScene() {
    const container = document.getElementById('canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030308);

    // Before any progression loads, look at the tonic (I) reference beacon
    tonicDisplayPos = new THREE.Vector3(...displayCoords(TONIC_I_COORDS));
    followTarget = tonicDisplayPos.clone();
    camSpherical = new THREE.Spherical().setFromVector3(new THREE.Vector3(0, 0, 34));
    lightTarget = tonicDisplayPos.clone();

    camera = new THREE.PerspectiveCamera(
        60,  // Reduced FOV for more zoom-out effect
        container.clientWidth / container.clientHeight,
        0.1,
        1000
    );
    camera.position.copy(tonicDisplayPos).add(new THREE.Vector3(0, 0, 34));

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
        camSpherical.radius = Math.max(0.5, Math.min(150, camSpherical.radius * (1 + direction * zoomSpeed)));
    }, { passive: false });
}

// Snap light follower to the current chord (used on load / restart / manual jump)
function snapLightToCurrent() {
    if (progression.length === 0) return;
    const chord = progression[currentIndex];
    lightFollower.position.set(...displayCoords(chord.coords));
    lightTarget.copy(lightFollower.position);
    lightInitialized = true;
}

// Per-frame camera update: smooth-follow the light (current chord), orbit around it
const _camOffset = new THREE.Vector3();
let tonicDisplayPos = null;   // set in initScene; idle camera target
function updateCamera() {
    const desired = (progression.length > 0 && lightInitialized)
        ? lightFollower.position
        : tonicDisplayPos;
    followTarget.lerp(desired, 0.018);

    if (!mouseInteracting) {
        camSpherical.theta += 0.00012;
    }

    _camOffset.setFromSpherical(camSpherical);
    camera.position.copy(followTarget).add(_camOffset);
    camera.lookAt(followTarget);
}

function onWindowResize() {
    const container = document.getElementById('canvas');
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
}
