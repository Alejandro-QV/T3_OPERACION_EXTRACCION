import * as THREE from 'three';
import * as SkeletonModule from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';

// Compatible con versiones nuevas (export clone) y antiguas (objeto SkeletonUtils).
function cloneSkinned(source) {
    const clone = SkeletonModule.clone ?? SkeletonModule.SkeletonUtils?.clone;

    if (typeof clone !== 'function') {
        throw new Error('SkeletonUtils.clone no está disponible en esta versión de three.');
    }

    return clone(source);
}

// ======================================================
// RONDAS
// ======================================================

const ZOMBIE_BASE_HEALTH = 6;

const ROUNDS = [
    { kills: 15, healthMul: 1, speedMul: 1, label: 'Zombis normales' },
    { kills: 15, healthMul: 2, speedMul: 1, label: 'Zombis con el doble de vida' },
    { kills: 15, healthMul: 3, speedMul: 2, label: 'Triple de vida y el doble de velocidad' }
];

const TOTAL_KILLS = ROUNDS.reduce((sum, round) => sum + round.kills, 0);

export function createZombieSystem({
    scene,
    camera,
    loader,
    collidesWithWorld,
    damagePlayer,
    updateCounter,
    spawnPoints = [],
    spawns = [],
    onKill = () => {},
    onRoundChange = () => {},
    getSpawnPoint = null
}) {
    const zombies = [];

    let kills = 0;
    let roundIndex = 0;
    const respawnQueue = [];

    // Posiciones generadas por scene.js (10 repartidas por el mapa).
    const givenPoints = spawnPoints.length ? spawnPoints : spawns;

    const zombiePositions = givenPoints.length
        ? givenPoints
        : [
            new THREE.Vector3(-8, 0, -20),
            new THREE.Vector3(8, 0, -27),
            new THREE.Vector3(0, 0, -40)
        ];

    const ZOMBIE_HEIGHT = 2.3;
    const RESPAWN_DELAY = 2.5;

    // Velocidad base (el jugador va a 6). Se multiplica por speedMul de la ronda.
    const ZOMBIE_SPEED = 3.4;
    const ZOMBIE_ATTACK_SPEED = 4.8;
    const WALK_ANIM_SCALE = 1.7;

    // RF05: inactivo hasta que el jugador entra en este rango (metros).
    const ZOMBIE_DETECTION_DISTANCE = 16;

    // Rendimiento: lejos de este radio, un zombi inactivo ni se dibuja ni se anima.
    const ZOMBIE_RENDER_DISTANCE = 32;

    const ZOMBIE_ATTACK_DISTANCE = 1.6;
    const ZOMBIE_MIN_DISTANCE = 0.8;
    const ZOMBIE_DAMAGE = 10;
    const ZOMBIE_ATTACK_COOLDOWN = 1.2;
    const ZOMBIE_SPOTTED_TIME = 0.8;
    const ZOMBIE_ATTACK_IMPACT_TIME = 0.45;
    const ZOMBIE_RECOVERY_TIME = 0.35;

    const ANIMATIONS = {
        idle: 'Zombie_Idle',
        spotted: 'Zombie_EnemySpotted',
        walk: 'Zombie_Walk_Root',
        attack: 'Zombie_Skill'
    };

    // ---------- Rondas ----------

    function roundForKills(count) {
        let accumulated = 0;

        for (let i = 0; i < ROUNDS.length; i++) {
            accumulated += ROUNDS[i].kills;
            if (count < accumulated) return i;
        }

        return ROUNDS.length - 1;
    }

    function reportCounter() {
        const roundEnd = ROUNDS
            .slice(0, roundIndex + 1)
            .reduce((sum, round) => sum + round.kills, 0);

        updateCounter(Math.max(0, roundEnd - kills), roundIndex + 1);
    }

    // Aplica vida y velocidad de la ronda actual a un zombi.
    function applyRoundStats(zombie, refill) {
        const round = ROUNDS[roundIndex];

        zombie.maxHealth = ZOMBIE_BASE_HEALTH * round.healthMul;
        zombie.speedMul = round.speedMul;

        if (refill) zombie.health = zombie.maxHealth;

        if (zombie.currentAnimation === 'walk' && zombie.currentAction) {
            zombie.currentAction.setEffectiveTimeScale(
                WALK_ANIM_SCALE * zombie.speedMul
            );
        }
    }

    // ---------- Modelo ----------

    function prepareMaterials(model) {
        model.traverse(object => {
            if (!object.isMesh) return;

            object.castShadow = false;
            object.receiveShadow = false;

            const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];

            materials.forEach(material => {
                if (!material) return;
                material.side = THREE.DoubleSide;
                material.needsUpdate = true;
            });
        });
    }

    function prepareZombie(gltf) {
        const model = gltf.scene;
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();

        box.getSize(size);

        if (!Number.isFinite(size.y) || size.y <= 0) {
            throw new Error('Dimensiones inválidas del zombi.');
        }

        model.scale.setScalar(ZOMBIE_HEIGHT / size.y);
        model.updateMatrixWorld(true);

        const scaledBox = new THREE.Box3().setFromObject(model);
        model.position.y -= scaledBox.min.y;

        prepareMaterials(model);
        return model;
    }

    function setAnimation(zombie, name, loop = true) {
        if (!zombie.alive || !zombie.actions[name]) return;
        if (zombie.currentAnimation === name) return;

        const previous = zombie.currentAction;
        const next = zombie.actions[name];

        next.reset();
        next.enabled = true;
        next.setEffectiveWeight(1);
        next.setEffectiveTimeScale(
            name === 'walk' ? WALK_ANIM_SCALE * zombie.speedMul : 1
        );
        next.setLoop(
            loop ? THREE.LoopRepeat : THREE.LoopOnce,
            loop ? Infinity : 1
        );
        next.clampWhenFinished = !loop;
        next.play();

        if (previous && previous !== next) {
            previous.crossFadeTo(next, 0.25, false);
        } else {
            next.fadeIn(0.25);
        }

        zombie.currentAction = next;
        zombie.currentAnimation = name;
    }

    function createZombie(template, clips, position, index) {
        const model = cloneSkinned(template);

        model.position.set(position.x, 0, position.z);

        // Cada zombi mira en una dirección distinta mientras está inactivo.
        model.rotation.y = Math.random() * Math.PI * 2;

        scene.add(model);

        const mixer = new THREE.AnimationMixer(model);
        const actions = {};

        Object.entries(clips).forEach(([key, clip]) => {
            if (clip) actions[key] = mixer.clipAction(clip);
        });

        const zombie = {
            id: index + 1,
            model,
            mixer,
            actions,
            currentAction: null,
            currentAnimation: null,
            state: 'idle',
            health: ZOMBIE_BASE_HEALTH,
            maxHealth: ZOMBIE_BASE_HEALTH,
            speedMul: 1,
            spottedTimer: 0,
            attackElapsed: 0,
            attackCooldown: 0,
            recoveryTimer: 0,
            attackHit: false,
            alive: true,
            lastSafe: { x: position.x, z: position.z }
        };

        applyRoundStats(zombie, true);

        mixer.addEventListener('finished', event => {
            if (
                !zombie.alive ||
                zombie.state !== 'attacking' ||
                event.action !== zombie.actions.attack
            ) return;

            zombie.state = 'recovering';
            zombie.recoveryTimer = ZOMBIE_RECOVERY_TIME;
            zombie.attackCooldown = ZOMBIE_ATTACK_COOLDOWN;

            setAnimation(zombie, 'idle');
        });

        zombies.push(zombie);
        setAnimation(zombie, 'idle');

        return zombie;
    }

    async function loadZombies() {
        try {
            const gltf = await loader.loadAsync(CONFIG.ASSETS.zombie);
            const template = prepareZombie(gltf);

            console.log('ANIMACIONES DEL ZOMBI:');

            gltf.animations.forEach(clip => {
                console.log(`${clip.name} | ${clip.duration.toFixed(2)} segundos`);
            });

            const clips = {};

            Object.entries(ANIMATIONS).forEach(([key, name]) => {
                clips[key] = gltf.animations.find(clip => clip.name === name) || null;

                if (!clips[key]) console.warn(`No se encontró: ${name}`);
            });

            if (!clips.idle || !clips.walk || !clips.attack) {
                throw new Error('Faltan animaciones necesarias del zombi.');
            }

            zombiePositions.forEach((position, index) => {
                try {
                    createZombie(template, clips, position, index);
                } catch (error) {
                    console.error(`[ZOMBIES] No se pudo crear el zombi ${index + 1}:`, error);
                }
            });

            reportCounter();
            console.log('TOTAL DE ZOMBIS:', zombies.length);
        } catch (error) {
            console.error('Error cargando zombis:', error);
        }
    }

    function getRemainingCount() {
        return zombies.filter(zombie => zombie.alive).length;
    }

    // Cada impacto válido resta exactamente 1 punto de resistencia (RF07).
    function damageZombie(zombie) {
        if (!zombie?.alive) return;

        zombie.health = Math.max(0, zombie.health - 1);

        console.log(
            `Zombi ${zombie.id}: ${zombie.health} de ${zombie.maxHealth} de resistencia`
        );

        if (zombie.health <= 0) {
            zombie.alive = false;
            scene.remove(zombie.model);
            zombie.mixer.stopAllAction();

            console.log(`Zombi ${zombie.id} eliminado.`);

            kills++;

            // ¿Empieza una nueva ronda?
            const newIndex = roundForKills(kills);

            if (newIndex !== roundIndex && kills < TOTAL_KILLS) {
                roundIndex = newIndex;

                // Los zombis vivos se mejoran a las stats de la nueva ronda.
                zombies.forEach(item => {
                    if (item.alive) applyRoundStats(item, true);
                });

                onRoundChange(roundIndex + 1, ROUNDS[roundIndex]);
            }

            reportCounter();
            onKill(kills);

            // Mantiene la presión: repone zombis hasta completar todas las bajas.
            if (kills + getRemainingCount() + respawnQueue.length < TOTAL_KILLS) {
                respawnQueue.push({ zombie, timer: RESPAWN_DELAY });
            }
        }
    }

    function hitZombie() {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        raycaster.far = 60;

        const activeZombies = zombies.filter(
            zombie => zombie.alive && zombie.model.visible
        );
        const targets = [];

        activeZombies.forEach(zombie => {
            zombie.model.traverse(object => {
                if (object.isMesh) targets.push(object);
            });
        });

        const intersections = raycaster.intersectObjects(targets, false);
        if (!intersections.length) return;

        let object = intersections[0].object;

        while (object) {
            const zombie = activeZombies.find(item => item.model === object);

            if (zombie) {
                damageZombie(zombie);
                return;
            }

            object = object.parent;
        }
    }

    function startAttack(zombie) {
        if (!zombie.alive || zombie.state === 'attacking') return;

        zombie.state = 'attacking';
        zombie.attackElapsed = 0;
        zombie.attackHit = false;

        setAnimation(zombie, 'attack', false);
        console.log(`Zombi ${zombie.id}: inicia ataque.`);
    }

    function moveTowardsPlayer(
        zombie,
        direction,
        delta,
        stopDistance = ZOMBIE_MIN_DISTANCE,
        speed = ZOMBIE_SPEED
    ) {
        const position = zombie.model.position;

        const distance = Math.hypot(
            camera.position.x - position.x,
            camera.position.z - position.z
        );

        const movementDistance = Math.min(
            speed * delta,
            Math.max(0, distance - stopDistance)
        );

        if (movementDistance <= 0) return;

        const movement = direction.clone().multiplyScalar(movementDistance);
        const nextPosition = position.clone().add(movement);

        if (!collidesWithWorld(nextPosition, 0.45)) {
            position.x = nextPosition.x;
            position.z = nextPosition.z;
            return;
        }

        const nextX = position.clone();
        nextX.x += movement.x;

        const nextZ = position.clone();
        nextZ.z += movement.z;

        if (!collidesWithWorld(nextX, 0.45)) position.x = nextX.x;
        if (!collidesWithWorld(nextZ, 0.45)) position.z = nextZ.z;
    }

    // Reutiliza un zombi muerto: lo coloca lejos del jugador, inactivo y con
    // la vida y velocidad de la ronda actual.
    function respawnZombie(zombie) {
        const point = getSpawnPoint ? getSpawnPoint(camera.position) : null;

        if (!point) return false;

        zombie.alive = true;
        zombie.state = 'idle';
        zombie.spottedTimer = 0;
        zombie.attackElapsed = 0;
        zombie.attackCooldown = 0;
        zombie.recoveryTimer = 0;
        zombie.attackHit = false;
        zombie.currentAction = null;
        zombie.currentAnimation = null;
        zombie.lastSafe = { x: point.x, z: point.z };

        applyRoundStats(zombie, true);

        zombie.model.position.set(point.x, 0, point.z);
        zombie.model.rotation.set(0, Math.random() * Math.PI * 2, 0);
        zombie.model.visible = true;

        scene.add(zombie.model);
        setAnimation(zombie, 'idle');

        console.log(`Zombi ${zombie.id}: repuesto en el mapa.`);

        return true;
    }

    // Un error aquí nunca debe impedir que se dibuje el juego.
    let updateErrorLogged = false;

    function updateZombies(delta, gameOver, player) {
        try {
            updateZombiesUnsafe(delta, gameOver, player);
        } catch (error) {
            if (!updateErrorLogged) {
                console.error('[ZOMBIES] Error en updateZombies:', error);
                updateErrorLogged = true;
            }
        }
    }

    function updateZombiesUnsafe(delta, gameOver, player) {
        if (!player.alive || gameOver) return;

        // Reposición de zombis eliminados.
        for (let i = respawnQueue.length - 1; i >= 0; i--) {
            const item = respawnQueue[i];

            item.timer -= delta;

            if (item.timer <= 0) {
                if (respawnZombie(item.zombie)) {
                    respawnQueue.splice(i, 1);
                } else {
                    item.timer = 1;   // reintenta en 1 s
                }
            }
        }

        zombies.forEach(zombie => {
            if (!zombie.alive) return;

            const position = zombie.model.position;

            const direction = new THREE.Vector3(
                camera.position.x - position.x,
                0,
                camera.position.z - position.z
            );

            const distance = direction.length();

            // Rendimiento: un zombi inactivo y lejano no se dibuja ni se anima.
            if (zombie.state === 'idle') {
                const near = distance <= ZOMBIE_RENDER_DISTANCE;

                zombie.model.visible = near;

                if (!near) return;
            } else {
                zombie.model.visible = true;
            }

            zombie.mixer.update(delta);

            // Seguro: un zombi activo nunca puede quedar fuera del mapa.
            if (zombie.state !== 'idle') {
                if (collidesWithWorld(position, 0.1)) {
                    if (zombie.lastSafe) {
                        position.x = zombie.lastSafe.x;
                        position.z = zombie.lastSafe.z;
                    } else {
                        const p = getSpawnPoint ? getSpawnPoint(camera.position) : null;
                        if (p) position.set(p.x, 0, p.z);
                    }
                } else {
                    zombie.lastSafe = { x: position.x, z: position.z };
                }
            }

            // Mientras está inactivo no se gira hacia el jugador.
            if (distance > 0.001) {
                direction.normalize();

                if (zombie.state !== 'idle') {
                    zombie.model.lookAt(
                        camera.position.x,
                        position.y,
                        camera.position.z
                    );
                }
            }

            zombie.attackCooldown = Math.max(
                0,
                zombie.attackCooldown - delta
            );

            if (zombie.state === 'idle') {
                if (distance <= ZOMBIE_DETECTION_DISTANCE) {
                    zombie.state = 'spotted';
                    zombie.spottedTimer = ZOMBIE_SPOTTED_TIME;
                    setAnimation(zombie, 'spotted', false);
                    console.log(`Zombi ${zombie.id}: jugador detectado.`);
                }
                return;
            }

            if (zombie.state === 'spotted') {
                zombie.spottedTimer -= delta;

                if (zombie.spottedTimer <= 0) {
                    zombie.state = 'chasing';
                    setAnimation(zombie, 'walk', true);
                    console.log(`Zombi ${zombie.id}: comienza a perseguir.`);
                } else {
                    return;
                }
            }

            if (zombie.state === 'attacking') {
                zombie.attackElapsed += delta;

                if (zombie.attackElapsed < ZOMBIE_ATTACK_IMPACT_TIME) {
                    const attackDirection = new THREE.Vector3(
                        camera.position.x - position.x,
                        0,
                        camera.position.z - position.z
                    );

                    if (attackDirection.lengthSq() > 0.001) {
                        attackDirection.normalize();

                        moveTowardsPlayer(
                            zombie,
                            attackDirection,
                            delta,
                            ZOMBIE_MIN_DISTANCE,
                            ZOMBIE_ATTACK_SPEED * zombie.speedMul
                        );
                    }
                }

                if (
                    !zombie.attackHit &&
                    zombie.attackElapsed >= ZOMBIE_ATTACK_IMPACT_TIME
                ) {
                    zombie.attackHit = true;

                    const currentDistance = Math.hypot(
                        camera.position.x - position.x,
                        camera.position.z - position.z
                    );

                    if (currentDistance <= ZOMBIE_ATTACK_DISTANCE) {
                        damagePlayer(ZOMBIE_DAMAGE);
                        console.log(`Zombi ${zombie.id}: golpe conectado.`);
                    } else {
                        console.log(`Zombi ${zombie.id}: ataque fallido.`);
                    }
                }

                return;
            }

            if (zombie.state === 'recovering') {
                if (distance > ZOMBIE_ATTACK_DISTANCE + 0.25) {
                    zombie.state = 'chasing';
                    setAnimation(zombie, 'walk', true);
                } else {
                    zombie.recoveryTimer -= delta;

                    if (
                        zombie.recoveryTimer <= 0 &&
                        zombie.attackCooldown <= 0
                    ) {
                        startAttack(zombie);
                    }

                    return;
                }
            }

            if (zombie.state === 'chasing') {
                if (distance <= ZOMBIE_ATTACK_DISTANCE) {
                    startAttack(zombie);
                    return;
                }

                setAnimation(zombie, 'walk', true);

                moveTowardsPlayer(
                    zombie,
                    direction,
                    delta,
                    ZOMBIE_MIN_DISTANCE,
                    ZOMBIE_SPEED * zombie.speedMul
                );
            }
        });
    }

    return {
        zombies,
        loadZombies,
        updateZombies,
        hitZombie,
        getRemainingCount,
        totalKills: TOTAL_KILLS,
        rounds: ROUNDS
    };
}