import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';

// ======================================================
// AJUSTES
// ======================================================

const SHADOWS = false;
const LOAD_EXTRAS = true;

const GAP_VERTICAL = 8;
const GAP_SIDE = 6;
const HALL_DEPTH = 12;
const CORRIDOR_WIDTH = 8;

const ASSET_PATH = '/assets/laboratory/kenney/Models/GLB%20format/';

// Jugabilidad
const ZOMBIE_COUNT = 10;          // zombies repartidos por todo el recorrido
const AMMO_PACK_COUNT = 5;        // paquetes de munición en todo el mapa (escasos)
const AMMO_PER_PACK = 20;
const AMMO_ROUND_BONUS = 15;      // balas extra por paquete en cada ronda nueva
const AMMO_RESPAWN_SECONDS = 45;  // un paquete recogido reaparece pasado este tiempo
const AMMO_PICKUP_RADIUS = 1.2;

const MEDKIT_COUNT = 4;           // botiquines en el mapa
const MEDKIT_HEAL = 50;           // vida que restaura cada uno
const MEDKIT_PICKUP_RADIUS = 1.2;

// Rendimiento (ajusta estos si aún necesitas más FPS)
const RENDER_SCALE = 0.85;        // 1 = nítido, 0.75 = mucho más rápido
const CHEAP_MATERIALS = true;     // Lambert en vez de PBR: gran ahorro por píxel
const GLB_DOUBLE_SIDE = true;     // pon false para probar: menos píxeles dibujados
const MAX_DYNAMIC_LIGHTS = 3;     // luces puntuales reales simultáneas
const VISIBILITY_DEPTH = 2;       // cuántos espacios "a la vuelta" se dibujan (oclusión por salas)
const BATCH_COLLIDER_CELL = 4;    // celda (m) del índice espacial de colisiones
const COLLISION_CACHE_CELL = 0.2;

// Sellado
const SEAL_STEP = 0.25;
const WALK_EPS = 0.02;

const MAP = {
    wallThickness: 0.4,
    fallbackRoomSize: 16,
    fallbackHeight: 6,
    fogColor: 0x10191d
};

const SECTORS = [
    { key: 'acceso', name: 'Acceso', model: 'room-large.glb' },
    { key: 'seguridad', name: 'Seguridad', model: 'room-small.glb' },
    { key: 'investigacion', name: 'Investigación', model: 'room-wide.glb' },
    { key: 'experimentacion', name: 'Experimentación', model: 'room-large-variation.glb' },
    { key: 'contencion', name: 'Contención', model: 'room-wide-variation.glb' },
    { key: 'almacen', name: 'Almacén', model: 'room-small-variation.glb' },
    { key: 'extraccion', name: 'Extracción', model: 'room-large.glb' }
];

// Densidad de decoración por sala (1 = base).
const DECOR_DENSITY = {
    acceso: 0.3,
    seguridad: 0.35,
    investigacion: 0.4,
    experimentacion: 0.45,
    contencion: 0.65,
    almacen: 0.3,
    extraccion: 0.5
};

// ======================================================
// UTILIDADES GENERALES
// ======================================================

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;

        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pointInRect(r, x, z, pad = 0) {
    return (
        x >= r.minX - pad &&
        x <= r.maxX + pad &&
        z >= r.minZ - pad &&
        z <= r.maxZ + pad
    );
}

function rectsTouch(a, b, pad = 0.3) {
    return (
        a.minX <= b.maxX + pad &&
        a.maxX >= b.minX - pad &&
        a.minZ <= b.maxZ + pad &&
        a.maxZ >= b.minZ - pad
    );
}

// Material barato (Lambert) o PBR según CHEAP_MATERIALS.
function makeMaterial(options) {
    if (!CHEAP_MATERIALS) return new THREE.MeshStandardMaterial(options);

    const { metalness, roughness, ...rest } = options;
    return new THREE.MeshLambertMaterial(rest);
}

// Convierte un material de GLB a Lambert (con caché para compartirlo entre clones).
const cheapMaterialCache = new Map();

function toCheapMaterial(source) {
    if (!CHEAP_MATERIALS || !source) return source;
    if (!source.isMeshStandardMaterial) return source;

    let cheap = cheapMaterialCache.get(source.uuid);

    if (!cheap) {
        cheap = new THREE.MeshLambertMaterial({
            name: source.name,
            color: source.color,
            map: source.map,
            vertexColors: source.vertexColors,
            transparent: source.transparent,
            opacity: source.opacity,
            alphaTest: source.alphaTest,
            emissive: source.emissive,
            emissiveMap: source.emissiveMap,
            emissiveIntensity: source.emissiveIntensity,
            side: GLB_DOUBLE_SIDE ? THREE.DoubleSide : source.side
        });

        cheapMaterialCache.set(source.uuid, cheap);
    }

    return cheap;
}

const samplingCanvas = document.createElement('canvas');
const samplingContext = samplingCanvas.getContext('2d', {
    willReadFrequently: true
});

function sampleMeshColor(mesh) {
    const material = Array.isArray(mesh.material)
        ? mesh.material[0]
        : mesh.material;

    const color = new THREE.Color(1, 1, 1);

    if (material?.color) color.copy(material.color);

    const geometry = mesh.geometry;

    if (material?.vertexColors && geometry?.attributes?.color) {
        const attr = geometry.attributes.color;
        const step = Math.max(1, Math.floor(attr.count / 200));

        let r = 0, g = 0, b = 0, n = 0;

        for (let i = 0; i < attr.count; i += step) {
            r += attr.getX(i);
            g += attr.getY(i);
            b += attr.getZ(i);
            n++;
        }

        if (n > 0) {
            color.multiply(new THREE.Color(r / n, g / n, b / n));
        }
    }

    const map = material?.map;
    const uv = geometry?.attributes?.uv;

    if (map?.image && uv && uv.count > 0 && samplingContext) {
        try {
            const step = Math.max(1, Math.floor(uv.count / 200));
            let u = 0, v = 0, n = 0;

            for (let i = 0; i < uv.count; i += step) {
                u += uv.getX(i);
                v += uv.getY(i);
                n++;
            }

            u /= n;
            v /= n;

            const image = map.image;
            const width = image.width;
            const height = image.height;

            samplingCanvas.width = width;
            samplingCanvas.height = height;
            samplingContext.drawImage(image, 0, 0);

            const px = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
            const vv = map.flipY ? 1 - v : v;
            const py = Math.min(height - 1, Math.max(0, Math.floor(vv * height)));

            const data = samplingContext.getImageData(px, py, 1, 1).data;

            color.multiply(
                new THREE.Color().setRGB(
                    data[0] / 255,
                    data[1] / 255,
                    data[2] / 255,
                    THREE.SRGBColorSpace
                )
            );
        } catch (error) {
            console.warn('[PALETA] No se pudo leer la textura:', error);
        }
    }

    return color;
}

// ======================================================
// DECORACIÓN PROCEDURAL (INSTANCIADA, POR ESPACIO)
// ======================================================

// Tiempo compartido para el balanceo de lianas y pasto (sólo GPU).
const decorTime = { value: 0 };

