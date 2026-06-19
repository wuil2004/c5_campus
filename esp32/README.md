# Campus Seguro — C5 de Emergencia (Tótem ESP32)

## 1. Descripción general

Sistema de botón de emergencia basado en ESP32, diseñado para instalarse de forma fija en
pasillos o edificios universitarios (tótem). Permite a cualquier persona reportar un incidente
de seguridad pulsando un botón físico un número determinado de veces; cada conteo de
pulsaciones activa un tipo de emergencia diferente.

La alerta se publica vía **MQTT** con toda la información del dispositivo (ID, zona,
coordenadas GPS fijas y tipo de emergencia) hacia el servidor de vigilancia C5. El tótem
retroalimenta al usuario mediante un **LED RGB**, un **buzzer** (vía transistor 2N2222A) y una
**pantalla LCD I2C 16x2**.

A diferencia de un dispositivo móvil, este tótem **no tiene GPS físico**: al estar instalado de
forma permanente, sus coordenadas se configuran una sola vez como constantes fijas en el
firmware.

## 2. Hardware y conexiones

### 2.1 Diagrama esquemático (Proteus)

El esquema completo de conexión incluye: ESP32 DevKit, LED RGB de ánodo común, transistor
2N2222A para el buzzer, LCD 16x2 vía módulo I2C PCF8574 y pulsador. Ver
`ESP32_DIAGRAMA_CONEXION.pdf` — Figura 1.

### 2.2 Diagrama de conexión real (Wokwi)

El circuito fue simulado en Wokwi en sus distintos estados operativos:

- **Figura 2** — Circuito en reposo (sin conexión)
- **Figura 3** — Estado: conectando al servidor C5
- **Figura 4** — Estado: sistema listo (LED verde)

> **Nota sobre la simulación:** Wokwi no evalúa límites de corriente física, por lo que en las
> figuras el buzzer aparece conectado directamente al GPIO 33 únicamente para validar la
> lógica del programa. **Para el ensamblaje físico es obligatorio** implementar la etapa de
> potencia con el transistor NPN 2N2222A (Figura 1 de Proteus). Un pin digital del ESP32 no
> entrega la corriente que requiere el buzzer; conectarlo directamente puede dañar el
> microcontrolador de forma permanente.

### 2.3 Pines utilizados

| Pin GPIO | Componente |
|:---:|---|
| GPIO 14 | Botón pulsador |
| GPIO 25 | LED RGB — Rojo |
| GPIO 26 | LED RGB — Verde |
| GPIO 27 | LED RGB — Azul |
| GPIO 33 | Buzzer (vía 2N2222A) |
| GPIO 21 (SDA) | LCD I2C — PCF8574 |
| GPIO 22 (SCL) | LCD I2C — PCF8574 |

## 3. Dependencias y bibliotecas

Instalables desde el gestor de bibliotecas de Arduino IDE (`Sketch` → `Include Library` →
`Manage Libraries`) o PlatformIO:

- **PubSubClient** by Nick O'Leary
- **ArduinoJson** by Benoit Blanchon
- **LiquidCrystal_I2C**
- **Wire** (incluida con el core de Arduino)

### Instalar soporte ESP32

`File` → `Preferences` → URLs adicionales de Board Manager:

