OPERACIÓN EXTRACCIÓN

Videojuego FPS 3D en el navegador, desarrollado con Three.js para el curso de Computación Gráfica y Visual (UPN), evaluación T3.

Eres uno de los últimos sobrevivientes de una infección zombi. Debes atravesar un laboratorio abandonado, administrar tu escasa munición, sobrevivir a tres oleadas de zombis cada vez más duras y llegar a la zona de extracción.

Autor: [TU NOMBRE] Repositorio: [URL DEL REPOSITORIO] Juego en línea (opcional): [URL DEL DESPLIEGUE]

Cómo jugar
Objetivo
Elimina a los zombis de las 3 rondas (15 por ronda, 45 en total).
Al completar la última ronda se activa la zona de extracción (el faro cambia de rojo a verde).
Llega a la plataforma de extracción de la sala final para ganar.

Si un zombi te alcanza y tu salud llega a 0, aparece GAME OVER y la partida se detiene.

Controles
Control	Acción
W	Avanzar
S	Retroceder
A	Desplazarse a la izquierda
D	Desplazarse a la derecha
Mouse	Orientar la cámara
Clic izquierdo	Disparar (un disparo por clic)
1	Equipar la pistola
2	Equipar el rifle
ESC	Liberar el cursor (pausa)
Mecánicas implementadas
Armas (RF01)
Dos armas con modelos GLB: pistola y rifle.
Cambio con las teclas 1 y 2, visible en primera persona.
Cada clic dispara una sola vez; mantener presionado no dispara en ráfaga.
El arma acompaña la cámara (está anclada a ella) y tiene retroceso al disparar.
Munición (RF02)
Cada arma tiene su propio contador de balas.
Cada disparo consume una bala; con el contador en cero no se puede disparar.
No existe recarga libre: la única forma de recuperar munición es recoger paquetes de munición repartidos por el escenario.
Hay 5 paquetes en salas distintas. Cada ronda nueva reaparecen y dan +15 balas más que en la ronda anterior (20, 35 y 50).
Zombis (RF04, RF05, RF07)
Modelos GLB animados (reposo, avistamiento, caminar, ataque).
Inactivos hasta que el jugador entra en su rango de detección (16 m). No todos persiguen desde el inicio.
Una vez activados, persiguen al jugador esquivando paredes y obstáculos.
Los impactos se detectan con raycasting desde el centro de la cámara. Cada impacto válido resta 1 punto de resistencia.
Un zombi eliminado desaparece y deja de perseguir y atacar.
Rondas y dificultad (RF11)
Ronda	Zombis	Resistencia (impactos)	Velocidad
1	15	2	normal
2	15	4 (el doble)	normal
3	15	6 (el triple)	el doble
Los zombis eliminados se reponen en puntos aleatorios y lejanos mientras la ronda continúa.
La munición limitada obliga a administrar recursos y a decidir cuándo disparar.
Coleccionables (RF10)
Paquetes de munición: suman balas al arma equipada.
Botiquines: 4 repartidos por el mapa, restauran 50 de salud (no se gastan si tienes la salud llena).
Ambos reaparecen al comenzar cada ronda.
Escenario (RF03, RF08)
Laboratorio de 7 salas conectadas por pasillos: Acceso, Seguridad, Investigación, Experimentación, Contención, Almacén y Extracción.
Inicio claramente identificado (sala de Acceso), recorrido con encuentros y zona final de extracción.
Paredes, suelos, techos, vigas y decoración generados por código; las salas base son modelos GLB.
Colisiones con paredes, mobiliario y objetos.
Condiciones de fin (RF08, RF09)
Victoria: al entrar en la zona de extracción activa aparece «¡MISIÓN COMPLETADA! Has llegado a la zona de extracción».
Derrota: al quedarte sin salud aparece GAME OVER y se detiene la partida. Hay botón para reiniciar.
Instalación y ejecución
Requisitos
Node.js 18 o superior
Un navegador moderno con WebGL (Chrome, Edge o Firefox)
Pasos
bash
# 1. Clonar el repositorio
git clone [URL DEL REPOSITORIO]
cd [NOMBRE DE LA CARPETA]

# 2. Instalar dependencias
npm install

# 3. Iniciar el servidor de desarrollo
npm run dev

Abre en el navegador la dirección que muestre la consola (normalmente http://localhost:5173) y pulsa INICIAR PARTIDA.

Los modelos GLB se cargan por HTTP, por lo que el juego debe ejecutarse desde un servidor (no se puede abrir el index.html haciendo doble clic).

Estructura del proyecto
├── index.html
├── package.json
├── public/
│   └── assets/              # Modelos GLB (armas, zombi, soldado, laboratorio)
└── src/
    ├── main.js              # Bucle principal, controles, rondas, victoria y derrota
    ├── config.js            # Rutas de assets y constantes del jugador
    ├── scene.js             # Escenario, colisiones, iluminación, pickups, extracción
    ├── player.js            # Modelo del soldado en primera persona
    ├── weapons.js           # Armas, munición, disparo y retroceso
    ├── zombies.js           # IA, rondas, daño, reposición
    └── hud.js               # Interfaz: salud, munición, ronda, mensajes

(Ajusta las rutas si tu proyecto usa otra organización.)

Detalles técnicos
Three.js para el renderizado, con GLTFLoader y decodificador Meshopt para los GLB.
Cámara en primera persona con PointerLockControls.
Disparos por raycasting: se lanza un rayo desde el centro de la pantalla contra las mallas de los zombis; cada impacto resta 1 de resistencia.
IA de zombis con máquina de estados: idle → spotted → chasing → attacking → recovering.
Colisiones con un índice espacial de cajas y rayos contra las mallas de los modelos.
Rendimiento: geometría estática fusionada por sala y material, decoración instanciada, oclusión por salas, materiales Lambert y límite de luces dinámicas.
Recursos externos y licencias
Recurso	Uso	Fuente	Licencia
Kenney – [NOMBRE DEL PACK]	Salas, cables y láseres del laboratorio	https://kenney.nl	CC0
Modelo de pistola	Arma 1	
Modelo de rifle	Arma 2
Modelo de zombi	Enemigos	
Modelo de soldado	Cuerpo del jugador
Three.js	Motor 3D	https://threejs.org	MIT
