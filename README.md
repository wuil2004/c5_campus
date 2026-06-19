# Campus Seguro — Sistema de Alerta Universitaria

Sistema de seguridad distribuido para **campus universitarios e institutos tecnológicos**, basado en tótems ESP32 con botón de pánico, cámara integrada y conectividad WiFi institucional.

---

##  Caso de uso: Campus Universitario Inteligente

Cada tótem es un poste físico instalado en **puntos ciegos, pasillos largos o estacionamientos** del campus. Al presionar el botón de pánico, el sistema:

1. Envía la **ubicación exacta del tótem** (Edificio, Área) al centro de vigilancia
2. Activa la **cámara más cercana** para que el guardia vea en tiempo real
3. Alerta a la **caseta responsable** de esa zona del campus
4. Captura un **snapshot automático** del momento del incidente
5. Transcribe el **audio del lugar** para detectar palabras clave de peligro
6. El guardia confirma o descarta y el tótem recibe **feedback de LED/buzzer**


##  Sistema de pulsaciones (campus)

| Pulsaciones | Emergencia | Prioridad | Tiempo respuesta |
|---|---|---|---|
| 1 | Robo / Asalto | 🔴 Crítico | < 2 min |
| 2 | Accidente / Caída | 🟠 Alto | < 5 min |
| 3 | Incendio / Fuga gas | 🔴 Crítico | < 2 min |
| 4 | Acoso / Violencia | 🟠 Alto | < 5 min |
| 5 | Emergencia médica | 🟠 Alto | < 5 min |

---

##  Levantar el sistema

```bash
docker compose up --build
```

Abrir el dashboard: `index.html` (doble clic) o servirlo con `python3 -m http.server`

---

##  Configurar un tótem ESP32

1. Editar `esp32/totem_campus/totem_campus.ino`
2. Cambiar `WIFI_SSID` y `WIFI_PASSWORD` por las credenciales de la red campus
3. Cambiar `MQTT_BROKER` por la IP del servidor (donde corre Docker)
4. Cambiar `DEVICE_ID` por el ID único del punto de instalación (ej. `TOTEM-LAB-A1`)
5. Cambiar `LOCATION_NAME` por el nombre descriptivo del lugar
6. Ajustar `FIXED_LAT` y `FIXED_LON` con las coordenadas reales del tótem
7. Flashear con Arduino IDE (board: ESP32 Dev Module, baud: 115200)

---

##  Personalizar zonas del campus

Editar `services/geolocation/index.js` → array `CAMPUS_ZONES`:

```javascript
{
  name:        "Nombre del área",          // aparece en el dashboard
  description: "Descripción detallada",
  bounds: { minLat, maxLat, minLon, maxLon }, // coordenadas del polígono
  cameras:    ["CAM-ID-01"],               // cámaras cercanas (referencia)
  guardPost:  "Caseta Norte"              // caseta que atiende esta zona
}
```

---

##  Estructura del proyecto

```
smart-campus/
├── index.html                              ← Dashboard de vigilancia
├── docker-compose.yaml                     ← Levanta todo
├── esp32/
│   └── totem_campus/
│       └── totem_campus.ino               ← Firmware del tótem ESP32
├── services/
│   ├── reception/                         ← Recibe alertas MQTT/HTTP
│   ├── geolocation/                       ← Mapea coordenadas a zonas del campus
│   ├── priority/
│   │   └── rules.json                     ← Reglas de prioridad universitaria
│   ├── notifications/                     ← WebSocket al dashboard
│   ├── history/                           ← PostgreSQL + feedback a tótems
│   └── transcription/                     ← Audio a texto
└── README.md
```

---

##  Probar sin ESP32

```bash
# Simular alerta desde Laboratorios
curl -X POST http://localhost:8080/alert \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "TOTEM-LAB-A1",
    "location_name": "Edificio Laboratorios - Ala A",
    "latitude": 19.9128,
    "longitude": -99.5790,
    "emergency_type": "robo_con_violencia",
    "campus": true
  }'

# Simular alerta desde el estacionamiento
curl -X POST http://localhost:8080/alert \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "TOTEM-EST-B2",
    "location_name": "Estacionamiento Norte - Módulo B",
    "latitude": 19.9142,
    "longitude": -99.5795,
    "emergency_type": "acoso_violencia",
    "campus": true
  }'
```