```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

Luego: `Tools` → `Board Manager` → buscar `esp32` → instalar.
Seleccionar placa: **ESP32 Dev Module**.

## 4. Configuración del sistema

### 4.1 Credenciales de red y MQTT

Editar estas constantes al inicio de `totem_campus_final.ino` antes de flashear:

```cpp
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD_WIFI";
const char* MQTT_BROKER   = "192.168.X.X";   // IP de tu PC con Docker
const int   MQTT_PORT     = 1883;
const char* MQTT_TOPIC    = "c5/alerts/panic";
```

**¿Cómo saber la IP del broker?**
- Windows: `CMD` → `ipconfig` → "Dirección IPv4"
- Mac/Linux: `ifconfig | grep inet`

### 4.2 Identificación del dispositivo

```cpp
const char* DEVICE_ID     = "PASILLO";     // identidad del tótem (única por dispositivo)
const char* LOCATION_NAME = "EDIFICIOS";   // zona/ubicación legible
```

### 4.3 Coordenadas GPS fijas

Como el tótem es de instalación fija, las coordenadas se configuran una sola vez:

```cpp
const float FIXED_LAT = 19.917390;
const float FIXED_LON = -99.581418;
```

> Ajustar estos valores a la ubicación real donde se instale cada tótem.

### 4.4 Tipos de emergencia

El sistema soporta 5 tipos de emergencia. El número de pulsaciones del botón (dentro de una
ventana de 2 segundos) determina cuál se activa: `índice = (pulsaciones - 1) % 5`.

| Pulsaciones | Tipo de emergencia | Texto LCD |
|:---:|---|---|
| 1 | `robo_con_violencia` | ROBO / ASALTO |
| 2 | `acoso_violencia` | ACOSO/VIOLENCIA |
| 3 | `incendio` | INCENDIO / GAS |
| 4 | `emergencia_medica` | EMERG. MEDICA |
| 5 | `sospechoso` | SOSPECHOSO |

## 5. Funciones auxiliares

### 5.1 `actualizarPantalla(linea1, linea2)`

Limpia el LCD y escribe dos líneas de texto (máximo 16 caracteres por línea).

### 5.2 `setColor(r, g, b)`

Controla el LED RGB de ánodo común. **Lógica invertida**: pasar `true` enciende el canal
correspondiente (internamente escribe `LOW` al pin).

| Color | Significado | Llamada |
|---|---|---|
| 🟡 Amarillo | Conectando WiFi/MQTT | `setColor(1, 1, 0)` |
| 🟢 Verde | Sistema listo / OK | `setColor(0, 1, 0)` |
| 🔵 Azul | Botón pulsado | `setColor(0, 0, 1)` |
| 🔴 Rojo | Enviando alerta / error | `setColor(1, 0, 0)` |
| 🟣 Magenta (parpadeo) | Guardia revisando | `setColor(1, 0, 1)` |
| ⚫ Apagado | — | `setColor(0, 0, 0)` |

### 5.3 Funciones de buzzer

El buzzer emite patrones distintos según el evento; el transistor 2N2222A amplifica la
corriente necesaria.

| Función | Patrón |
|---|---|
| `beepAlertaEnviada()` | 2 beeps cortos (100 ms) |
| `beepAtendida()` | 1 beep largo (600 ms) |
| `beepError()` | 3 beeps muy cortos (80 ms) |

## 6. Funciones de comunicación

### 6.1 `connectWiFi()`

Conecta el ESP32 a la red WiFi configurada. Bloquea la ejecución hasta obtener conexión,
mostrando el estado en el LCD ("CONECTANDO... / RED CAMPUS").

### 6.2 `connectMQTT()`

Conecta al broker MQTT (hasta 5 intentos). Al conectar:
1. Publica un mensaje de presencia en `c5/devices/online`.
2. Se suscribe al topic de estado del propio dispositivo: `c5/alerts/status/<DEVICE_ID>`.

### 6.3 `mqttCallback()`

Se invoca automáticamente al recibir un mensaje en el topic de estado suscrito. Procesa el
campo `status` del JSON recibido y actualiza LED, buzzer y LCD según corresponda:

| `status` recibido | Acción |
|---|---|
| `reviewing` | LED magenta parpadeante, LCD "GUARDIA: REVISANDO..." |
| `confirmed` | LED verde, beep largo, LCD "GUARDIA EN CAMINO" |
| `false_alarm` | LED verde, beep corto, LCD "FALSA ALARMA" |

Tras `confirmed` o `false_alarm`, el tótem vuelve al estado "SISTEMA LISTO" automáticamente
5 segundos después.

## 7. Envío de alerta — `sendAlert()`

Función central del sistema. Construye el payload JSON y lo publica en `c5/alerts/panic` con
`retained=true`, para que el servidor no pierda la alerta si está temporalmente desconectado.

**Ejemplo de payload JSON generado:**

```json
{
  "device_id": "PASILLO",
  "location_name": "EDIFICIOS",
  "latitude": 19.917390,
  "longitude": -99.581418,
  "emergency_type": "incendio",
  "location_method": "totem_fijo",
  "campus": true
}
```

Si la publicación falla, el LED parpadea en rojo (6 veces) y el LCD muestra "ERROR / FALLO EL
ENVIO".

## 8. Función `setup()`

Se ejecuta una sola vez al encender el ESP32:

1. Inicializa LCD, pines de LED/buzzer/botón.
2. Muestra "CAMPUS SEGURO / INICIANDO..." en el LCD.
3. LED amarillo mientras conecta WiFi y luego MQTT.
4. Al finalizar: LED verde, beep corto, LCD "CAMPUS SEGURO / SISTEMA LISTO".
5. Imprime por Serial el resumen de pulsaciones disponibles.

## 9. Función `loop()`

Corre cada 20 ms y gestiona:

1. **Reconexión automática** de WiFi y MQTT si se pierde la conexión.
2. **Retorno al estado inicial** 5 segundos después de recibir `confirmed` o `false_alarm`.
3. **Parpadeo magenta** mientras el guardia revisa el incidente (`reviewing`).
4. **Detección de pulsaciones** del botón con ventana de tiempo de 2 segundos
   (`PRESS_WINDOW`) y antirrebote de 200 ms (`DEBOUNCE_MS`). Al cerrarse la ventana, calcula
   el tipo de emergencia según el conteo y llama a `sendAlert()`.

## 10. Diagrama de estados del LED

| Estado del sistema | Color LED |
|---|:---:|
| Conectando WiFi / MQTT | 🟡 Amarillo |
| Sistema listo / OK | 🟢 Verde |
| Botón pulsado | 🔵 Azul |
| Enviando alerta | 🔴 Rojo |
| Guardia revisando | 🟣 Magenta (parpadeo) |
| Alerta confirmada | 🟢 Verde |
| Falsa alarma | 🟢 Verde |
| Error de envío | 🔴 Rojo (parpadeo x6) |

## 11. Monitor Serial (115200 baud)

```
╔════════════════════════════════════════╗
║   Campus Seguro — Tótem de Emergencia  ║
║   ID: PASILLO                          ║
║   Zona: EDIFICIOS                      ║
╚════════════════════════════════════════╝
[WiFi] Conectando a red campus......
[WiFi] ✓ IP: 192.168.2.50
[MQTT] Conectando... ✓
[MQTT] Suscrito a: c5/alerts/status/PASILLO

[Setup] ✓ Tótem listo
[Setup]   Zona: EDIFICIOS
[Setup]   Pulsaciones:
    1 → robo_con_violencia  (CRÍTICO — 2 min)
    2 → acoso_violencia     (ALTO    — 5 min)
    3 → incendio            (CRÍTICO — 2 min)
    4 → emergencia_medica   (ALTO    — 5 min)
    5 → sospechoso          (MEDIO   — 15 min)

[Button] Pulsación #1
[Button] 1 pulsación(es) → robo_con_violencia

[ALERT] Enviando: robo_con_violencia
[ALERT] ✓ Alerta enviada al centro de vigilancia
```