import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { CONFIG } from './config.js';
import { createScene } from './scene.js';
import { createPlayerSystem } from './player.js';
import { createWeaponSystem } from './weapons.js';
import { createZombieSystem } from './zombies.js';
import { createHUD } from './hud.js';

// ======================================================
// INICIALIZACIÓN GENERAL
// ======================================================

console.log('========== OPERACIÓN EXTRACCIÓN ==========');
console.log('[MAIN] Iniciando sistemas...');

const container = document.getElementById('game-container');

if (!container) {
    throw new Error('[MAIN] No se encontró #game-container');
}

let extractionOpen = false;
let introShown = false;

// ======================================================
// ESCENARIO 3D
// ======================================================

console.log('[MAIN] Creando escenario 3D...');

const world = createScene(container);

if (
    !world ||
    !world.scene ||
    !world.camera ||
    !world.renderer ||
    !world.ready
) {
    throw new Error(
        '[MAIN] createScene() no devolvió los elementos necesarios.'
    );
}

const {
    scene,
    camera,
    renderer,
    collidesWithWorld
} = world;

if (camera.parent !== scene) {
    scene.add(camera);
}

// Si la construcción del laboratorio falla, se muestra el error real
// en consola en lugar de detener el programa en silencio.
try {
    await world.ready;
    console.log('[MAIN] Laboratorio construido.');
} catch (error) {
    console.error(
        '[MAIN] Falló la construcción del laboratorio. ' +
        'Revisa que scene.js tenga todas las inserciones:',
        error
    );
}

console.log('[MAIN] Puntos de aparición de zombis:', world.zombieSpawns.length);

// Avisos si algún módulo está desactualizado.
if (typeof world.collectMedkitAt !== 'function') {
    console.warn('[MAIN] scene.js no exporta collectMedkitAt: botiquines desactivados.');
}

if (typeof world.collectAmmoAt !== 'function') {
    console.warn('[MAIN] scene.js no exporta collectAmmoAt: munición desactivada.');
}

if (typeof world.resetPickups !== 'function') {
    console.warn('[MAIN] scene.js no exporta resetPickups: los objetos no se restablecerán por ronda.');
}

// ======================================================
// CONTROLES
// ======================================================

const controls = new PointerLockControls(
    camera,
    document.body
);

// ======================================================
// CARGADOR GLTF
// ======================================================

const loader = new GLTFLoader();

loader.setMeshoptDecoder(MeshoptDecoder);

// ======================================================
// VARIABLES GENERALES
// ======================================================

const clock = new THREE.Clock();

const movementSpeed = 6;

const keys = {
    forward: false,
    backward: false,
    left: false,
    right: false
};

let gameOver = false;
let won = false;

// ======================================================
// HUD
// ======================================================

const hud = createHUD(container);

// Mensaje grande temporal; no falla si hud.js es una versión antigua.
function banner(text, color, duration) {
    if (typeof hud.showBanner === 'function') {
        hud.showBanner(text, color, duration);
    }
}

// ======================================================
// JUGADOR
// ======================================================

console.log('[MAIN] Inicializando jugador...');

const playerSystem = createPlayerSystem({
    scene,
    camera,
    controls,
    loader,
    keys
});

const player = playerSystem.player;

// ======================================================
// SISTEMA DE DAÑO
// ======================================================

function damagePlayer(amount) {
    if (!player.alive || gameOver || won) {
        return;
    }

    player.health = Math.max(
        0,
        player.health - amount
    );

    hud.updateHealth(player);

    console.log('[MAIN] Vida del jugador:', player.health);

    if (player.health <= 0) {
        endGame();
    }
}

// ======================================================
// ZOMBIS (3 rondas de 15)
// ======================================================

console.log('[MAIN] Inicializando zombis...');

