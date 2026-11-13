
import * as THREE from 'three';
import { CONFIG } from './config.js';

export function createPlayerSystem({ scene, camera, controls, loader, keys }) {
    const player = {
        health: 100,
        maxHealth: 100,
        alive: true
    };

    const soldierRoot = new THREE.Group();
    scene.add(soldierRoot);

    let soldierModel = null;
    let soldierMixer = null;
    let soldierWalkTime = 0;
    let soldierMovementAmount = 0;
    let soldierShotMovement = 0;

    const soldierBones = {};
    const soldierBaseRotations = {};

    const BONE_PATTERNS = {
        rightUpperArm: [/^Bip01_R_UpperArm$/i, /right.*upper.*arm/i, /upperarm.*r/i],
        rightForearm: [/^Bip01_R_Forearm$/i, /right.*forearm/i, /lowerarm.*r/i],
        rightHand: [/^Bip01_R_Hand$/i, /right.*hand/i, /hand.*r/i],
        leftUpperArm: [/^Bip01_L_UpperArm$/i, /left.*upper.*arm/i, /upperarm.*l/i],
        leftForearm: [/^Bip01_L_Forearm$/i, /left.*forearm/i, /lowerarm.*l/i],
        leftHand: [/^Bip01_L_Hand$/i, /left.*hand/i, /hand.*l/i]
    };

    function prepareMaterials(model) {
        model.traverse(object => {
            if (!object.isMesh) return;

            object.castShadow = true;
            object.receiveShadow = true;

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

    function findBone(patterns) {
        let found = null;

        soldierModel.traverse(object => {
            if (
                !found &&
                object.isBone &&
                patterns.some(pattern => pattern.test(object.name))
            ) {
                found = object;
            }
        });

        return found;
    }

    function prepareSoldier(gltf) {
        const model = gltf.scene;
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();

        box.getSize(size);
        box.getCenter(center);

        if (!Number.isFinite(size.y) || size.y <= 0) {
            throw new Error('Dimensiones inválidas del soldado.');
        }

        const scale = CONFIG.PLAYER_HEIGHT / size.y;
        model.scale.setScalar(scale);

        model.position.set(
            -center.x * scale,
            -box.min.y * scale,
            -center.z * scale
        );

        const head = model.getObjectByName('Bip01_Head');

        if (head) {
            head.scale.setScalar(0.001);
            console.log('Cabeza del soldado ocultada.');
        }

        prepareMaterials(model);
        return model;
    }

    async function loadSoldier() {
        try {
            console.log('Cargando soldado del jugador...');

            const gltf = await loader.loadAsync(CONFIG.ASSETS.soldier);

            soldierModel = prepareSoldier(gltf);
            soldierRoot.add(soldierModel);

            Object.entries(BONE_PATTERNS).forEach(([key, patterns]) => {
                const bone = findBone(patterns);
                soldierBones[key] = bone;

                if (bone) {
                    soldierBaseRotations[key] = bone.rotation.clone();
                    console.log(`HUESO DETECTADO: ${key} -> ${bone.name}`);
                } else {
                    console.warn(`No se encontró el hueso: ${key}`);
                }
            });

            soldierMixer = new THREE.AnimationMixer(soldierModel);

            gltf.animations.forEach(clip => {
                console.log(`${clip.name} | ${clip.duration.toFixed(2)} segundos`);
            });

            soldierRoot.visible = true;
            console.log('SOLDADO CARGADO CORRECTAMENTE');
        } catch (error) {
            console.error('ERROR CARGANDO SOLDADO:', error);
        }
    }

    function updateSoldierArms(delta) {
        if (!soldierModel) return;

        const moving = controls.isLocked && Object.values(keys).some(Boolean);

        soldierMovementAmount +=
            ((moving ? 1 : 0) - soldierMovementAmount) *
            Math.min(delta * 7, 1);

        if (moving) soldierWalkTime += delta * 8;

        soldierShotMovement +=
            -soldierShotMovement * Math.min(delta * 12, 1);

        const swing = Math.sin(soldierWalkTime);
        const movement = soldierMovementAmount;
        const shot = soldierShotMovement;

        const rotateBone = (key, x, y, z) => {
            const bone = soldierBones[key];
            const base = soldierBaseRotations[key];

            if (bone && base) {
                bone.rotation.set(base.x + x, base.y + y, base.z + z);
            }
        };

        rotateBone(
            'rightUpperArm',
            -0.45 + swing * 0.035 * movement - shot * 0.08,
            0,
            -0.18 + 0.025 * movement
        );

        rotateBone(
            'rightForearm',
            -0.25 + Math.max(0, swing) * 0.035 * movement - shot * 0.12,
            0,
            -0.30
        );

        rotateBone('rightHand', -shot * 0.06, 0, 0);

        rotateBone('leftUpperArm', -swing * 0.13 * movement, 0, -0.04 * movement);
        rotateBone('leftForearm', Math.max(0, -swing) * 0.10 * movement, 0, 0);
        rotateBone('leftHand', 0, 0, 0);
    }

    function updateSoldier(delta) {
        if (!soldierModel) return;

        soldierRoot.position.set(
            camera.position.x,
            camera.position.y - CONFIG.PLAYER_EYE_HEIGHT,
            camera.position.z
        );

        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);

        soldierRoot.rotation.y =
            Math.atan2(-direction.x, -direction.z) + Math.PI;

        soldierMixer?.update(delta);
        updateSoldierArms(delta);
    }

    function setShotMovement(value) {
        soldierShotMovement = value;
    }

    soldierRoot.visible = false;

    return {
        player,
        soldierRoot,
        loadSoldier,
        updateSoldier,
        setShotMovement
    };
}
