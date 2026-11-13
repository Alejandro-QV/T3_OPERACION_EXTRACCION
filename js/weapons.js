import * as THREE from 'three';
import { CONFIG } from './config.js';

export function createWeaponSystem({
    camera,
    loader,
    controls,
    hud,
    hitZombie,
    setSoldierShotMovement,
    isGameOver
}) {
    const weapons = {
        pistol: {
            path: CONFIG.ASSETS.pistol,
            name: 'PISTOLA',
            model: null,
            scale: 0.45,
            rotation: new THREE.Euler(0, -Math.PI / 2, 0),
            position: new THREE.Vector3(0.35, -0.25, -0.65),
            magazineSize: 12,
            ammo: 12,
            reserve: 48,
            fireRate: 300,
            reloadTime: 1500,
            damage: 34,
            automatic: false
        },

        rifle: {
            path: CONFIG.ASSETS.rifle,
            name: 'RIFLE',
            model: null,
            scale: 1.15,
            rotation: new THREE.Euler(0, 0, 0),
            position: new THREE.Vector3(0.30, -0.25, -0.70),
            magazineSize: 30,
            ammo: 30,
            reserve: 120,
            fireRate: 100,
            reloadTime: 2000,
            damage: 20,
            automatic: false
        }
    };

    // Grupo de armas: hijo directo de la cámara.
    const weaponGroup = new THREE.Group();
    weaponGroup.name = 'FIRST_PERSON_WEAPON_GROUP';
    weaponGroup.position.set(0, 0, 0);
    camera.add(weaponGroup);

    // Fogonazo: se crea UNA sola vez y solo cambia su intensidad.
    const muzzleFlash = new THREE.PointLight(0xffa52b, 0, 3);
    muzzleFlash.name = 'MUZZLE_FLASH';
    muzzleFlash.position.set(0, 0, -0.8);
    weaponGroup.add(muzzleFlash);

    let currentWeapon = 'pistol';
    let weaponLoaded = false;
    let firing = false;
    let reloading = false;
    let recoil = 0;
    let recoilVelocity = 0;
    let lastShot = 0;
    let reloadTimeout = null;
    let muzzleFlashTimeout = null;

    function prepareMaterials(model) {
        model.traverse(object => {
            if (!object.isMesh) return;

            object.visible = true;
            object.frustumCulled = false;
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

    function prepareWeapon(gltf, config) {
        const model = gltf.scene;

        model.position.set(0, 0, 0);
        model.rotation.copy(config.rotation);
        model.scale.setScalar(1);

        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();

        box.getSize(size);
        box.getCenter(center);

        const maxDimension = Math.max(size.x, size.y, size.z);

        if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
            throw new Error(`Dimensiones inválidas: ${config.name}`);
        }

        const pivot = new THREE.Group();
        pivot.name = `${config.name}_PIVOT`;

        pivot.add(model);

        model.position.set(-center.x, -center.y, -center.z);

        const normalizedScale = config.scale / maxDimension;
        pivot.scale.setScalar(normalizedScale);

        prepareMaterials(model);

        pivot.updateMatrixWorld(true);

        console.log(`[ARMAS] ${config.name} preparada`, {
            dimensiones: size.toArray(),
            escala: normalizedScale,
            centro: center.toArray()
        });

        return pivot;
    }

    function updateAmmoHUD() {
        hud.updateAmmo(
            weapons[currentWeapon],
            reloading
        );
    }

    function cancelReload() {
        if (reloadTimeout) {
            clearTimeout(reloadTimeout);
            reloadTimeout = null;
        }

        reloading = false;
    }

    function switchWeapon(type) {
        const weapon = weapons[type];

        if (!weapon || !weapon.model || isGameOver()) {
            return;
        }

        firing = false;

        // Cambiar de arma cancela la recarga en curso.
        cancelReload();

        if (muzzleFlashTimeout) {
            clearTimeout(muzzleFlashTimeout);
            muzzleFlashTimeout = null;
        }

        muzzleFlash.intensity = 0;

        weaponGroup.clear();

        weaponGroup.position.copy(weapon.position);
        weaponGroup.rotation.set(0, 0, 0);
        weaponGroup.scale.set(1, 1, 1);
        weaponGroup.visible = true;

        weapon.model.visible = true;

        weapon.model.traverse(object => {
            object.visible = true;
        });

        weaponGroup.add(weapon.model);
        weaponGroup.add(muzzleFlash);

        currentWeapon = type;

        weaponGroup.updateMatrixWorld(true);

        console.log(`[ARMAS] ${weapon.name} equipada`);

        updateAmmoHUD();
    }

    async function loadWeapons() {
        const loadingScreen = document.getElementById('loading-screen');
        const loadingText = loadingScreen?.querySelector('p');

        const entries = Object.entries(weapons);

        try {
            const results = await Promise.allSettled(
                entries.map(([, weapon]) => loader.loadAsync(weapon.path))
            );

            for (let i = 0; i < results.length; i++) {
                const [key, config] = entries[i];
                const result = results[i];

                if (result.status === 'fulfilled') {
                    try {
                        config.model = prepareWeapon(result.value, config);
                        console.log(`[ARMAS] ${config.name} cargada`);
                    } catch (error) {
                        console.error(`[ARMAS] Error preparando ${key}:`, error);
                    }
                } else {
                    console.error(`[ARMAS] Error cargando ${key}:`, result.reason);
                }
            }

            if (!weapons.pistol.model && !weapons.rifle.model) {
                throw new Error('No se pudo cargar ninguna de las dos armas.');
            }

            const initialWeapon = weapons.pistol.model
                ? 'pistol'
                : 'rifle';

            switchWeapon(initialWeapon);

            weaponLoaded = true;

            updateAmmoHUD();

            loadingScreen?.remove();

            console.log('[ARMAS] SISTEMA DE ARMAS INICIADO');

        } catch (error) {
            console.error('[ARMAS] Error durante la inicialización:', error);

            if (loadingText) {
                loadingText.textContent =
                    'Error al cargar las armas. Revisa la consola.';
            }
        }
    }

    function reloadWeapon() {
        const weapon = weapons[currentWeapon];

        if (
            !controls.isLocked ||
            !weaponLoaded ||
            reloading ||
            isGameOver() ||
            weapon.ammo >= weapon.magazineSize ||
            weapon.reserve <= 0
        ) {
            return;
        }

        firing = false;
        reloading = true;

        updateAmmoHUD();

        reloadTimeout = setTimeout(() => {
            reloadTimeout = null;

            if (isGameOver()) {
                reloading = false;
                updateAmmoHUD();
                return;
            }

            const missing = weapon.magazineSize - weapon.ammo;
            const available = Math.min(missing, weapon.reserve);

            weapon.ammo += available;
            weapon.reserve -= available;

            reloading = false;

            updateAmmoHUD();

        }, weapon.reloadTime);
    }

    // Suma balas a la reserva del arma equipada (paquetes de munición).
    // Si el cargador está vacío, recarga automáticamente.
    function addAmmo(amount) {
        const weapon = weapons[currentWeapon];

        weapon.reserve += amount;

        updateAmmoHUD();

        if (weapon.ammo <= 0) {
            reloadWeapon();
        }
    }

    function shoot() {
        if (
            !controls.isLocked ||
            !weaponLoaded ||
            reloading ||
            isGameOver()
        ) {
            return;
        }

        const weapon = weapons[currentWeapon];
        const now = performance.now();

        if (now - lastShot < weapon.fireRate) return;

        if (weapon.ammo <= 0) {
            firing = false;
            updateAmmoHUD();
            reloadWeapon();   // recarga automática si hay reserva
            return;
        }

        lastShot = now;
        weapon.ammo--;

        recoilVelocity = -0.15;

        setSoldierShotMovement(1);

        muzzleFlash.intensity = 3;

        if (muzzleFlashTimeout) {
            clearTimeout(muzzleFlashTimeout);
        }

        muzzleFlashTimeout = setTimeout(() => {
            muzzleFlash.intensity = 0;
            muzzleFlashTimeout = null;
        }, 65);

        hitZombie(weapon.damage);

        updateAmmoHUD();

        // Se acabó el cargador: recarga sola si queda reserva.
        if (weapon.ammo <= 0) {
            reloadWeapon();
        }
    }

    function onMouseDown(event) {
        if (
            event.button !== 0 ||
            !controls.isLocked ||
            isGameOver()
        ) {
            return;
        }

        if (weapons[currentWeapon].automatic) {
            firing = true;
        }

        shoot();
    }

    function onMouseUp(event) {
        if (event.button === 0) {
            firing = false;
        }
    }

    function update(delta) {
        if (firing && weapons[currentWeapon].automatic) {
            shoot();
        }

        recoil += (
            recoilVelocity - recoil
        ) * Math.min(delta * 18, 1);

        recoilVelocity += (
            -recoilVelocity
        ) * Math.min(delta * 12, 1);

        if (weaponLoaded) {
            const weapon = weapons[currentWeapon];

            weaponGroup.position.set(
                weapon.position.x,
                weapon.position.y,
                weapon.position.z + recoil
            );
        }
    }

    function stopFiring() {
        firing = false;
    }

    function dispose() {
        if (reloadTimeout) {
            clearTimeout(reloadTimeout);
        }

        if (muzzleFlashTimeout) {
            clearTimeout(muzzleFlashTimeout);
        }

        document.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mouseup', onMouseUp);

        weaponGroup.removeFromParent();
        weaponGroup.clear();
    }

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);

    return {
        weapons,
        weaponGroup,
        loadWeapons,
        switchWeapon,
        reloadWeapon,
        addAmmo,
        shoot,
        update,
        stopFiring,
        dispose,

        get currentWeapon() {
            return currentWeapon;
        }
    };
}