const zombieSystem = createZombieSystem({
    scene,
    camera,
    loader,
    collidesWithWorld,
    damagePlayer,

    // Posiciones generadas por scene.js (10 repartidas por el mapa).
    spawnPoints: world.zombieSpawns,
    spawns: world.zombieSpawns,

    // Reposición de zombis.
    getSpawnPoint: world.pickSpawnPoint,

    // Al empezar cada ronda: munición y botiquines se restablecen,
    // y cada paquete da +15 balas más que en la ronda anterior.
    onRoundChange: (round, info) => {
        const ammoPerPack = world.resetPickups?.(round);

        banner(
            `RONDA ${round}: ${info.label}`,
            '#ffc65c',
            4000
        );

        console.log(
            '[MAIN] Comienza la ronda', round,
            '| munición por paquete:', ammoPerPack
        );
    },

    onKill: kills => {
        const total = zombieSystem.totalKills ?? 45;

        if (kills >= total && !extractionOpen) {
            extractionOpen = true;

            world.setExtractionActive(true);

            if (typeof hud.showExtraction === 'function') {
                hud.showExtraction();
            }

            banner('EXTRACCIÓN ACTIVA: ve a la zona verde', '#35ff93');
            console.log('[MAIN] Extracción activada.');
        }
    },

    updateCounter: (remaining, round) => {
        if (!extractionOpen) {
            hud.updateZombieCounter(remaining, round);
        }
    }
});

// ======================================================
// ARMAS
// ======================================================

console.log('[MAIN] Inicializando armas...');

const weaponSystem = createWeaponSystem({
    camera,
    loader,
    controls,
    hud,

    hitZombie: damage => {
        zombieSystem.hitZombie(damage);
    },

    setSoldierShotMovement: value => {
        playerSystem.setShotMovement(value);
    },

    isGameOver: () => gameOver || won
});

// ======================================================
// FIN DE PARTIDA
// ======================================================

function endGame() {
    if (gameOver || won) {
        return;
    }

    gameOver = true;
    player.alive = false;

    weaponSystem.stopFiring();

    controls.unlock();

    hud.showGameOver(container);

    console.log('[MAIN] FIN DE LA PARTIDA');
}

// ======================================================
// VICTORIA: ZONA DE EXTRACCIÓN
// ======================================================

function winGame() {
    if (won || gameOver) {
        return;
    }

    won = true;

    weaponSystem.stopFiring();

    Object.keys(keys).forEach(key => {
        keys[key] = false;
    });

    controls.unlock();

    const box = document.createElement('div');

    box.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;' +
        'background:rgba(0,20,10,.85);color:#35ff93;' +
        'font:bold 42px sans-serif;text-align:center;z-index:50;';

    box.innerHTML =
        '¡MISIÓN COMPLETADA!' +
        '<div style="font-size:22px;margin-top:12px;color:#fff">' +
        'Has llegado a la zona de extracción</div>' +
        '<button id="restart-btn" style="margin-top:28px;padding:12px 28px;' +
        'font:bold 18px sans-serif;cursor:pointer;border:0;border-radius:6px;' +
        'background:#35ff93;color:#04130b">Jugar de nuevo</button>';

    container.appendChild(box);

    box.querySelector('#restart-btn').addEventListener('click', () => {
        location.reload();
    });

    console.log('[MAIN] MISIÓN COMPLETADA');
}

// ======================================================
// PANTALLA INICIAL
// ======================================================

hud.onStart(() => {
    if (player.alive && !gameOver && !won) {
        controls.lock();
    }
});

controls.addEventListener('lock', () => {
    if (!gameOver && !won) {
        hud.hideOverlay();

        if (!introShown) {
            introShown = true;

            banner(
                `RONDA 1: ${zombieSystem.rounds?.[0]?.label ?? 'Zombis normales'}`,
                '#ffc65c'
            );
        }
    }
});

controls.addEventListener('unlock', () => {
    weaponSystem.stopFiring();

    if (!gameOver && !won) {
        hud.showOverlay();
    }
});

// ======================================================
// CONTROLES DEL JUGADOR
// ======================================================

const movementKeys = {
    KeyW: 'forward',
    KeyS: 'backward',
    KeyA: 'left',
    KeyD: 'right'
};

document.addEventListener('keydown', event => {
    if (gameOver || won) {
        return;
    }

    if (movementKeys[event.code]) {
        keys[movementKeys[event.code]] = true;
    }

    if (event.code === 'Digit1') {
        weaponSystem.switchWeapon('pistol');
    }

    if (event.code === 'Digit2') {
        weaponSystem.switchWeapon('rifle');
    }

    // Recargar: pasa balas de la reserva al cargador.
    // La reserva sólo crece recogiendo paquetes de munición (RF02).
    if (event.code === 'KeyR') {
        weaponSystem.reloadWeapon();
    }
});