function makeSway(material, key, amplitude, weightExpr) {
    material.onBeforeCompile = shader => {
        shader.uniforms.uTime = decorTime;

        shader.vertexShader =
            'uniform float uTime;\n' +
            shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                #ifdef USE_INSTANCING
                    float swPhase = instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 0.7;
                #else
                    float swPhase = 0.0;
                #endif
                float swW = ${weightExpr};
                transformed.x += sin(uTime * 1.4 + swPhase) * ${amplitude} * swW;
                transformed.z += cos(uTime * 1.1 + swPhase) * ${amplitude} * swW;`
            );
    };

    material.customProgramCacheKey = () => key;
}

function buildDecor({
    zones,
    isBlocked,
    addCollider,
    seed = 20261112
}) {
    const random = mulberry32(seed);
    const rr = (a, b) => a + random() * (b - a);

    const countFor = value => {
        const base = Math.floor(value);
        return base + (random() < value - base ? 1 : 0);
    };

    const color = (h, s, l) => new THREE.Color().setHSL(h, s, l);
    const green = (lMin, lMax) =>
        color(rr(0.2, 0.37), rr(0.35, 0.7), rr(lMin, lMax));

    const makeItems = () => ({
        vines: [],
        leaves: [],
        roots: [],
        bushes: [],
        grass: [],
        litter: [],
        moss: [],
        mushrooms: [],
        puddles: [],
        rubble: [],
        panelsFallen: [],
        panelsHanging: [],
        pipes: [],
        barrels: [],
        glass: []
    });

    const totals = {};

    // ==================================================
    // GEOMETRÍAS Y MATERIALES COMPARTIDOS
    // ==================================================

    const dummy = new THREE.Object3D();

    const lambert = options => new THREE.MeshLambertMaterial({
        color: 0xffffff,
        ...options
    });

    const shiny = options => makeMaterial({
        color: 0xffffff,
        roughness: 0.9,
        ...options
    });

    const flatCircle = new THREE.CircleGeometry(1, 10);
    flatCircle.rotateX(-Math.PI / 2);

    const flatBox = new THREE.BoxGeometry(1, 0.05, 1);

    const geoVine = new THREE.CylinderGeometry(0.03, 0.03, 1, 5);
    const geoLeaf = new THREE.IcosahedronGeometry(1, 0);
    const geoRoot = new THREE.CylinderGeometry(0.04, 0.05, 1, 5);
    const geoBush = new THREE.IcosahedronGeometry(1, 1);
    const geoGrass = new THREE.ConeGeometry(0.07, 0.5, 3);
    const geoMushroom = new THREE.IcosahedronGeometry(1, 0);
    const geoBox = new THREE.BoxGeometry(1, 1, 1);
    const geoPipe = new THREE.CylinderGeometry(0.08, 0.08, 1, 8);
    const geoBarrel = new THREE.CylinderGeometry(0.55, 0.55, 1.7, 14);
    const geoGlass = new THREE.BoxGeometry(1, 0.01, 1);

    const vineMaterial = lambert();
    makeSway(vineMaterial, 'decor-vine', '0.05', '(0.5 - position.y)');

    const grassMaterial = lambert({ side: THREE.DoubleSide });
    makeSway(grassMaterial, 'decor-grass', '0.07', '((position.y + 0.25) * 2.0)');

    const leafMaterial = lambert({ side: THREE.DoubleSide });
    const rootMaterial = lambert();
    const bushMaterial = lambert();
    const plainMaterial = lambert();

    const litterMaterial = lambert({
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    });

    const mossMaterial = lambert({
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    });

    const mushroomMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const puddleMaterial = shiny({
        roughness: 0.1,
        metalness: 0.3,
        transparent: true,
        opacity: 0.6,
        emissive: 0x0e5a48,
        emissiveIntensity: 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3
    });

    const pipeMaterial = shiny({ roughness: 0.7, metalness: 0.6 });
    const barrelMaterial = shiny({ roughness: 0.8, metalness: 0.4 });

    const glassMaterial = shiny({
        roughness: 0.1,
        metalness: 0.5,
        transparent: true,
        opacity: 0.6,
        depthWrite: false
    });

    // Cada espacio recibe sus propios InstancedMesh dentro de su Group:
    // así la oclusión por salas también oculta la decoración.
    function buildInstanced(name, geometry, material, list, parent) {
        if (!list.length) return;

        totals[name] = (totals[name] || 0) + list.length;

        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        mesh.name = name;

        list.forEach((item, index) => {
            dummy.position.set(item.x, item.y, item.z);
            dummy.rotation.set(item.rx || 0, item.ry || 0, item.rz || 0, 'YXZ');
            dummy.scale.set(item.sx, item.sy, item.sz);
            dummy.updateMatrix();

            mesh.setMatrixAt(index, dummy.matrix);
            mesh.setColorAt(index, item.color);
        });

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

        mesh.computeBoundingSphere();
        mesh.frustumCulled = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;

        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();

        parent.add(mesh);
    }

    function flushZone(zone, items) {
        const g = zone.group;

        buildInstanced('DECOR_Lianas', geoVine, vineMaterial, items.vines, g);
        buildInstanced('DECOR_Hojas', geoLeaf, leafMaterial, items.leaves, g);
        buildInstanced('DECOR_Raices', geoRoot, rootMaterial, items.roots, g);
        buildInstanced('DECOR_Arbustos', geoBush, bushMaterial, items.bushes, g);
        buildInstanced('DECOR_Pasto', geoGrass, grassMaterial, items.grass, g);
        buildInstanced('DECOR_Hojarasca', flatCircle, litterMaterial, items.litter, g);
        buildInstanced('DECOR_Musgo', flatCircle, mossMaterial, items.moss, g);
        buildInstanced('DECOR_Hongos', geoMushroom, mushroomMaterial, items.mushrooms, g);
        buildInstanced('DECOR_Charcos', flatCircle, puddleMaterial, items.puddles, g);
        buildInstanced('DECOR_Escombros', geoBox, plainMaterial, items.rubble, g);
        buildInstanced('DECOR_PanelesCaidos', flatBox, plainMaterial, items.panelsFallen, g);
        buildInstanced('DECOR_PanelesColgantes', flatBox, plainMaterial, items.panelsHanging, g);
        buildInstanced('DECOR_Tuberias', geoPipe, pipeMaterial, items.pipes, g);
        buildInstanced('DECOR_BarrilesVolcados', geoBarrel, barrelMaterial, items.barrels, g);
        buildInstanced('DECOR_Vidrios', geoGlass, glassMaterial, items.glass, g);
    }

    // ==================================================
    // GENERACIÓN
    // ==================================================

    function pointIn(zone, edgeBias) {
        for (let tries = 0; tries < 12; tries++) {
            let x, z;

            if (edgeBias) {
                const side = Math.floor(random() * 4);
                const d = rr(0.1, 1.6);

                if (side === 0) {
                    x = rr(zone.minX, zone.maxX);
                    z = zone.minZ + d;
                } else if (side === 1) {
                    x = rr(zone.minX, zone.maxX);
                    z = zone.maxZ - d;
                } else if (side === 2) {
                    x = zone.minX + d;
                    z = rr(zone.minZ, zone.maxZ);
                } else {
                    x = zone.maxX - d;
                    z = rr(zone.minZ, zone.maxZ);
                }
            } else {
                x = rr(zone.minX, zone.maxX);
                z = rr(zone.minZ, zone.maxZ);
            }

            if (!isBlocked(x, z, zone)) return { x, z };
        }

        return null;
    }

    for (const zone of zones) {
        const width = zone.maxX - zone.minX;
        const depth = zone.maxZ - zone.minZ;

        if (width <= 0.5 || depth <= 0.5) continue;

        const items = makeItems();

        const area = width * depth;
        const k = zone.density ?? 1;
        const ceil = zone.ceilY;
        const fy = zone.floorY || 0;
        const roomHeight = Math.max(ceil - fy, 1.5);
        const allowObstacles = !zone.noObstacles;

        // Lianas colgantes + hojas
        const vineClusters = countFor((area / 50) * k);

        for (let c = 0; c < vineClusters; c++) {
            const p = pointIn(zone, random() < 0.5);
            if (!p) continue;

            const strands = 3 + Math.floor(random() * 5);

            for (let j = 0; j < strands; j++) {
                const x = p.x + rr(-0.5, 0.5);
                const z = p.z + rr(-0.5, 0.5);

                const length = random() < 0.25
                    ? roomHeight - 0.05
                    : rr(1.2, Math.max(1.5, roomHeight * 0.8));

                const thickness = rr(0.8, 1.7);

                items.vines.push({
                    x,
                    y: ceil - length / 2,
                    z,
                    rx: rr(-0.08, 0.08),
                    rz: rr(-0.08, 0.08),
                    sx: thickness,
                    sy: length,
                    sz: thickness,
                    color: green(0.07, 0.17)
                });

                const leafCount = 2 + Math.floor(random() * 5);

                for (let l = 0; l < leafCount; l++) {
                    const s = rr(0.12, 0.3);

                    items.leaves.push({
                        x: x + rr(-0.15, 0.15),
                        y: ceil - rr(0.3, length),
                        z: z + rr(-0.15, 0.15),
                        rx: rr(-0.6, 0.6),
                        ry: rr(0, Math.PI * 2),
                        rz: rr(-0.6, 0.6),
                        sx: s,
                        sy: s * 0.3,
                        sz: s * rr(0.8, 1.3),
                        color: green(0.14, 0.28)
                    });
                }
            }
        }

        // Cables colgando (reutilizan la malla de lianas, en color oscuro)
        const cableCount = countFor((area / 70) * k);

        for (let i = 0; i < cableCount; i++) {
            const p = pointIn(zone, random() < 0.5);
            if (!p) continue;

            const length = rr(1.2, Math.min(4, roomHeight * 0.8));
            const thickness = rr(1.4, 2.4);

            items.vines.push({
                x: p.x,
                y: ceil - length / 2,
                z: p.z,
                rx: rr(-0.12, 0.12),
                rz: rr(-0.12, 0.12),
                sx: thickness,
                sy: length,
                sz: thickness,
                color: color(0.55, rr(0.03, 0.12), rr(0.05, 0.12))
            });
        }

        // Raíces
        const rootCount = countFor((area / 35) * k);

        for (let i = 0; i < rootCount; i++) {
            const p = pointIn(zone, random() < 0.6);
            if (!p) continue;

            items.roots.push({
                x: p.x,
                y: fy + 0.05,
                z: p.z,
                ry: rr(0, Math.PI * 2),
                rz: Math.PI / 2,
                sx: rr(0.8, 1.8),
                sy: rr(1, 3.2),
                sz: rr(0.8, 1.8),
                color: color(rr(0.05, 0.1), rr(0.3, 0.5), rr(0.08, 0.16))
            });
        }

        // Arbustos
        const bushCount = countFor((area / 45) * k);

        for (let i = 0; i < bushCount; i++) {
            const p = pointIn(zone, random() < 0.7);
            if (!p) continue;

            const sy = rr(0.4, 0.9);

            items.bushes.push({
                x: p.x,
                y: fy + sy * 0.5,
                z: p.z,
                ry: rr(0, Math.PI * 2),
                sx: rr(0.5, 1.2),
                sy,
                sz: rr(0.5, 1.2),
                color: green(0.09, 0.2)
            });
        }

        // Pasto (agrupado en matas)
        const grassClusters = countFor((area / 18) * k);

        for (let c = 0; c < grassClusters; c++) {
            const p = pointIn(zone, random() < 0.5);
            if (!p) continue;

            const blades = 3 + Math.floor(random() * 4);

            for (let j = 0; j < blades; j++) {
                const sy = rr(0.5, 1.4);

                items.grass.push({
                    x: p.x + rr(-0.35, 0.35),
                    y: fy + 0.25 * sy,
                    z: p.z + rr(-0.35, 0.35),
                    rx: rr(-0.25, 0.25),
                    rz: rr(-0.25, 0.25),
                    sx: rr(0.7, 1.3),
                    sy,
                    sz: rr(0.7, 1.3),
                    color: green(0.14, 0.3)
                });
            }
        }

        // Hojarasca seca
        const litterCount = countFor((area / 4) * k);

        for (let i = 0; i < litterCount; i++) {
            const p = pointIn(zone, random() < 0.6);
            if (!p) continue;

            const r = rr(0.08, 0.26);

            items.litter.push({
                x: p.x,
                y: fy + 0.016 + random() * 0.006,
                z: p.z,
                ry: rr(0, Math.PI * 2),
                sx: r,
                sy: 1,
                sz: r * rr(0.6, 1.2),
                color: color(rr(0.07, 0.13), rr(0.3, 0.5), rr(0.12, 0.24))
            });
        }

        // Musgo
        const mossCount = countFor((area / 9) * k);

        for (let i = 0; i < mossCount; i++) {
            const p = pointIn(zone, random() < 0.5);
            if (!p) continue;

            const r = rr(0.3, 1.1);

            items.moss.push({
                x: p.x,
                y: fy + 0.012 + random() * 0.006,
                z: p.z,
                ry: rr(0, Math.PI * 2),
                sx: r,
                sy: 1,
                sz: r * rr(0.7, 1.3),
                color: green(0.07, 0.16)
            });
        }

        // Hongos bioluminiscentes (material sin iluminación)
        const mushroomClusters = countFor((area / 60) * k);

        for (let c = 0; c < mushroomClusters; c++) {
            const p = pointIn(zone, true);
            if (!p) continue;

            const hue = rr(0.42, 0.52);
            const caps = 3 + Math.floor(random() * 4);

            for (let j = 0; j < caps; j++) {
                const r = rr(0.04, 0.12);

                items.mushrooms.push({
                    x: p.x + rr(-0.3, 0.3),
                    y: fy + r * 0.6,
                    z: p.z + rr(-0.3, 0.3),
                    sx: r,
                    sy: r * 0.6,
                    sz: r,
                    color: color(hue, 0.85, rr(0.5, 0.65))
                });
            }
        }

        // Charcos
        const puddleCount = countFor((area / 45) * k);

        for (let i = 0; i < puddleCount; i++) {
            const p = pointIn(zone, false);
            if (!p) continue;

            const r = rr(0.3, 0.9);

            items.puddles.push({
                x: p.x,
                y: fy + 0.02 + random() * 0.005,
                z: p.z,
                ry: rr(0, Math.PI * 2),
                sx: r,
                sy: 1,
                sz: r * rr(0.7, 1.3),
                color: color(rr(0.42, 0.52), 0.6, rr(0.2, 0.32))
            });
        }

        // Escombros
        const rubbleClusters = countFor((area / 28) * k);

        for (let c = 0; c < rubbleClusters; c++) {
            const p = pointIn(zone, random() < 0.6);
            if (!p) continue;

            const pieces = 4 + Math.floor(random() * 5);

            for (let j = 0; j < pieces; j++) {
                const sy = rr(0.08, 0.35);

                items.rubble.push({
                    x: p.x + rr(-0.8, 0.8),
                    y: fy + sy / 2,
                    z: p.z + rr(-0.8, 0.8),
                    rx: rr(-0.5, 0.5),
                    ry: rr(0, Math.PI * 2),
                    rz: rr(-0.5, 0.5),
                    sx: rr(0.1, 0.4),
                    sy,
                    sz: rr(0.1, 0.4),
                    color: color(rr(0.5, 0.6), rr(0.03, 0.1), rr(0.15, 0.35))
                });
            }
        }

        // Paneles caídos
        const fallenCount = countFor((area / 70) * k);

        for (let i = 0; i < fallenCount; i++) {
            const p = pointIn(zone, random() < 0.4);
            if (!p) continue;

            items.panelsFallen.push({
                x: p.x,
                y: fy + 0.08,
                z: p.z,
                rx: rr(-0.35, 0.35),
                ry: rr(0, Math.PI * 2),
                rz: rr(-0.35, 0.35),
                sx: rr(0.9, 1.3),
                sy: 1,
                sz: rr(0.9, 1.3),
                color: color(rr(0.5, 0.55), rr(0.05, 0.1), rr(0.45, 0.62))
            });
        }

        // Paneles colgantes
        const hangingCount = countFor((area / 90) * k);

        for (let i = 0; i < hangingCount; i++) {
            const p = pointIn(zone, random() < 0.4);
            if (!p) continue;

            items.panelsHanging.push({
                x: p.x,
                y: ceil - 0.3,
                z: p.z,
                rx: rr(-0.2, 0.2),
                ry: rr(0, Math.PI * 2),
                rz: rr(0.35, 0.9) * (random() < 0.5 ? -1 : 1),
                sx: rr(0.9, 1.3),
                sy: 1,
                sz: rr(0.9, 1.3),
                color: color(rr(0.5, 0.55), rr(0.05, 0.1), rr(0.3, 0.45))
            });
        }

        // Tuberías rotas
        const pipeCount = countFor((area / 80) * k);

        for (let i = 0; i < pipeCount; i++) {
            const p = pointIn(zone, random() < 0.5);
            if (!p) continue;

            const length = rr(1.5, 3.5);

            items.pipes.push({
                x: p.x,
                y: ceil - length * 0.45,
                z: p.z,
                rx: rr(-0.5, 0.5),
                rz: rr(-0.5, 0.5),
                sx: rr(0.8, 1.4),
                sy: length,
                sz: rr(0.8, 1.4),
                color: random() < 0.6
                    ? color(rr(0.04, 0.08), rr(0.4, 0.6), rr(0.14, 0.24))
                    : color(0.55, 0.08, rr(0.2, 0.3))
            });
        }

        // Barriles volcados (con colisión; nunca en pasillos)
        if (allowObstacles) {
            const barrelCount = Math.min(countFor((area / 220) * k), 3);

            for (let i = 0; i < barrelCount; i++) {
                const p = pointIn(zone, true);
                if (!p) continue;

                const alongX = random() < 0.5;

                items.barrels.push({
                    x: p.x,
                    y: fy + 0.55,
                    z: p.z,
                    ry: alongX ? 0 : Math.PI / 2,
                    rz: Math.PI / 2,
                    sx: 1,
                    sy: 1,
                    sz: 1,
                    color: random() < 0.5
                        ? color(0.27, 0.5, 0.25)
                        : color(0.06, 0.5, 0.2)
                });

                if (alongX) addCollider(p.x, p.z, 1.7, 1.1);
                else addCollider(p.x, p.z, 1.1, 1.7);
            }
        }

        // Vidrios rotos
        const glassCount = countFor((area / 22) * k);

        for (let i = 0; i < glassCount; i++) {
            const p = pointIn(zone, false);
            if (!p) continue;

            items.glass.push({
                x: p.x,
                y: fy + 0.015,
                z: p.z,
                rx: rr(-0.1, 0.1),
                ry: rr(0, Math.PI * 2),
                rz: rr(-0.1, 0.1),
                sx: rr(0.04, 0.18),
                sy: 1,
                sz: rr(0.04, 0.18),
                color: color(0.5, 0.4, rr(0.6, 0.8))
            });
        }

        flushZone(zone, items);
    }

    console.log('[DECOR] Instancias creadas:', totals);
}

// ======================================================
// CREACIÓN DE ESCENA
// ======================================================

export function createScene(container) {
    if (!container) {
        throw new Error('[SCENE] No se recibió el contenedor.');
    }

    const scene = new THREE.Scene();

    scene.background = new THREE.Color(MAP.fogColor);
    scene.fog = new THREE.FogExp2(MAP.fogColor, 0.008);

    const camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        70
    );

    camera.position.set(0, CONFIG.PLAYER_EYE_HEIGHT || 1.7, 5);
    scene.add(camera);

    // ==================================================
    // RENDERIZADOR
    // ==================================================

    const renderer = new THREE.WebGLRenderer({
        antialias: false,
        powerPreference: 'high-performance'
    });

    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 1) * RENDER_SCALE;

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(pixelRatio());

    renderer.shadowMap.enabled = SHADOWS;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    container.appendChild(renderer.domElement);

    // ==================================================
    // MATERIALES
    // ==================================================

    const materials = {
        dark: makeMaterial({ color: 0x141b1f, metalness: 0.5, roughness: 0.75 }),
        metal: makeMaterial({ color: 0x718087, metalness: 0.8, roughness: 0.4 }),
        rusty: makeMaterial({ color: 0x70452f, metalness: 0.5, roughness: 0.85 }),
        yellow: makeMaterial({ color: 0xd8a929, roughness: 0.8 }),

        green: makeMaterial({
            color: 0x72b83c,
            emissive: 0x274d0b,
            emissiveIntensity: 0.6
        }),

        glass: makeMaterial({
            color: 0x284c5a,
            metalness: 0.65,
            roughness: 0.2,
            transparent: true,
            opacity: 0.55,
            depthWrite: false
        }),

        white: makeMaterial({ color: 0xb8c6c9, roughness: 0.75 }),
        black: makeMaterial({ color: 0x080d10, roughness: 0.95 }),

        lightPanel: makeMaterial({
            color: 0xcfeff5,
            emissive: 0x9fe8ff,
            emissiveIntensity: 1.2
        })
    };

    const decal = options => makeMaterial({
        roughness: 1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        ...options
    });

    const palette = {
        floor: makeMaterial({ color: 0x343b3b, roughness: 0.98, metalness: 0.02 }),
        wall: makeMaterial({ color: 0x414b49, metalness: 0.05, roughness: 0.98 }),
        ceiling: makeMaterial({ color: 0x202827, metalness: 0.12, roughness: 1 }),

        damagedConcrete: decal({ color: 0x292f2d }),
        wetConcrete: decal({ color: 0x202b2a, roughness: 0.35, metalness: 0.12 }),
        exposedConcrete: decal({ color: 0x625d50 }),
        rust: decal({ color: 0x603b29, roughness: 0.95, metalness: 0.15 }),
        crack: decal({ color: 0x080e0e }),

        darkMetal: makeMaterial({ color: 0x252e30, roughness: 0.85, metalness: 0.55 }),
        debris: makeMaterial({ color: 0x45433b, roughness: 1 }),
        ceilingDark: makeMaterial({ color: 0x080e0e, roughness: 1 })
    };

    const emergencyMaterials = new Map();

    function getEmergencyMaterial(color) {
        if (!emergencyMaterials.has(color)) {
            emergencyMaterials.set(
                color,
                makeMaterial({
                    color,
                    emissive: color,
                    emissiveIntensity: 2
                })
            );
        }

        return emergencyMaterials.get(color);
    }

    const layout = {
        height: MAP.fallbackHeight
    };

    // ==================================================
    // ESPACIOS (salas / pasillos) Y VISIBILIDAD
    // ==================================================
    // Cada espacio tiene su propio Group. Sólo se dibujan el espacio donde está la cámara
    // y los que quedan a VISIBILITY_DEPTH "puertas" de distancia (oclusión por salas).

    const walkRects = [];

    function addRect(name, minX, maxX, minZ, maxZ, top, kind) {
        const group = new THREE.Group();
        group.name = name;
        scene.add(group);

        const rect = {
            name,
            kind,
            minX,
            maxX,
            minZ,
            maxZ,
            top,
            wallH: kind === 'room' ? top + 0.3 : top,
            index: walkRects.length,
            group,
            neighbors: []
        };

        walkRects.push(rect);
        return rect;
    }

    function linkNeighbors() {
        for (const a of walkRects) {
            a.neighbors = [];

            for (const b of walkRects) {
                if (a !== b && rectsTouch(a, b)) a.neighbors.push(b.index);
            }
        }
    }

    let visibleFrom = -2;

    function updateVisibility(position, force = false) {
        if (!walkRects.length) return;

        let index = -1;

        for (const rect of walkRects) {
            if (pointInRect(rect, position.x, position.z, 0.05)) {
                index = rect.index;
                break;
            }
        }

        if (!force && index === visibleFrom) return;

        visibleFrom = index;

        const show = new Set();

        if (index < 0) {
            walkRects.forEach(rect => show.add(rect.index));
        } else {
            show.add(index);

            let frontier = [index];

            for (let depth = 0; depth < VISIBILITY_DEPTH; depth++) {
                const next = [];

                for (const i of frontier) {
                    for (const n of walkRects[i].neighbors) {
                        if (!show.has(n)) {
                            show.add(n);
                            next.push(n);
                        }
                    }
                }

                frontier = next;
            }
        }

        for (const rect of walkRects) {
            rect.group.visible = show.has(rect.index);
        }
    }

    function inWalkable(x, z) {
        if (!walkRects.length) return true;

        for (const rect of walkRects) {
            if (pointInRect(rect, x, z, WALK_EPS)) return true;
        }

        return false;
    }

    // ==================================================
    // COLISIONES
    // ==================================================

    const colliders = [];

    // Índice espacial: en vez de recorrer todas las cajas, sólo las de las celdas cercanas.
    const colliderGrid = new Map();
    let indexedColliders = 0;

    const cellKey = (ix, iz) => (ix + 1024) * 2048 + (iz + 1024);

    function indexCollider(box) {
        const x0 = Math.floor(box.minX / BATCH_COLLIDER_CELL);
        const x1 = Math.floor(box.maxX / BATCH_COLLIDER_CELL);
        const z0 = Math.floor(box.minZ / BATCH_COLLIDER_CELL);
        const z1 = Math.floor(box.maxZ / BATCH_COLLIDER_CELL);

        for (let ix = x0; ix <= x1; ix++) {
            for (let iz = z0; iz <= z1; iz++) {
                const key = cellKey(ix, iz);
                let list = colliderGrid.get(key);

                if (!list) {
                    list = [];
                    colliderGrid.set(key, list);
                }

                list.push(box);
            }
        }
    }

    function addCollider(x, z, width, depth) {
        colliders.push({
            minX: x - width / 2,
            maxX: x + width / 2,
            minZ: z - depth / 2,
            maxZ: z + depth / 2
        });
    }

    function collidesWithBoxes(px, pz, radius) {
        // Por si otro módulo añade cajas directamente a `colliders`.
        while (indexedColliders < colliders.length) {
            indexCollider(colliders[indexedColliders++]);
        }

        const x0 = Math.floor((px - radius) / BATCH_COLLIDER_CELL);
        const x1 = Math.floor((px + radius) / BATCH_COLLIDER_CELL);
        const z0 = Math.floor((pz - radius) / BATCH_COLLIDER_CELL);
        const z1 = Math.floor((pz + radius) / BATCH_COLLIDER_CELL);

        for (let ix = x0; ix <= x1; ix++) {
            for (let iz = z0; iz <= z1; iz++) {
                const list = colliderGrid.get(cellKey(ix, iz));

                if (!list) continue;

                for (const box of list) {
                    if (
                        px + radius > box.minX &&
                        px - radius < box.maxX &&
                        pz + radius > box.minZ &&
                        pz - radius < box.maxZ
                    ) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    const meshColliders = [];

    const COLLISION_RAY_HEIGHT = 1.0;
    const collisionRaycaster = new THREE.Raycaster();
    const collisionOrigin = new THREE.Vector3();
    const collisionDirections = [];

    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;

        collisionDirections.push(
            new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
        );
    }

    const meshCollisionCache = new Map();

    function rawCollidesWithMeshes(x, z, radius) {
        let candidates = null;

        for (const entry of meshColliders) {
            const b = entry.box;

            if (
                x + radius < b.min.x ||
                x - radius > b.max.x ||
                z + radius < b.min.z ||
                z - radius > b.max.z
            ) {
                continue;
            }

            if (!candidates) candidates = [];
            candidates.push(entry.mesh);
        }

        if (!candidates) return false;

        collisionOrigin.set(x, COLLISION_RAY_HEIGHT, z);
        collisionRaycaster.near = 0;
        collisionRaycaster.far = radius;

        for (const direction of collisionDirections) {
            collisionRaycaster.set(collisionOrigin, direction);

            if (collisionRaycaster.intersectObjects(candidates, false).length > 0) {
                return true;
            }
        }

        return false;
    }

    function collidesWithMeshes(position, radius) {
        if (!meshColliders.length) return false;

        const ix = Math.round(position.x / COLLISION_CACHE_CELL);
        const iz = Math.round(position.z / COLLISION_CACHE_CELL);

        const key =
            ((ix + 4096) * 8192 + (iz + 4096)) * 16 +
            Math.min(15, Math.round(radius * 10));

        let result = meshCollisionCache.get(key);

        if (result === undefined) {
            result = rawCollidesWithMeshes(
                ix * COLLISION_CACHE_CELL,
                iz * COLLISION_CACHE_CELL,
                radius + 0.1
            );

            meshCollisionCache.set(key, result);
        }

        return result;
    }

    function collidesWithWorld(position, radius = 0.45) {
        // Red de seguridad: nada puede salir del conjunto de salas y pasillos.
        if (!inWalkable(position.x, position.z)) return true;

        if (collidesWithBoxes(position.x, position.z, radius)) return true;

        return collidesWithMeshes(position, radius);
    }

    // ==================================================
    // GEOMETRÍA ESTÁTICA FUSIONADA (por espacio y material)
    // ==================================================

    const unitBox = new THREE.BoxGeometry(1, 1, 1);

    const unitCircle = new THREE.CircleGeometry(1, 10);
    unitCircle.rotateX(-Math.PI / 2);

    const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 14);
    const unitTube = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true);

    const staticBatches = new Map();

    let currentSpace = null;

    function useSpace(rect) {
        currentSpace = rect;
    }

    const tmpEuler = new THREE.Euler();
    const tmpQuat = new THREE.Quaternion();
    const tmpPos = new THREE.Vector3();
    const tmpScale = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();

    function addStatic(base, material, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
        tmpEuler.set(rx, ry, rz, 'YXZ');
        tmpQuat.setFromEuler(tmpEuler);
        tmpMat.compose(tmpPos.set(x, y, z), tmpQuat, tmpScale.set(sx, sy, sz));

        const geometry = base.clone().applyMatrix4(tmpMat);

        const key = material.uuid + '|' + (currentSpace ? currentSpace.index : 'g');

        let batch = staticBatches.get(key);

        if (!batch) {
            batch = {
                material,
                geometries: [],
                group: currentSpace ? currentSpace.group : scene
            };

            staticBatches.set(key, batch);
        }

        batch.geometries.push(geometry);
    }

    function flushStatic() {
        let meshCount = 0;
        let sourceCount = 0;

        for (const batch of staticBatches.values()) {
            sourceCount += batch.geometries.length;

            const merged = mergeGeometries(batch.geometries, false);

            batch.geometries.forEach(geometry => geometry.dispose());

            if (!merged) {
                console.warn('[BATCH] No se pudo fusionar un grupo de geometrías.');
                continue;
            }

            merged.computeBoundingSphere();

            const mesh = new THREE.Mesh(merged, batch.material);
            mesh.name = 'STATIC_BATCH';
            mesh.castShadow = SHADOWS;
            mesh.receiveShadow = SHADOWS;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();

            batch.group.add(mesh);
            meshCount++;
        }

        staticBatches.clear();

        console.log(`[BATCH] ${sourceCount} piezas fusionadas en ${meshCount} mallas.`);
    }

    function createBox(
        name,
        x, y, z,
        width, height, depth,
        material,
        collision = false,
        rx = 0, ry = 0, rz = 0
    ) {
        addStatic(unitBox, material, x, y, z, width, height, depth, rx, ry, rz);

        if (collision) addCollider(x, z, width, depth);
    }

    function createCylinder(
        name,
        x, y, z,
        radius,
        height,
        material,
        collision = false
    ) {
        addStatic(unitCylinder, material, x, y, z, radius, height, radius);

        if (collision) addCollider(x, z, radius * 2, radius * 2);
    }

    // ==================================================
    // ILUMINACIÓN
    // ==================================================

    scene.add(new THREE.HemisphereLight(0x8ba9b5, 0x101715, 0.85));

    const mainLight = new THREE.DirectionalLight(0x91a8aa, 0.45);

    mainLight.position.set(-15, 35, 20);
    mainLight.castShadow = SHADOWS;

    if (SHADOWS) {
        mainLight.shadow.mapSize.set(1024, 1024);
        mainLight.shadow.camera.left = -80;
        mainLight.shadow.camera.right = 80;
        mainLight.shadow.camera.top = 80;
        mainLight.shadow.camera.bottom = -110;
    }

    scene.add(mainLight);

    // Luces "candidatas": sólo las MAX_DYNAMIC_LIGHTS más cercanas a la cámara son reales.
    const lightCandidates = [];
    const lightPool = [];

    for (let i = 0; i < MAX_DYNAMIC_LIGHTS; i++) {
        const light = new THREE.PointLight(0xffffff, 0, 10, 2);
        light.userData = { candidate: null, target: 0 };
        scene.add(light);
        lightPool.push(light);
    }

    const lastLightPosition = new THREE.Vector3(1e9, 0, 1e9);
    let lightsDirty = true;

    function addPointLight(color, intensity, x, y, z, distance = 18) {
        lightCandidates.push({
            color: new THREE.Color(color),
            intensity,
            position: new THREE.Vector3(x, y, z),
            distance
        });

        lightsDirty = true;
    }

    function assignLights(position) {
        const ranked = lightCandidates
            .map(candidate => ({
                candidate,
                score:
                    Math.hypot(
                        candidate.position.x - position.x,
                        candidate.position.z - position.z
                    ) - candidate.distance * 0.5
            }))
            .sort((a, b) => a.score - b.score)
            .slice(0, MAX_DYNAMIC_LIGHTS)
            .map(entry => entry.candidate);

        const wanted = new Set(ranked);
        const free = [];

        for (const light of lightPool) {
            const current = light.userData.candidate;

            if (current && wanted.has(current)) {
                wanted.delete(current);
            } else {
                free.push(light);
            }
        }

        for (const light of free) {
            const next = wanted.values().next().value;

            if (!next) {
                light.userData.candidate = null;
                light.userData.target = 0;
                continue;
            }

            wanted.delete(next);

            light.userData.candidate = next;
            light.userData.target = next.intensity;

            light.color.copy(next.color);
            light.position.copy(next.position);
            light.distance = next.distance;
            light.intensity = 0;
        }
    }

    function updateLights(position) {
        if (lightsDirty || position.distanceToSquared(lastLightPosition) > 1) {
            assignLights(position);
            lastLightPosition.copy(position);
            lightsDirty = false;
        }

        for (const light of lightPool) {
            light.intensity += (light.userData.target - light.intensity) * 0.12;
        }
    }

    function emergencyLight(x, z, color = 0xff3030, top = layout.height) {
        createBox(
            'Luminaria de emergencia',
            x, top - 0.75, z,
            1.1, 0.18, 0.35,
            getEmergencyMaterial(color)
        );

        addPointLight(color, 2.2, x, top - 1, z, 9);
    }

    // ==================================================
    // PAQUETES DE MUNICIÓN (2 draw calls en total, instanciados)
    // ==================================================

    const ammoPacks = [];
    let ammoMesh = null;
    let ammoGlow = null;
    const ammoDummy = new THREE.Object3D();

    function buildAmmoGeometry() {
        const parts = [];

        const add = (geometry, x, y, z, hex) => {
            const g = geometry.clone();
            g.translate(x, y, z);

            const c = new THREE.Color(hex);
            const n = g.attributes.position.count;
            const colors = new Float32Array(n * 3);

            for (let i = 0; i < n; i++) {
                colors[i * 3] = c.r;
                colors[i * 3 + 1] = c.g;
                colors[i * 3 + 2] = c.b;
            }

            g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            parts.push(g);
        };

        add(new THREE.BoxGeometry(0.5, 0.28, 0.32), 0, 0.14, 0, 0x4d6e33);
        add(new THREE.BoxGeometry(0.52, 0.06, 0.34), 0, 0.31, 0, 0x33481f);

        for (let i = -1; i <= 1; i++) {
            add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), i * 0.1, 0.46, 0, 0xe0b030);
        }

        const merged = mergeGeometries(parts, false);
        parts.forEach(part => part.dispose());

        return merged;
    }

    function createAmmoPacks(points) {
        if (!points.length) return;

        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            emissive: 0x24351a,
            emissiveIntensity: 1
        });

        ammoMesh = new THREE.InstancedMesh(buildAmmoGeometry(), material, points.length);
        ammoMesh.name = 'AMMO_PACKS';
        ammoMesh.frustumCulled = false;
        scene.add(ammoMesh);

        const glowGeometry = new THREE.CircleGeometry(0.6, 16);
        glowGeometry.rotateX(-Math.PI / 2);

        ammoGlow = new THREE.InstancedMesh(
            glowGeometry,
            new THREE.MeshBasicMaterial({
                color: 0x35ff93,
                transparent: true,
                opacity: 0.3,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            }),
            points.length
        );

        ammoGlow.name = 'AMMO_GLOW';
        ammoGlow.frustumCulled = false;
        scene.add(ammoGlow);

        points.forEach((p, index) => {
            ammoPacks.push({
                x: p.x,
                z: p.z,
                phase: index * 1.7,
                amount: AMMO_PER_PACK,
                taken: false
            });

            ammoDummy.position.set(p.x, 0.03, p.z);
            ammoDummy.rotation.set(0, 0, 0);
            ammoDummy.scale.setScalar(1);
            ammoDummy.updateMatrix();
            ammoGlow.setMatrixAt(index, ammoDummy.matrix);
        });

        ammoGlow.instanceMatrix.needsUpdate = true;
    }

    function updateAmmo(t) {
        if (!ammoMesh) return;

        for (let i = 0; i < ammoPacks.length; i++) {
            const pack = ammoPacks[i];

            // Reaparición del paquete tras AMMO_RESPAWN_SECONDS.
            if (pack.taken && t - pack.takenAt >= AMMO_RESPAWN_SECONDS) {
                pack.taken = false;

                ammoDummy.position.set(pack.x, 0.03, pack.z);
                ammoDummy.rotation.set(0, 0, 0);
                ammoDummy.scale.setScalar(1);
                ammoDummy.updateMatrix();
                ammoGlow.setMatrixAt(i, ammoDummy.matrix);
                ammoGlow.instanceMatrix.needsUpdate = true;
            }

            ammoDummy.position.set(pack.x, 0.28 + Math.sin(t * 2 + pack.phase) * 0.05, pack.z);
            ammoDummy.rotation.set(0, t * 1.2 + pack.phase, 0);
            ammoDummy.scale.setScalar(pack.taken ? 0 : 1);
            ammoDummy.updateMatrix();

            ammoMesh.setMatrixAt(i, ammoDummy.matrix);
        }

        ammoMesh.instanceMatrix.needsUpdate = true;
    }

    // Devuelve la munición recogida cerca de `position` (0 si no hay nada).
    function collectAmmoAt(position, radius = AMMO_PICKUP_RADIUS) {
        let total = 0;

        for (let i = 0; i < ammoPacks.length; i++) {
            const pack = ammoPacks[i];

            if (pack.taken) continue;

            const dx = pack.x - position.x;
            const dz = pack.z - position.z;

            if (dx * dx + dz * dz <= radius * radius) {
                pack.taken = true;
                total += pack.amount;
                pack.takenAt = performance.now() / 1000;

                // Ocultar el halo de este paquete.
                ammoDummy.position.set(pack.x, 0.03, pack.z);
                ammoDummy.rotation.set(0, 0, 0);
                ammoDummy.scale.setScalar(0);
                ammoDummy.updateMatrix();
                ammoGlow.setMatrixAt(i, ammoDummy.matrix);
                ammoGlow.instanceMatrix.needsUpdate = true;
            }
        }

        return total;
    }

    // ==================================================
    // BOTIQUINES (instanciados, un solo uso)
    // ==================================================

    const medkits = [];
    let medkitMesh = null;
    let medkitGlow = null;
    const medkitDummy = new THREE.Object3D();

    function buildMedkitGeometry() {
        const parts = [];

        const add = (geometry, x, y, z, hex) => {
            const g = geometry.clone();
            g.translate(x, y, z);

            const c = new THREE.Color(hex);
            const n = g.attributes.position.count;
            const colors = new Float32Array(n * 3);

            for (let i = 0; i < n; i++) {
                colors[i * 3] = c.r;
                colors[i * 3 + 1] = c.g;
                colors[i * 3 + 2] = c.b;
            }

            g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            parts.push(g);
        };

        // Caja blanca.
        add(new THREE.BoxGeometry(0.56, 0.32, 0.4), 0, 0.16, 0, 0xf2f2f2);

        // Cruz roja en la tapa.
        add(new THREE.BoxGeometry(0.34, 0.04, 0.1), 0, 0.34, 0, 0xd62020);
        add(new THREE.BoxGeometry(0.1, 0.04, 0.34), 0, 0.34, 0, 0xd62020);

        // Cruz roja en el frente y atrás.
        for (const z of [0.205, -0.205]) {
            add(new THREE.BoxGeometry(0.2, 0.06, 0.02), 0, 0.17, z, 0xd62020);
            add(new THREE.BoxGeometry(0.06, 0.2, 0.02), 0, 0.17, z, 0xd62020);
        }

        const merged = mergeGeometries(parts, false);
        parts.forEach(part => part.dispose());

        return merged;
    }

    function createMedkits(points) {
        if (!points.length) return;

        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            emissive: 0x3a1010,
            emissiveIntensity: 1
        });

        medkitMesh = new THREE.InstancedMesh(buildMedkitGeometry(), material, points.length);
        medkitMesh.name = 'MEDKITS';
        medkitMesh.frustumCulled = false;
        scene.add(medkitMesh);

        const glowGeometry = new THREE.CircleGeometry(0.65, 16);
        glowGeometry.rotateX(-Math.PI / 2);

        medkitGlow = new THREE.InstancedMesh(
            glowGeometry,
            new THREE.MeshBasicMaterial({
                color: 0xff4040,
                transparent: true,
                opacity: 0.3,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            }),
            points.length
        );

        medkitGlow.name = 'MEDKIT_GLOW';
        medkitGlow.frustumCulled = false;
        scene.add(medkitGlow);

        points.forEach((p, index) => {
            medkits.push({
                x: p.x,
                z: p.z,
                phase: index * 2.3,
                amount: MEDKIT_HEAL,
                taken: false
            });

            medkitDummy.position.set(p.x, 0.03, p.z);
            medkitDummy.rotation.set(0, 0, 0);
            medkitDummy.scale.setScalar(1);
            medkitDummy.updateMatrix();
            medkitGlow.setMatrixAt(index, medkitDummy.matrix);
        });

        medkitGlow.instanceMatrix.needsUpdate = true;
    }

    function updateMedkits(t) {
        if (!medkitMesh) return;

        for (let i = 0; i < medkits.length; i++) {
            const kit = medkits[i];

            medkitDummy.position.set(kit.x, 0.3 + Math.sin(t * 2 + kit.phase) * 0.05, kit.z);
            medkitDummy.rotation.set(0, t * 1.2 + kit.phase, 0);
            medkitDummy.scale.setScalar(kit.taken ? 0 : 1);
            medkitDummy.updateMatrix();

            medkitMesh.setMatrixAt(i, medkitDummy.matrix);
        }

        medkitMesh.instanceMatrix.needsUpdate = true;
    }

    // Devuelve la vida que da el botiquín recogido (0 si no hay ninguno cerca
    // o si `canUse` es false, por ejemplo con la vida llena).
    function collectMedkitAt(position, canUse = true, radius = MEDKIT_PICKUP_RADIUS) {
        if (!canUse) return 0;

        for (let i = 0; i < medkits.length; i++) {
            const kit = medkits[i];

            if (kit.taken) continue;

            const dx = kit.x - position.x;
            const dz = kit.z - position.z;

            if (dx * dx + dz * dz <= radius * radius) {
                kit.taken = true;

                medkitDummy.position.set(kit.x, 0.03, kit.z);
                medkitDummy.rotation.set(0, 0, 0);
                medkitDummy.scale.setScalar(0);
                medkitDummy.updateMatrix();
                medkitGlow.setMatrixAt(i, medkitDummy.matrix);
                medkitGlow.instanceMatrix.needsUpdate = true;

                return kit.amount;
            }
        }

        return 0;
    }

    // Al empezar una ronda: todos los paquetes y botiquines vuelven a estar
    // disponibles, y la munición por paquete sube AMMO_ROUND_BONUS por ronda.
    function resetPickups(round = 1) {
        const amount = AMMO_PER_PACK + AMMO_ROUND_BONUS * (round - 1);

        for (let i = 0; i < ammoPacks.length; i++) {
            const pack = ammoPacks[i];

            pack.taken = false;
            pack.amount = amount;

            if (ammoGlow) {
                ammoDummy.position.set(pack.x, 0.03, pack.z);
                ammoDummy.rotation.set(0, 0, 0);
                ammoDummy.scale.setScalar(1);
                ammoDummy.updateMatrix();
                ammoGlow.setMatrixAt(i, ammoDummy.matrix);
            }
        }

        if (ammoGlow) ammoGlow.instanceMatrix.needsUpdate = true;

        for (let i = 0; i < medkits.length; i++) {
            const kit = medkits[i];

            kit.taken = false;

            if (medkitGlow) {
                medkitDummy.position.set(kit.x, 0.03, kit.z);
                medkitDummy.rotation.set(0, 0, 0);
                medkitDummy.scale.setScalar(1);
                medkitDummy.updateMatrix();
                medkitGlow.setMatrixAt(i, medkitDummy.matrix);
            }
        }

        if (medkitGlow) medkitGlow.instanceMatrix.needsUpdate = true;

        return amount;
    }

    // ==================================================
    // ZONA DE EXTRACCIÓN (estado compartido)
    // ==================================================

    // `active` empieza en false: el faro está bloqueado hasta cumplir la meta de bajas.
    const extraction = { x: 0, z: 0, half: 3, beam: null, ring: null, active: false, pad: null };

    // true cuando `position` está dentro del área amarilla de extracción.
    function isInExtraction(position) {
        return (
            extraction.active &&
            Math.abs(position.x - extraction.x) <= extraction.half &&
            Math.abs(position.z - extraction.z) <= extraction.half
        );
    }

    // Activa o bloquea el faro: rojo y apagado = bloqueado, verde y pulsante = activo.
    function setExtractionActive(active) {
        extraction.active = active;

        const hex = active ? 0x35ff93 : 0xff3030;

        if (extraction.beam) {
            extraction.beam.material.color.setHex(hex);
            extraction.ring.material.color.setHex(hex);
        }
    }

    // Punto válido para un zombi: dentro de una sala/pasillo con margen
    // respecto a los bordes y sin chocar con nada.
    function isSafeSpawn(x, z, radius = 0.8, margin = 1.5) {
        let inside = false;

        for (const r of walkRects) {
            if (
                x >= r.minX + margin && x <= r.maxX - margin &&
                z >= r.minZ + margin && z <= r.maxZ - margin
            ) {
                inside = true;
                break;
            }
        }

        return inside && !collidesWithWorld(new THREE.Vector3(x, 0, z), radius);
    }

    // Punto de suelo libre, alejado de `avoid`, para reponer zombis durante la partida.
    function pickSpawnPoint(avoid, minDistance = 18) {
        if (!walkRects.length) return null;

        for (let tries = 0; tries < 50; tries++) {
            const rect = walkRects[Math.floor(Math.random() * walkRects.length)];

            const spanX = rect.maxX - rect.minX - 4;
            const spanZ = rect.maxZ - rect.minZ - 4;

            if (spanX <= 0 || spanZ <= 0) continue;

            const x = rect.minX + 2 + Math.random() * spanX;
            const z = rect.minZ + 2 + Math.random() * spanZ;

            if (Math.hypot(x - avoid.x, z - avoid.z) < minDistance) continue;
            if (extraction.pad && pointInRect(extraction.pad, x, z)) continue;

            if (!isSafeSpawn(x, z)) continue;

            return new THREE.Vector3(x, 0, z);
        }

        return null;
    }

    // Se engancha al render para no depender del bucle del juego.
    const baseRender = renderer.render.bind(renderer);

    renderer.render = function (targetScene, targetCamera) {
        const t = performance.now() / 1000;

        decorTime.value = t;

        updateVisibility(targetCamera.position);
        updateLights(targetCamera.position);
        updateAmmo(t);
        updateMedkits(t);

        if (extraction.beam) {
            extraction.beam.material.opacity = extraction.active
                ? 0.2 + Math.sin(t * 2) * 0.07
                : 0.06;
            extraction.ring.material.opacity = extraction.active
                ? 0.55 + Math.sin(t * 3) * 0.25
                : 0.2;
        }

        baseRender(targetScene, targetCamera);
    };

    // ==================================================
    // CARGA DE MODELOS GLB
    // ==================================================

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    const modelCache = new Map();

    function prepareModelMaterials(model) {
        model.traverse(child => {
            if (!child.isMesh) return;

            child.castShadow = false;
            child.receiveShadow = false;
            child.frustumCulled = true;

            if (Array.isArray(child.material)) {
                child.material = child.material.map(material => {
                    const cheap = toCheapMaterial(material);
                    if (GLB_DOUBLE_SIDE && cheap) cheap.side = THREE.DoubleSide;
                    return cheap;
                });
            } else if (child.material) {
                child.material = toCheapMaterial(child.material);
                if (GLB_DOUBLE_SIDE) child.material.side = THREE.DoubleSide;
            }
        });
    }

    async function loadModelInstance(filename) {
        try {
            let source = modelCache.get(filename);

            if (!source) {
                const gltf = await loader.loadAsync(
                    ASSET_PATH + encodeURIComponent(filename)
                );

                source = gltf.scene;
                modelCache.set(filename, source);
            }

            const model = source.clone(true);
            model.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(model);

            if (box.isEmpty()) {
                throw new Error('El modelo GLB no contiene geometría.');
            }

            prepareModelMaterials(model);

            return model;
        } catch (error) {
            console.error(`[KENNEY] Error cargando ${filename}:`, error);
            return null;
        }
    }

    function placeModel(model, x, y, z, rotation = 0) {
        model.rotation.y = rotation;
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();

        box.getCenter(center);

        model.position.set(x - center.x, y - box.min.y, z - center.z);
        model.updateMatrixWorld(true);

        return new THREE.Box3().setFromObject(model);
    }

    // ---- Fusión de las mallas de un GLB: de cientos de draw calls a uno por material ----

    function attrToFloat(attr, itemSize, count) {
        const out = new Float32Array(count * itemSize);

        for (let i = 0; i < count; i++) {
            out[i * itemSize] = attr.getX(i);
            if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
            if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
        }

        return new THREE.BufferAttribute(out, itemSize);
    }

    function prepareForMerge(source, withColor) {
        const g = new THREE.BufferGeometry();
        const position = source.attributes.position;
        const count = position.count;

        g.setAttribute('position', attrToFloat(position, 3, count));

        if (source.index) {
            g.setIndex(new THREE.BufferAttribute(new Uint32Array(source.index.array), 1));
        } else {
            const index = new Uint32Array(count);
            for (let i = 0; i < count; i++) index[i] = i;
            g.setIndex(new THREE.BufferAttribute(index, 1));
        }

        if (source.attributes.normal) {
            g.setAttribute('normal', attrToFloat(source.attributes.normal, 3, count));
        } else {
            g.computeVertexNormals();
        }

        if (source.attributes.uv) {
            g.setAttribute('uv', attrToFloat(source.attributes.uv, 2, count));
        } else {
            g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }

        if (withColor) {
            if (source.attributes.color) {
                g.setAttribute('color', attrToFloat(source.attributes.color, 3, count));
            } else {
                g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
            }
        }

        return g;
    }

    // Convierte el modelo en pocas mallas fusionadas dentro de `group`.
    // El modelo original NO se dibuja, pero sus mallas siguen sirviendo para colisiones.
    function bakeModel(model, group) {
        model.updateMatrixWorld(true);

        const buckets = new Map();
        const leftovers = [];

        model.traverse(object => {
            if (!object.isMesh) return;

            const material = object.material;
            const geometry = object.geometry;

            if (
                object.isSkinnedMesh ||
                object.isInstancedMesh ||
                Array.isArray(material) ||
                !geometry?.attributes?.position ||
                geometry.morphAttributes?.position
            ) {
                leftovers.push(object);
                return;
            }

            const prepared = prepareForMerge(geometry, !!material.vertexColors);
            prepared.applyMatrix4(object.matrixWorld);

            let bucket = buckets.get(material);

            if (!bucket) {
                bucket = [];
                buckets.set(material, bucket);
            }

            bucket.push({ geometry: prepared, source: object });
        });

        let merges = 0;

        for (const [material, entries] of buckets) {
            const merged = mergeGeometries(entries.map(entry => entry.geometry), false);

            entries.forEach(entry => entry.geometry.dispose());

            if (!merged) {
                entries.forEach(entry => leftovers.push(entry.source));
                continue;
            }

            merged.computeBoundingSphere();

            const mesh = new THREE.Mesh(merged, material);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();

            group.add(mesh);
            merges++;
        }

        for (const object of leftovers) {
            const clone = new THREE.Mesh(object.geometry, object.material);

            object.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
            clone.updateMatrix();
            clone.matrixAutoUpdate = false;

            group.add(clone);
        }

        return { merges, leftovers: leftovers.length };
    }

    // ==================================================
    // ANÁLISIS DE MODELOS
    // ==================================================

    function analyzeModel(model) {
        let floorMesh = null;
        let floorScore = 0;
        let wallMesh = null;
        let wallScore = 0;

        const box = new THREE.Box3();
        const size = new THREE.Vector3();

        model.traverse(object => {
            if (!object.isMesh) return;

            box.setFromObject(object);
            box.getSize(size);

            if (size.y < 0.6 && box.max.y < 0.8) {
                const area = size.x * size.z;

                if (area > floorScore) {
                    floorScore = area;
                    floorMesh = object;
                }
            } else if (size.y > 1.2) {
                const score = size.y * Math.max(size.x, size.z);

                if (score > wallScore) {
                    wallScore = score;
                    wallMesh = object;
                }
            }
        });

        let wallTop = null;

        if (wallMesh) {
            box.setFromObject(wallMesh);
            wallTop = box.max.y;
        }

        return { floorMesh, wallMesh, wallTop };
    }

    function collectMeshColliders(model) {
        const box = new THREE.Box3();
        let count = 0;

        model.traverse(object => {
            if (!object.isMesh) return;

            box.setFromObject(object);

            if (
                box.max.y - box.min.y > 0.5 &&
                box.min.y < COLLISION_RAY_HEIGHT &&
                box.max.y > COLLISION_RAY_HEIGHT
            ) {
                meshColliders.push({ mesh: object, box: box.clone() });
                count++;
            }
        });

        return count;
    }

    const upRaycaster = new THREE.Raycaster();
    const UP = new THREE.Vector3(0, 1, 0);

    function modelHasCeiling(room) {
        const meshes = [];

        room.model.traverse(object => {
            if (object.isMesh) meshes.push(object);
        });

        const top = room.box.max.y;
        const w = room.w;
        const d = room.d;

        const points = [
            [0, 0],
            [w / 4, d / 4],
            [-w / 4, d / 4],
            [w / 4, -d / 4],
            [-w / 4, -d / 4]
        ];

        upRaycaster.near = 0;
        upRaycaster.far = top * 2;

        for (const [dx, dz] of points) {
            upRaycaster.set(
                new THREE.Vector3(room.cx + dx, 1.0, room.cz + dz),
                UP
            );

            const hits = upRaycaster.intersectObjects(meshes, false);

            if (hits.some(hit => hit.point.y > top * 0.6)) return true;
        }

        return false;
    }

    // ==================================================
    // PAREDES (siempre generadas desde el perímetro real)
    // ==================================================

    function buildWallSegment(axis, line, outward, start, end, name, H) {
        const T = MAP.wallThickness;
        const length = end - start;

        if (length < 0.2) return;

        const mid = (start + end) / 2;
        const center = line + outward * (T / 2);

        const random = mulberry32(20261112 + Math.floor(Math.abs(mid * 13 + line * 29)));
        const rr = (a, b) => a + random() * (b - a);

        if (axis === 'z') {
            createBox(`Pared ${name}`, mid, H / 2, center, length, H, T, palette.wall, true);
        } else {
            createBox(`Pared ${name}`, center, H / 2, mid, T, H, length, palette.wall, true);
        }

        const face = (along, y, w, h, material, offset) => {
            const p = line - outward * offset;

            if (axis === 'z') {
                createBox('Detalle pared', along, y, p, w, h, 0.025, material);
            } else {
                createBox('Detalle pared', p, y, along, 0.025, h, w, material);
            }
        };

        face(mid, 0.12, length, 0.24, palette.darkMetal, 0.03);

        const patchCount = Math.max(2, Math.floor(length / 3));

        for (let i = 0; i < patchCount; i++) {
            face(
                rr(start + 0.4, end - 0.4),
                rr(0.5, H - 0.8),
                rr(0.3, 1.5),
                rr(0.2, 1.2),
                random() < 0.5 ? palette.damagedConcrete : palette.exposedConcrete,
                0.014
            );
        }

        const streaks = Math.max(1, Math.floor(length / 5));

        for (let i = 0; i < streaks; i++) {
            const h = rr(0.7, H * 0.55);

            face(rr(start + 0.5, end - 0.5), h / 2, rr(0.08, 0.25), h, palette.wetConcrete, 0.02);
        }

        face(rr(start + 0.5, end - 0.5), 0.3, rr(0.5, 1.4), 0.25, palette.rust, 0.025);

        if (length > 4 && random() < 0.35) {
            const y = rr(2.6, Math.max(2.8, H - 1));
            const p = line - outward * 0.16;
            const radius = 0.08;

            if (axis === 'z') {
                addStatic(unitCylinder, palette.darkMetal, mid, y, p, radius, length - 0.3, radius, 0, 0, Math.PI / 2);
            } else {
                addStatic(unitCylinder, palette.darkMetal, p, y, mid, radius, length - 0.3, radius, Math.PI / 2, 0, 0);
            }
        }
    }

    function buildPerimeter() {
        const T = MAP.wallThickness;

        const insideOther = (x, z, skip) => {
            for (const other of walkRects) {
                if (other !== skip && pointInRect(other, x, z, 0.01)) return true;
            }

            return false;
        };

        let segments = 0;

        for (const rect of walkRects) {
            useSpace(rect);

            const edges = [
                { axis: 'z', line: rect.minZ, out: -1, a: rect.minX, b: rect.maxX },
                { axis: 'z', line: rect.maxZ, out: 1, a: rect.minX, b: rect.maxX },
                { axis: 'x', line: rect.minX, out: -1, a: rect.minZ, b: rect.maxZ },
                { axis: 'x', line: rect.maxX, out: 1, a: rect.minZ, b: rect.maxZ }
            ];

            for (const edge of edges) {
                const probe = (along, offset) => {
                    const normal = edge.line + edge.out * offset;

                    return edge.axis === 'z'
                        ? insideOther(along, normal, rect)
                        : insideOther(normal, along, rect);
                };

                const steps = Math.max(1, Math.ceil((edge.b - edge.a) / SEAL_STEP));
                const stepSize = (edge.b - edge.a) / steps;

                let runStart = null;

                const closeRun = runEnd => {
                    if (runStart === null) return;

                    let s = runStart;
                    let e = runEnd;

                    if (edge.axis === 'z') {
                        if (s === edge.a && !probe(edge.a - 0.2, 0.05)) s -= T;
                        if (e === edge.b && !probe(edge.b + 0.2, 0.05)) e += T;
                    }

                    buildWallSegment(edge.axis, edge.line, edge.out, s, e, rect.name, rect.wallH);
                    segments++;
                    runStart = null;
                };

                for (let i = 0; i < steps; i++) {
                    const t0 = edge.a + i * stepSize;
                    const t1 = t0 + stepSize;
                    const open = probe((t0 + t1) / 2, 0.35);

                    if (!open && runStart === null) runStart = t0;
                    if (open) closeRun(t0);
                }

                closeRun(edge.b);
            }
        }

        useSpace(null);

        console.log(`[SELLADO] ${segments} tramos de pared generados en el perímetro.`);
    }

    // ==================================================
    // ESPACIOS RELLENOS (suelo, techo y detalles; SIN paredes)
    // ==================================================

    function buildSpace(rect) {
        useSpace(rect);

        const { name, minX, maxX, minZ, maxZ, top } = rect;

        const width = maxX - minX;
        const depth = maxZ - minZ;
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;

        const random = mulberry32(20261112 + Math.floor(Math.abs(cx * 17 + cz * 31)));
        const rr = (a, b) => a + random() * (b - a);

        createBox(`Suelo ${name}`, cx, -0.15, cz, width, 0.3, depth, palette.floor);

        const stainCount = Math.max(3, Math.floor(width * depth / 35));

        for (let i = 0; i < stainCount; i++) {
            const radius = rr(0.3, 1.3);

            addStatic(
                unitCircle,
                random() < 0.5 ? palette.damagedConcrete : palette.wetConcrete,
                rr(minX + 0.7, maxX - 0.7),
                0.006,
                rr(minZ + 0.7, maxZ - 0.7),
                radius * rr(0.7, 1.5),
                1,
                radius * rr(0.7, 1.4),
                0,
                rr(0, Math.PI),
                0
            );
        }

        const crackCount = Math.max(3, Math.floor((width + depth) / 5));

        for (let i = 0; i < crackCount; i++) {
            createBox(
                `Grieta ${name}`,
                rr(minX + 0.5, maxX - 0.5),
                0.008,
                rr(minZ + 0.5, maxZ - 0.5),
                rr(0.5, 2.4),
                0.012,
                rr(0.025, 0.06),
                palette.crack,
                false,
                0,
                rr(0, Math.PI),
                0
            );
        }

        const rubbleCount = Math.max(4, Math.floor((width + depth) / 2.5));

        for (let i = 0; i < rubbleCount; i++) {
            const side = Math.floor(random() * 4);
            let x, z;

            if (side === 0) {
                x = rr(minX + 0.4, maxX - 0.4);
                z = minZ + rr(0.3, 1.1);
            } else if (side === 1) {
                x = rr(minX + 0.4, maxX - 0.4);
                z = maxZ - rr(0.3, 1.1);
            } else if (side === 2) {
                x = minX + rr(0.3, 1.1);
                z = rr(minZ + 0.4, maxZ - 0.4);
            } else {
                x = maxX - rr(0.3, 1.1);
                z = rr(minZ + 0.4, maxZ - 0.4);
            }

            const sy = rr(0.08, 0.3);

            createBox(
                `Escombro ${name}`,
                x, sy / 2, z,
                rr(0.12, 0.45), sy, rr(0.12, 0.45),
                random() < 0.4 ? palette.exposedConcrete : palette.debris,
                false,
                rr(-0.3, 0.3), rr(0, Math.PI), rr(-0.3, 0.3)
            );
        }

        createBox(`Techo ${name}`, cx, top - 0.15, cz, width, 0.3, depth, palette.ceiling);

        const damagedPanels = Math.max(1, Math.floor(width * depth / 100));

        for (let i = 0; i < damagedPanels; i++) {
            createBox(
                `Hueco techo ${name}`,
                rr(minX + 1, maxX - 1),
                top - 0.305,
                rr(minZ + 1, maxZ - 1),
                rr(1, 2.5), 0.025, rr(0.8, 2),
                palette.ceilingDark,
                false,
                0, rr(-0.2, 0.2), 0
            );
        }

        const alongX = width >= depth;
        const longLength = alongX ? width : depth;
        const beamCount = Math.max(1, Math.floor(longLength / 6));

        for (let i = 0; i < beamCount; i++) {
            const t = (i + 0.5) / beamCount;

            if (alongX) {
                createBox(
                    `Viga ${name}`,
                    minX + t * width, top - 0.45, cz,
                    0.13, 0.18, depth - 0.2,
                    palette.darkMetal
                );
            } else {
                createBox(
                    `Viga ${name}`,
                    cx, top - 0.45, minZ + t * depth,
                    width - 0.2, 0.18, 0.13,
                    palette.darkMetal
                );
            }
        }

        if (random() > 0.45) {
            createBox(
                `Panel luminoso ${name}`,
                cx, top - 0.335, cz,
                Math.min(width * 0.3, 4), 0.07, Math.min(depth * 0.3, 4),
                materials.lightPanel
            );
        }

        addPointLight(
            random() < 0.5 ? 0x5b9b9b : 0x7796a0,
            1.1,
            cx, top - 1, cz,
            Math.max(width, depth) * 1.1
        );

        if (random() > 0.45) {
            addPointLight(
                0xff542c,
                1.6,
                rr(minX + 1, maxX - 1),
                top - 0.8,
                rr(minZ + 1, maxZ - 1),
                8
            );
        }

        useSpace(null);
    }

    // ==================================================
    // EQUIPAMIENTO CIENTÍFICO
    // ==================================================

    function createLaboratoryEquipment(x, z) {
        createBox('Mesa de laboratorio', x, 1.1, z, 3.5, 0.25, 1.5, materials.metal, true);

        for (const dx of [-1.45, 1.45]) {
            for (const dz of [-0.55, 0.55]) {
                createBox('Pata de mesa', x + dx, 0.5, z + dz, 0.15, 1, 0.15, materials.dark);
            }
        }

        createBox('Equipo de análisis', x, 1.9, z, 1.3, 1.1, 0.9, materials.white);
        createBox('Pantalla científica', x, 2.65, z - 0.15, 0.85, 0.55, 0.08, materials.glass);
    }

    function createContainmentPod(x, z) {
        createCylinder('Base cámara de contención', x, 0.35, z, 1.45, 0.7, materials.dark, true);

        addStatic(unitTube, materials.glass, x, 2.3, z, 1.1, 3.2, 1.1);

        createCylinder('Tapa superior cápsula', x, 4, z, 1.15, 0.25, materials.metal);
    }

    function createStorageCrate(x, z, material = materials.rusty) {
        createBox('Caja de suministros', x, 1, z, 2.2, 2, 2.2, material, true);

        for (let i = -1; i <= 1; i++) {
            createBox('Refuerzo de caja', x + i * 0.7, 1, z - 1.12, 0.1, 1.9, 0.1, materials.metal);
        }
    }

    function createBarrel(x, z) {
        createCylinder('Barril químico', x, 0.85, z, 0.55, 1.7, materials.green, true);
        createCylinder('Tapa barril', x, 1.73, z, 0.57, 0.12, materials.metal);
    }

    function createWarningSign(x, z) {
        createBox('Panel de advertencia', x, 2.5, z, 1.7, 1.2, 0.12, materials.yellow);
        createBox('Símbolo de peligro', x, 2.5, z - 0.08, 0.65, 0.65, 0.05, materials.black);
    }

    // Sala de extracción completa: plataforma, guías en el suelo, pilares con luz,
    // estación de radio, suministros y un haz de luz pulsante.
    function createExtractionZone(x, z, room) {
        extraction.x = x;
        extraction.z = z;

        const r = room.rect;
        const green = getEmergencyMaterial(0x35ff93);

        createBox('Plataforma de extracción', x, 0.1, z, 9, 0.25, 9, materials.dark);
        createBox('Zona de extracción', x, 0.25, z, 6, 0.08, 6, materials.yellow);
        createBox('Marcador de extracción', x, 0.32, z, 0.7, 0.06, 3.5, materials.white);
        createBox('Marcador de extracción', x, 0.32, z, 3.5, 0.06, 0.7, materials.white);

        // Chevrones que guían desde la entrada (lado +Z, hacia el distribuidor).
        for (let i = 0; i < 4; i++) {
            const cz = z + 5.6 + i * 1.5;
            if (cz > r.maxZ - 1) break;

            createBox('Chevron', x - 0.55, 0.03, cz, 1.4, 0.04, 0.3, materials.yellow, false, 0, 0.6, 0);
            createBox('Chevron', x + 0.55, 0.03, cz, 1.4, 0.04, 0.3, materials.yellow, false, 0, -0.6, 0);
        }

        // Pilares con luz en las esquinas de la plataforma.
        for (const sx of [-4.2, 4.2]) {
            for (const sz of [-4.2, 4.2]) {
                createBox('Pilar', x + sx, 1.5, z + sz, 0.35, 3, 0.35, materials.metal, true);
                createBox('Luz de pilar', x + sx, 3.1, z + sz, 0.5, 0.25, 0.5, green);
            }
        }

        // Estación de radio al fondo.
        const rz = r.minZ + 1.6;

        createBox('Mesa de radio', x - 6, 0.6, rz, 2.4, 1.2, 1, materials.dark, true);
        createBox('Radio', x - 6, 1.45, rz, 1.2, 0.5, 0.6, materials.white);
        createBox('Antena', x - 6.5, 2.4, rz, 0.06, 1.8, 0.06, materials.metal);
        createBox('Luz de radio', x - 5.6, 1.5, rz + 0.32, 0.12, 0.12, 0.05, green);

        // Suministros y ambientación en las esquinas.
        createStorageCrate(r.minX + 2.2, r.minZ + 2.2);
        createStorageCrate(r.maxX - 2.2, r.minZ + 2.2, materials.yellow);
        createBarrel(r.maxX - 1.6, r.minZ + 5);
        createBarrel(r.minX + 1.6, r.minZ + 5);
        createWarningSign(x + 6, r.minZ + 0.9);

        addPointLight(0x35ff93, 5, x, 4, z, 22);

        // Haz de luz y anillo (sólo se anima la opacidad: el grupo queda congelado).
        const beamMaterial = new THREE.MeshBasicMaterial({
            color: 0x35ff93,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        });

        const beamHeight = Math.max(layout.height - 0.3, 4);

        extraction.beam = new THREE.Mesh(
            new THREE.CylinderGeometry(1.5, 1.5, beamHeight, 20, 1, true),
            beamMaterial
        );
        extraction.beam.position.set(x, beamHeight / 2, z);
        extraction.beam.matrixAutoUpdate = false;
        extraction.beam.updateMatrix();
        r.group.add(extraction.beam);

        const ringGeometry = new THREE.RingGeometry(2.6, 3, 40);
        ringGeometry.rotateX(-Math.PI / 2);

        extraction.ring = new THREE.Mesh(
            ringGeometry,
            new THREE.MeshBasicMaterial({
                color: 0x35ff93,
                transparent: true,
                opacity: 0.6,
                depthWrite: false
            })
        );
        extraction.ring.position.set(x, 0.4, z);
        extraction.ring.matrixAutoUpdate = false;
        extraction.ring.updateMatrix();
        r.group.add(extraction.ring);

        setExtractionActive(false);
    }

    // ==================================================
    // CONSTRUCCIÓN DEL LABORATORIO
    // ==================================================

    const spawns = {
        playerStart: new THREE.Vector3(0, CONFIG.PLAYER_EYE_HEIGHT || 1.7, 5),
        zombieSpawns: []
    };

    function clampOffset(value, half, margin = 2) {
        const limit = Math.max(half - margin, 0);
        return Math.max(-limit, Math.min(limit, value));
    }

    function fits(room, dx, dz, margin) {
        return (
            Math.abs(dx) <= room.w / 2 - margin &&
            Math.abs(dz) <= room.d / 2 - margin
        );
    }

    function decorate(room, dx, dz, margin, build) {
        if (!fits(room, dx, dz, margin)) return;

        useSpace(room.rect);
        build(room.cx + dx, room.cz + dz);
        useSpace(null);
    }

    const extrasGroup = new THREE.Group();
    extrasGroup.name = 'Extras';
    scene.add(extrasGroup);

    const ready = (async () => {
        console.log('[LABORATORIO] Cargando modelos GLB...');

        try {
            // 1. Cargar los siete módulos.
            const rooms = {};

            await Promise.all(SECTORS.map(async sector => {
                const model = await loadModelInstance(sector.model);

                const room = {
                    key: sector.key,
                    name: sector.name,
                    file: sector.model,
                    model,
                    w: MAP.fallbackRoomSize,
                    d: MAP.fallbackRoomSize,
                    h: MAP.fallbackHeight,
                    cx: 0,
                    cz: 0,
                    box: null,
                    wallTop: null,
                    top: MAP.fallbackHeight,
                    analysis: null,
                    rect: null
                };

                if (model) {
                    model.rotation.y = 0;
                    model.position.set(0, 0, 0);
                    model.updateMatrixWorld(true);

                    const size = new THREE.Vector3();

                    new THREE.Box3().setFromObject(model).getSize(size);

                    room.w = size.x;
                    room.d = size.z;
                    room.h = size.y;
                }

                rooms[sector.key] = room;
            }));

            // 2. Distribución de salas.
            const R = rooms;

            R.acceso.cx = 0;
            R.acceso.cz = 0;

            R.seguridad.cx = 0;
            R.seguridad.cz =
                R.acceso.cz - R.acceso.d / 2 -
                GAP_VERTICAL - R.seguridad.d / 2;

            R.experimentacion.cx = 0;
            R.experimentacion.cz =
                R.seguridad.cz - R.seguridad.d / 2 -
                GAP_VERTICAL - R.experimentacion.d / 2;

            R.investigacion.cx =
                R.experimentacion.cx - R.experimentacion.w / 2 -
                GAP_SIDE - R.investigacion.w / 2;

            R.investigacion.cz = R.experimentacion.cz;

            R.contencion.cx =
                R.experimentacion.cx + R.experimentacion.w / 2 +
                GAP_SIDE + R.contencion.w / 2;

            R.contencion.cz = R.experimentacion.cz;

            const hallTop = R.experimentacion.cz - R.experimentacion.d / 2;
            const hallBottom = hallTop - HALL_DEPTH;

            R.almacen.cx = -(R.almacen.w / 2 + 3);
            R.almacen.cz = hallBottom - R.almacen.d / 2;

            R.extraccion.cx = R.extraccion.w / 2 + 3;
            R.extraccion.cz = hallBottom - R.extraccion.d / 2;

            // 3. Colocar y analizar modelos (no se añaden a la escena: se fusionan después).
            const roomList = Object.values(R);

            let maxTop = 0;

            for (const room of roomList) {
                if (room.model) {
                    room.box = placeModel(room.model, room.cx, 0, room.cz);

                    room.w = room.box.max.x - room.box.min.x;
                    room.d = room.box.max.z - room.box.min.z;
                    room.h = room.box.max.y;

                    room.analysis = analyzeModel(room.model);
                    room.wallTop = room.analysis.wallTop || room.box.max.y;
                    room.top = room.wallTop;
                } else {
                    room.box = new THREE.Box3(
                        new THREE.Vector3(room.cx - room.w / 2, 0, room.cz - room.d / 2),
                        new THREE.Vector3(room.cx + room.w / 2, room.h, room.cz + room.d / 2)
                    );

                    room.top = room.h;
                }

                maxTop = Math.max(maxTop, room.top);

                room.rect = addRect(
                    room.name,
                    room.box.min.x,
                    room.box.max.x,
                    room.box.min.z,
                    room.box.max.z,
                    room.top,
                    'room'
                );
            }

            layout.height = maxTop || MAP.fallbackHeight;

            // 4. Paleta de colores desde Acceso.
            const base = R.acceso.analysis;

            if (base) {
                const wallColor = base.wallMesh
                    ? sampleMeshColor(base.wallMesh)
                    : palette.wall.color.clone();

                const floorColor = base.floorMesh
                    ? sampleMeshColor(base.floorMesh)
                    : wallColor.clone().multiplyScalar(0.6);

                palette.wall.color.copy(wallColor);
                palette.floor.color.copy(floorColor);
                palette.ceiling.color.copy(wallColor.clone().multiplyScalar(0.75));

                console.log('[PALETA]', {
                    pared: '#' + wallColor.getHexString(),
                    piso: '#' + floorColor.getHexString(),
                    techo: '#' + palette.ceiling.color.getHexString(),
                    alturaMax: +layout.height.toFixed(2)
                });
            }

            // 5. Colisiones, fusión de modelos, techos y salas de respaldo.
            for (const room of roomList) {
                if (room.model) {
                    const count = collectMeshColliders(room.model);

                    if (!modelHasCeiling(room)) {
                        const b = room.box;
                        const width = b.max.x - b.min.x;
                        const depth = b.max.z - b.min.z;

                        useSpace(room.rect);

                        createBox(
                            `Techo ${room.name}`,
                            room.cx, room.top + 0.15, room.cz,
                            width, 0.3, depth,
                            palette.ceiling
                        );

                        createBox(
                            `Panel luminoso ${room.name}`,
                            room.cx, room.top - 0.05, room.cz,
                            Math.min(width * 0.4, 6), 0.1, Math.min(depth * 0.4, 6),
                            materials.lightPanel
                        );

                        useSpace(null);
                    }

                    const baked = bakeModel(room.model, room.rect.group);

                    console.log(`[SALA] ${room.name} (${room.file})`, {
                        tamano: [+room.w.toFixed(2), +room.d.toFixed(2), +room.h.toFixed(2)],
                        centro: [+room.cx.toFixed(2), +room.cz.toFixed(2)],
                        mallasConColision: count,
                        mallasFusionadas: baked.merges,
                        sinFusionar: baked.leftovers
                    });
                } else {
                    buildSpace(room.rect);
                }
            }

            // 6. Pasillos y distribuidor.
            const corridors = [];

            const addSpace = (name, minX, maxX, minZ, maxZ, neighbours) => {
                const top = Math.min(...neighbours.map(room => room.top));
                const rect = addRect(name, minX, maxX, minZ, maxZ, top, 'corridor');

                corridors.push(rect);
                buildSpace(rect);

                return rect;
            };

            const cwNS = (a, b) => Math.min(CORRIDOR_WIDTH, a.w - 1, b.w - 1) / 2;
            const cwEW = (a, b) => Math.min(CORRIDOR_WIDTH, a.d - 1, b.d - 1) / 2;

            {
                const half = cwNS(R.acceso, R.seguridad);

                addSpace(
                    'Pasillo Acceso-Seguridad',
                    -half, half,
                    R.seguridad.cz + R.seguridad.d / 2,
                    R.acceso.cz - R.acceso.d / 2,
                    [R.acceso, R.seguridad]
                );
            }

            {
                const half = cwNS(R.seguridad, R.experimentacion);

                addSpace(
                    'Pasillo Seguridad-Experimentación',
                    -half, half,
                    R.experimentacion.cz + R.experimentacion.d / 2,
                    R.seguridad.cz - R.seguridad.d / 2,
                    [R.seguridad, R.experimentacion]
                );
            }

            {
                const half = cwEW(R.investigacion, R.experimentacion);

                addSpace(
                    'Pasillo Investigación-Experimentación',
                    R.investigacion.cx + R.investigacion.w / 2,
                    R.experimentacion.cx - R.experimentacion.w / 2,
                    R.experimentacion.cz - half,
                    R.experimentacion.cz + half,
                    [R.investigacion, R.experimentacion]
                );
            }

            {
                const half = cwEW(R.experimentacion, R.contencion);

                addSpace(
                    'Pasillo Experimentación-Contención',
                    R.experimentacion.cx + R.experimentacion.w / 2,
                    R.contencion.cx - R.contencion.w / 2,
                    R.experimentacion.cz - half,
                    R.experimentacion.cz + half,
                    [R.experimentacion, R.contencion]
                );
            }

            addSpace(
                'Distribuidor central',
                R.almacen.cx - 4,
                R.extraccion.cx + 4,
                hallBottom,
                hallTop,
                [R.experimentacion, R.almacen, R.extraccion]
            );

            linkNeighbors();

            // 6b. SELLADO: paredes en todo el perímetro que no conecte con otro espacio.
            buildPerimeter();

            // Base oscura bajo todo el conjunto: nunca se ve el vacío.
            {
                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

                for (const rect of walkRects) {
                    minX = Math.min(minX, rect.minX);
                    maxX = Math.max(maxX, rect.maxX);
                    minZ = Math.min(minZ, rect.minZ);
                    maxZ = Math.max(maxZ, rect.maxZ);
                }

                useSpace(null);

                createBox(
                    'Base exterior',
                    (minX + maxX) / 2, -0.6, (minZ + maxZ) / 2,
                    maxX - minX + 60, 0.2, maxZ - minZ + 60,
                    materials.black
                );
            }

            // 7. Equipamiento de las salas.
            decorate(R.investigacion, -3, -4, 2.5, createLaboratoryEquipment);
            decorate(R.investigacion, -3, 4, 2.5, createLaboratoryEquipment);

            decorate(R.experimentacion, -4, 4, 2.5, createLaboratoryEquipment);
            decorate(R.experimentacion, 4, -4, 2.5, createLaboratoryEquipment);

            decorate(R.contencion, -5, 2, 2.5, createContainmentPod);
            decorate(R.contencion, 3, 2, 2.5, createContainmentPod);
            decorate(R.contencion, -5, -5, 2.5, createContainmentPod);
            decorate(R.contencion, 3, -5, 2.5, createContainmentPod);

            decorate(R.almacen, -4, 4, 2, (x, z) => createStorageCrate(x, z));
            decorate(R.almacen, 2, 4, 2, (x, z) => createStorageCrate(x, z));
            decorate(R.almacen, -4, -3, 2, (x, z) => createStorageCrate(x, z, materials.yellow));
            decorate(R.almacen, 2, -3, 2, (x, z) => createStorageCrate(x, z));

            decorate(R.experimentacion, -4, -6, 1.5, createBarrel);
            decorate(R.experimentacion, -7, -6, 1.5, createBarrel);
            decorate(R.experimentacion, 4, -6, 1.5, createBarrel);
            decorate(R.experimentacion, 7, -6, 1.5, createBarrel);

            decorate(R.seguridad, -5, 2, 1, createWarningSign);
            decorate(R.contencion, 5, 0, 1, createWarningSign);
            decorate(R.almacen, -5, 0, 1, createWarningSign);

            decorate(R.acceso, -5, -5, 1, (x, z) => emergencyLight(x, z, 0xff3030, R.acceso.top));
            decorate(R.seguridad, 5, 0, 1, (x, z) => emergencyLight(x, z, 0xff3030, R.seguridad.top));
            decorate(R.investigacion, -5, 0, 1, (x, z) => emergencyLight(x, z, 0xff3030, R.investigacion.top));
            decorate(R.contencion, 5, 0, 1, (x, z) => emergencyLight(x, z, 0xff3030, R.contencion.top));
            decorate(R.almacen, -5, 0, 1, (x, z) => emergencyLight(x, z, 0xff3030, R.almacen.top));

            // Sala de extracción completa.
            useSpace(R.extraccion.rect);
            createExtractionZone(R.extraccion.cx, R.extraccion.cz, R.extraccion);
            useSpace(null);

            // 8. Extras Kenney (en paralelo, fusionados).
            if (LOAD_EXTRAS) {
                const [cables, lasers] = await Promise.all([
                    loadModelInstance('cables.glb'),
                    loadModelInstance('gate-lasers.glb')
                ]);

                if (cables) {
                    placeModel(
                        cables,
                        0,
                        Math.max(layout.height - 1.2, 3),
                        (
                            R.seguridad.cz - R.seguridad.d / 2 +
                            R.experimentacion.cz + R.experimentacion.d / 2
                        ) / 2
                    );

                    bakeModel(cables, extrasGroup);
                }

                if (lasers) {
                    placeModel(
                        lasers,
                        (
                            R.experimentacion.cx + R.experimentacion.w / 2 +
                            R.contencion.cx - R.contencion.w / 2
                        ) / 2,
                        0,
                        R.experimentacion.cz,
                        Math.PI / 2
                    );

                    bakeModel(lasers, extrasGroup);
                }
            }

            // 9. DECORACIÓN PROCEDURAL (salas + pasillos), un grupo por espacio.
            const extractionPad = {
                minX: R.extraccion.cx - 5.2,
                maxX: R.extraccion.cx + 5.2,
                minZ: R.extraccion.cz - 5.2,
                maxZ: R.extraccion.cz + 5.2
            };

            extraction.pad = extractionPad;

            const decorZones = walkRects.map(rect => {
                const room = roomList.find(r => r.rect === rect);
                const isRoom = rect.kind === 'room';

                return {
                    name: rect.name,
                    isRoom,
                    group: rect.group,

                    minX: rect.minX + 1,
                    maxX: rect.maxX - 1,
                    minZ: rect.minZ + 1,
                    maxZ: rect.maxZ - 1,

                    ceilY: isRoom ? rect.top : rect.top - 0.3,
                    floorY: 0,

                    density: isRoom ? (DECOR_DENSITY[room.key] ?? 0.35) : 0.25,
                    noObstacles: !isRoom,
                    exclude: room && room.key === 'extraccion' ? [extractionPad] : null
                };
            });

            function isDecorBlocked(x, z, zone) {
                if (collidesWithBoxes(x, z, 0.4)) return true;

                if (zone?.exclude) {
                    for (const rect of zone.exclude) {
                        if (pointInRect(rect, x, z)) return true;
                    }
                }

                if (zone?.isRoom) {
                    for (const corridor of corridors) {
                        if (pointInRect(corridor, x, z, 1.6)) return true;
                    }
                }

                return false;
            }

            buildDecor({
                zones: decorZones,
                isBlocked: isDecorBlocked,
                addCollider,
                seed: 20261112
            });

            // 10. Fusionar toda la geometría estática en pocas mallas.
            flushStatic();
            meshCollisionCache.clear();

            // Congelar matrices: Three.js deja de recorrer los grupos estáticos cada frame.
            scene.updateMatrixWorld(true);

            for (const rect of walkRects) {
                rect.group.matrixAutoUpdate = false;
                rect.group.matrixWorldAutoUpdate = false;
            }

            extrasGroup.matrixAutoUpdate = false;
            extrasGroup.matrixWorldAutoUpdate = false;

            // 11. Posición del jugador.
            const eye = CONFIG.PLAYER_EYE_HEIGHT || 1.7;

            spawns.playerStart.set(
                R.acceso.cx,
                eye,
                R.acceso.cz + clampOffset(5, R.acceso.d / 2)
            );

            camera.position.copy(spawns.playerStart);

            // 12. Munición, botiquines y zombies en puntos aleatorios con suelo libre.
            const spawnRandom = mulberry32(777);

            function randomFloorPoint(rect, margin) {
                const spanX = rect.maxX - rect.minX - margin * 2;
                const spanZ = rect.maxZ - rect.minZ - margin * 2;

                if (spanX <= 0 || spanZ <= 0) return null;

                for (let tries = 0; tries < 40; tries++) {
                    const x = rect.minX + margin + spawnRandom() * spanX;
                    const z = rect.minZ + margin + spawnRandom() * spanZ;

                    if (!isSafeSpawn(x, z)) continue;
                    if (pointInRect(extractionPad, x, z)) continue;

                    return new THREE.Vector3(x, 0, z);
                }

                return null;
            }

            // Munición ESCASA: sólo AMMO_PACK_COUNT paquetes, en salas distintas
            // elegidas al azar (nunca en Acceso ni Extracción).
            const ammoRooms = roomList.filter(r => r.key !== 'acceso' && r.key !== 'extraccion');

            for (let i = ammoRooms.length - 1; i > 0; i--) {
                const j = Math.floor(spawnRandom() * (i + 1));
                [ammoRooms[i], ammoRooms[j]] = [ammoRooms[j], ammoRooms[i]];
            }

            const ammoPoints = [];

            for (const room of ammoRooms.slice(0, AMMO_PACK_COUNT)) {
                const p = randomFloorPoint(room.rect, 2);
                if (p) ammoPoints.push(p);
            }

            createAmmoPacks(ammoPoints);

            // Botiquines: MEDKIT_COUNT, en salas distintas y lejos de la munición.
            const medkitRooms = ammoRooms.slice();

            for (let i = medkitRooms.length - 1; i > 0; i--) {
                const j = Math.floor(spawnRandom() * (i + 1));
                [medkitRooms[i], medkitRooms[j]] = [medkitRooms[j], medkitRooms[i]];
            }

            const medkitPoints = [];

            for (const room of medkitRooms) {
                if (medkitPoints.length >= MEDKIT_COUNT) break;

                for (let tries = 0; tries < 10; tries++) {
                    const p = randomFloorPoint(room.rect, 2);

                    if (!p) continue;
                    if (ammoPoints.some(a => Math.hypot(a.x - p.x, a.z - p.z) < 3)) continue;

                    medkitPoints.push(p);
                    break;
                }
            }

            createMedkits(medkitPoints);

            // Zombies: 10 repartidos por cuotas a lo largo del recorrido (de inicio a final),
            // siempre dentro de las paredes (margen de 2 m). Acceso queda libre.
            const rectByKey = Object.fromEntries(roomList.map(r => [r.key, r.rect]));

            rectByKey.pasilloSegExp = corridors.find(c => c.name === 'Pasillo Seguridad-Experimentación');
            rectByKey.distribuidor = corridors.find(c => c.name === 'Distribuidor central');

            const ZOMBIE_PLAN = [
                ['seguridad', 1],
                ['pasilloSegExp', 1],
                ['investigacion', 1],
                ['experimentacion', 2],
                ['contencion', 2],
                ['distribuidor', 1],
                ['almacen', 1],
                ['extraccion', 1]
            ];

            const placed = [];

            // Búsqueda exhaustiva en una rejilla barajada: si no hay hueco con el margen
            // ideal, relaja el margen poco a poco (sin salir nunca de las paredes).
            function findSpawn(rect, minBetween) {
                for (const [margin, radius] of [[2, 0.8], [1.5, 0.6], [1, 0.45]]) {
                    const cells = [];

                    for (let x = rect.minX + margin; x <= rect.maxX - margin; x += 0.75) {
                        for (let z = rect.minZ + margin; z <= rect.maxZ - margin; z += 0.75) {
                            cells.push([x, z]);
                        }
                    }

                    for (let i = cells.length - 1; i > 0; i--) {
                        const j = Math.floor(spawnRandom() * (i + 1));
                        [cells[i], cells[j]] = [cells[j], cells[i]];
                    }

                    // Tope de pruebas con colisión por intento: evita que la carga se alargue
                    // si muchas celdas están ocupadas (cada prueba lanza rayos contra los GLB).
                    let tested = 0;

                    for (const [x, z] of cells) {
                        if (pointInRect(extractionPad, x, z)) continue;
                        if (placed.some(q => Math.hypot(x - q.x, z - q.z) < minBetween)) continue;

                        if (++tested > 40) break;

                        if (!isSafeSpawn(x, z, radius, Math.min(margin, 1.5))) continue;

                        return new THREE.Vector3(x, 0, z);
                    }
                }

                return null;
            }

            const zombieReport = {};

            for (const [key, count] of ZOMBIE_PLAN) {
                const rect = rectByKey[key];

                zombieReport[key] = 0;

                if (!rect) {
                    console.warn(`[ZOMBIES] No existe el espacio "${key}".`);
                    continue;
                }

                for (let n = 0; n < count; n++) {
                    let found = null;

                    for (const minBetween of [5, 3, 1.5]) {
                        found = findSpawn(rect, minBetween);
                        if (found) break;
                    }

                    if (found) {
                        placed.push(found);
                        zombieReport[key]++;
                    }
                }
            }

            // Si alguna sala no tuvo hueco, completa en el resto (menos Acceso).
            for (const minBetween of [3, 1.5]) {
                for (let i = 0; placed.length < ZOMBIE_COUNT && i < walkRects.length * 3; i++) {
                    const rect = walkRects[i % walkRects.length];

                    if (rect === R.acceso.rect) continue;

                    const found = findSpawn(rect, minBetween);
                    if (found) placed.push(found);
                }
            }

            spawns.zombieSpawns.push(...placed);

            console.log('[ZOMBIES] Colocados por espacio:', zombieReport, '| total:', placed.length);

            if (placed.length < ZOMBIE_COUNT) {
                console.warn(`[ZOMBIES] Sólo se colocaron ${placed.length} de ${ZOMBIE_COUNT}.`);
            }

            lightsDirty = true;
            updateLights(camera.position);
            updateVisibility(camera.position, true);

            console.log('====================================');
            console.log('[LABORATORIO] CONSTRUCCIÓN FINALIZADA');
            console.log('Espacios caminables:', walkRects.length);
            console.log('Colisionadores de caja:', colliders.length);
            console.log('Mallas con colisión:', meshColliders.length);
            console.log('Paquetes de munición:', ammoPacks.length);
            console.log('Botiquines:', medkits.length);
            console.log('Zombies:', spawns.zombieSpawns.length);
            console.log('Luces candidatas / activas:', lightCandidates.length, '/', MAX_DYNAMIC_LIGHTS);
            console.log('====================================');

        } catch (error) {
            console.error('[LABORATORIO] Error de construcción:', error);
            throw error;
        }
    })();

    // ==================================================
    // REDIMENSIONAMIENTO
    // ==================================================

    function resize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();

        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(pixelRatio());
    }

    window.addEventListener('resize', resize);

    // ==================================================
    // RETORNO
    // ==================================================

    return {
        scene,
        camera,
        renderer,
        colliders,
        collidesWithWorld,
        zombieSpawns: spawns.zombieSpawns,
        playerStart: spawns.playerStart,
        ammoPickups: ammoPacks,
        collectAmmoAt,
        collectMedkitAt,
        medkits,
        resetPickups,
        extraction,
        isInExtraction,
        setExtractionActive,
        pickSpawnPoint,
        ready,
        resize,
        updateLights,
        walkRects
    };
}