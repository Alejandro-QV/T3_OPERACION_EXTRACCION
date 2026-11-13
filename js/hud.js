export function createHUD(container) {
    const overlay = document.createElement('div');
    overlay.id = 'start-screen';

    overlay.innerHTML = `
        <h1>OPERACIÓN EXTRACCIÓN</h1>
        <p>Supera 3 rondas de 15 zombis y llega a la zona de extracción</p>
        <button id="start-button">INICIAR PARTIDA</button>
        <p>WASD: Moverse | Mouse: Mirar | 1: Pistola | 2: Rifle</p>
        <p>Clic izquierdo: Disparar | R: Recargar | ESC: Liberar cursor</p>
        <p>Recoge munición y botiquines (+50 de salud) por el mapa</p>
    `;

    container.appendChild(overlay);

    const hud = document.createElement('div');
    hud.id = 'game-hud';

    hud.innerHTML = `
        <div id="weapon-name">CARGANDO...</div>
        <div id="crosshair">+</div>
        <div id="banner"></div>

        <div id="health-panel">
            <div id="health-label">SALUD</div>
            <div id="health-bar"><div id="health-fill"></div></div>
            <div id="health-value">100 / 100</div>
        </div>

        <div id="zombie-counter">RONDA 1/3 · ZOMBIS RESTANTES: --</div>

        <div id="ammo-panel">
            <div id="ammo-label">MUNICIÓN</div>
            <div id="ammo-values">
                <span id="ammo-current">--</span>
                <span id="ammo-separator">/</span>
                <span id="ammo-reserve">--</span>
            </div>
            <div id="ammo-description">CARGADOR / RESERVA</div>
            <div id="reload-message"></div>
        </div>
    `;

    container.appendChild(hud);

    const style = document.createElement('style');

    style.textContent = `
        #game-hud { pointer-events: none; }

        #weapon-name {
            position: fixed;
            right: 35px;
            bottom: 155px;
            color: white;
            font-family: Arial, sans-serif;
            font-size: 20px;
            font-weight: bold;
            letter-spacing: 3px;
            text-shadow: 2px 2px 4px black;
        }

        #ammo-panel, #health-panel {
            position: fixed;
            bottom: 30px;
            padding: 12px;
            background: rgba(0,0,0,.72);
            border: 1px solid rgba(255,255,255,.25);
            border-radius: 8px;
            color: white;
            font-family: Arial, sans-serif;
            box-sizing: border-box;
        }

        #ammo-panel {
            right: 30px;
            bottom: 25px;
            min-width: 175px;
            padding: 12px 16px;
            text-align: right;
            z-index: 20;
        }

        #ammo-label, #health-label {
            font-size: 12px;
            letter-spacing: 3px;
            color: #bbb;
            margin-bottom: 8px;
        }

        #ammo-values {
            display: flex;
            align-items: baseline;
            justify-content: flex-end;
            gap: 9px;
            white-space: nowrap;
        }

        #ammo-current { font-size: 36px; font-weight: bold; }
        #ammo-separator { font-size: 25px; color: #888; }
        #ammo-reserve { font-size: 25px; color: #d0d0d0; }

        #ammo-description {
            margin-top: 3px;
            font-size: 10px;
            letter-spacing: 1.5px;
            color: #aaa;
            white-space: nowrap;
        }

        #reload-message {
            margin-top: 8px;
            min-height: 18px;
            color: #ffc65c;
            font-size: 13px;
            font-weight: bold;
            letter-spacing: 1px;
        }

        #crosshair {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 24px;
            text-shadow: 1px 1px 3px black;
        }

        #banner {
            position: fixed;
            top: 18%;
            left: 50%;
            transform: translateX(-50%);
            max-width: 80vw;
            text-align: center;
            font-family: Arial, sans-serif;
            font-size: 30px;
            font-weight: bold;
            letter-spacing: 3px;
            text-shadow: 2px 2px 6px black;
            opacity: 0;
            transition: opacity .35s;
            z-index: 30;
        }

        #banner.show { opacity: 1; }

        #health-panel { left: 30px; width: 220px; }

        #health-bar {
            height: 12px;
            background: #444;
            border-radius: 8px;
            overflow: hidden;
        }

        #health-fill {
            width: 100%;
            height: 100%;
            background: #36c76b;
            transition: width .2s, background .2s;
        }

        #health-value { margin-top: 6px; font-size: 13px; }

        #zombie-counter {
            position: fixed;
            top: 25px;
            left: 50%;
            transform: translateX(-50%);
            color: white;
            background: rgba(0,0,0,.7);
            padding: 10px 18px;
            border-radius: 6px;
            font-family: Arial, sans-serif;
            font-size: 13px;
            letter-spacing: 1px;
            white-space: nowrap;
        }

        #zombie-counter.extraction {
            color: #04130b;
            background: #35ff93;
            font-weight: bold;
        }

        #game-over-screen {
            position: fixed;
            inset: 0;
            z-index: 100;
            background: rgba(0,0,0,.88);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: white;
            font-family: Arial, sans-serif;
            text-align: center;
        }

        #game-over-screen h1 {
            color: #e53935;
            font-size: 48px;
            letter-spacing: 5px;
        }

        #game-over-screen p { font-size: 18px; }
    `;

    document.head.appendChild(style);

    let bannerTimeout = null;

    // Mensaje grande temporal (rondas, recogidas, extracción).
    function showBanner(text, color = '#ffffff', duration = 3000) {
        const banner = document.getElementById('banner');

        banner.textContent = text;
        banner.style.color = color;
        banner.classList.add('show');

        if (bannerTimeout) clearTimeout(bannerTimeout);

        bannerTimeout = setTimeout(() => {
            banner.classList.remove('show');
            bannerTimeout = null;
        }, duration);
    }

    function updateHealth(player) {
        const percentage = Math.max(0, player.health / player.maxHealth * 100);
        const fill = document.getElementById('health-fill');

        fill.style.width = `${percentage}%`;
        fill.style.background =
            percentage > 60 ? '#36c76b' :
            percentage > 30 ? '#f0a52b' : '#e53935';

        document.getElementById('health-value').textContent =
            `${player.health} / ${player.maxHealth}`;
    }

    function updateAmmo(weapon, reloading) {
        if (!weapon) return;

        let message = '';

        if (reloading) {
            message = 'RECARGANDO...';
        } else if (weapon.ammo === 0 && weapon.reserve === 0) {
            message = 'SIN MUNICIÓN: busca un paquete';
        } else if (weapon.ammo === 0) {
            message = 'PRESIONA R';
        }

        document.getElementById('weapon-name').textContent = weapon.name;
        document.getElementById('ammo-current').textContent = weapon.ammo;
        document.getElementById('ammo-reserve').textContent = weapon.reserve;
        document.getElementById('reload-message').textContent = message;
    }

    function updateZombieCounter(remaining, round = 1) {
        const counter = document.getElementById('zombie-counter');

        counter.classList.remove('extraction');
        counter.textContent =
            `RONDA ${round}/3 · ZOMBIS RESTANTES: ${remaining}`;
    }

    function showExtraction() {
        const counter = document.getElementById('zombie-counter');

        counter.classList.add('extraction');
        counter.textContent = 'EXTRACCIÓN ACTIVA: ve a la zona verde';
    }

    function showGameOver(container) {
        const screen = document.createElement('div');
        screen.id = 'game-over-screen';

        screen.innerHTML = `
    <h1>GAME OVER</h1>
    <p>Un zombi te ha asesinado.</p>
    <button onclick="location.reload()" style="margin-top:24px;padding:12px 28px;
        font:bold 18px sans-serif;cursor:pointer;border:0;border-radius:6px;
        background:#e53935;color:#fff">Reiniciar partida</button>
`;

        container.appendChild(screen);
    }

    function showOverlay() {
        overlay.style.display = 'flex';
    }

    function hideOverlay() {
        overlay.style.display = 'none';
    }

    function onStart(callback) {
        document.getElementById('start-button').addEventListener('click', callback);
    }

    return {
        overlay,
        updateHealth,
        updateAmmo,
        updateZombieCounter,
        showExtraction,
        showBanner,
        showGameOver,
        showOverlay,
        hideOverlay,
        onStart
    };
}