document.addEventListener('keyup', event => {
    if (movementKeys[event.code]) {
        keys[movementKeys[event.code]] = false;
    }
});

window.addEventListener('blur', () => {
    Object.keys(keys).forEach(key => {
        keys[key] = false;
    });

    weaponSystem.stopFiring();
});

// ======================================================
// MOVIMIENTO DEL JUGADOR
// ======================================================

function updatePlayerMovement(delta) {
    if (
        !controls.isLocked ||
        !player.alive ||
        gameOver ||
        won
    ) {
        return;
    }

    const previousPosition = camera.position.clone();

    if (keys.forward) {
        controls.moveForward(movementSpeed * delta);
    }

    if (keys.backward) {
        controls.moveForward(-movementSpeed * delta);
    }

    if (keys.left) {
        controls.moveRight(-movementSpeed * delta);
    }

    if (keys.right) {
        controls.moveRight(movementSpeed * delta);
    }

    if (
        typeof collidesWithWorld === 'function' &&
        collidesWithWorld(camera.position)
    ) {
        camera.position.copy(previousPosition);
    }
}

// ======================================================
// MUNICIÓN, BOTIQUINES Y EXTRACCIÓN
// ======================================================

function updatePickupsAndGoal() {
    if (!player.alive || gameOver || won) {
        return;
    }

    // Recoger paquetes de munición cercanos.
    const ammo = world.collectAmmoAt?.(camera.position) ?? 0;

    if (ammo > 0) {
        weaponSystem.addAmmo(ammo);
        banner(`+${ammo} MUNICIÓN`, '#e0b030', 1200);
    }

    // Botiquines: sólo se gastan si el jugador no tiene la vida llena.
    const heal = world.collectMedkitAt?.(
        camera.position,
        player.health < player.maxHealth
    ) ?? 0;

    if (heal > 0) {
        const before = player.health;

        player.health = Math.min(player.maxHealth, player.health + heal);

        hud.updateHealth(player);
        banner(`+${player.health - before} SALUD`, '#36c76b', 1200);
    }

    // ¿Llegó a la zona de extracción (activa)?
    if (world.isInExtraction(camera.position)) {
        winGame();
    }
}

// ======================================================
// BUCLE PRINCIPAL
// ======================================================

let animateErrorLogged = false;

function animate() {
    requestAnimationFrame(animate);

    const delta = Math.min(
        clock.getDelta(),
        0.05
    );

    // Un error en la lógica nunca debe impedir que se dibuje el juego.
    try {
        updatePlayerMovement(delta);

        updatePickupsAndGoal();

        playerSystem.updateSoldier(delta);

        zombieSystem.updateZombies(
            delta,
            gameOver || won,
            player
        );

        weaponSystem.update(delta);
    } catch (error) {
        if (!animateErrorLogged) {
            console.error('[MAIN] Error en el bucle de juego:', error);
            animateErrorLogged = true;
        }
    }

    renderer.render(scene, camera);
}

// ======================================================
// REDIMENSIONAMIENTO
// ======================================================

window.addEventListener('resize', () => {
    world.resize();
});

// ======================================================
// CARGA INICIAL
// ======================================================

hud.updateHealth(player);
hud.updateZombieCounter(zombieSystem.rounds?.[0]?.kills ?? 15, 1);

// ======================================================
// INICIAR SISTEMAS
// ======================================================

console.log('[MAIN] Cargando armas, zombis y soldado...');

try {
    await Promise.all([
        weaponSystem.loadWeapons(),
        zombieSystem.loadZombies(),
        playerSystem.loadSoldier()
    ]);
} catch (error) {
    console.error('[MAIN] Error cargando armas, zombis o soldado:', error);
}

try {
    renderer.compile(scene, camera);
} catch (error) {
    console.warn('[MAIN] No se pudieron precompilar los shaders:', error);
}

// ======================================================
// INICIAR RENDERIZADO
// ======================================================

animate();

console.log('==========================================');
console.log('OPERACIÓN EXTRACCIÓN');
console.log('SISTEMAS INICIADOS');
console.log('==========================================');