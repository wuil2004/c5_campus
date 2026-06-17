// services/geolocation/index.js — Campus Universitario Inteligente
// Enriquece coordenadas con zona del campus y llama a Priority via gRPC

const express     = require("express");
const Redis       = require("ioredis");
const https       = require("https");
const grpc        = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path        = require("path");

const app = express();
app.use(express.json());

const PORT          = process.env.PORT          || 3002;
const REDIS_URL     = process.env.REDIS_URL     || "redis://localhost:6379";
const PRIORITY_GRPC = process.env.PRIORITY_GRPC || "priority:50051";

const redis    = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);

// ══════════════════════════════════════════════════════
//  CLIENTE gRPC → Priority
//  Carga el mismo .proto que usa el servidor
// ══════════════════════════════════════════════════════
const packageDef = protoLoader.loadSync(
  path.join(__dirname, "priority.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const proto          = grpc.loadPackageDefinition(packageDef).priority;
const priorityClient = new proto.PriorityService(
  PRIORITY_GRPC,
  grpc.credentials.createInsecure()
);

// Wrapper que convierte el callback de gRPC en una Promise
function callClassifyAlert(request) {
  return new Promise((resolve, reject) => {
    priorityClient.ClassifyAlert(request, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

// ══════════════════════════════════════════════════════
//  MAPA DE ZONAS DEL CAMPUS
//  Ajustar los polígonos según el plano real de tu institución.
//  Cada zona tiene un nombre descriptivo para los guardias.
// ══════════════════════════════════════════════════════
const CAMPUS_ZONES = [
  {
    name: "Edificio de Laboratorios",
    description: "Laboratorios de Cómputo, Electrónica y Química",
    bounds: { minLat: 19.9120, maxLat: 19.9135, minLon: -99.5800, maxLon: -99.5780 },
    cameras: ["CAM-LAB-01", "CAM-LAB-02"],
    guardPost: "Caseta Norte"
  },
  {
    name: "Estacionamiento Norte",
    description: "Estacionamiento principal — Acceso por Av. Tecnológico",
    bounds: { minLat: 19.9135, maxLat: 19.9155, minLon: -99.5810, maxLon: -99.5775 },
    cameras: ["CAM-EST-01", "CAM-EST-02", "CAM-EST-03"],
    guardPost: "Caseta Norte"
  },
  {
    name: "Biblioteca Central",
    description: "Biblioteca y Sala de Lectura",
    bounds: { minLat: 19.9105, maxLat: 19.9120, minLon: -99.5795, maxLon: -99.5775 },
    cameras: ["CAM-BIB-01"],
    guardPost: "Caseta Centro"
  },
  {
    name: "Patio Central",
    description: "Explanada principal y área de convivencia",
    bounds: { minLat: 19.9108, maxLat: 19.9128, minLon: -99.5780, maxLon: -99.5760 },
    cameras: ["CAM-PAT-01", "CAM-PAT-02"],
    guardPost: "Caseta Centro"
  },
  {
    name: "Canchas Deportivas",
    description: "Canchas de fútbol, básquetbol y volleyball",
    bounds: { minLat: 19.9095, maxLat: 19.9115, minLon: -99.5810, maxLon: -99.5790 },
    cameras: ["CAM-DEP-01"],
    guardPost: "Caseta Sur"
  },
  {
    name: "Acceso Principal",
    description: "Entrada y salida principal del campus",
    bounds: { minLat: 19.9140, maxLat: 19.9160, minLon: -99.5770, maxLon: -99.5750 },
    cameras: ["CAM-ACC-01", "CAM-ACC-02"],
    guardPost: "Caseta Principal"
  },
  {
    name: "Edificio Administrativo",
    description: "Rectoría, Dirección y Servicios Escolares",
    bounds: { minLat: 19.9115, maxLat: 19.9130, minLon: -99.5765, maxLon: -99.5748 },
    cameras: ["CAM-ADM-01"],
    guardPost: "Caseta Principal"
  }
];

// ── Cache de geocodificación inversa ─────────────────
const geoCache    = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Buscar zona del campus por coordenadas ────────────
function findCampusZone(lat, lon) {
  for (const zone of CAMPUS_ZONES) {
    const b = zone.bounds;
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      return zone;
    }
  }
  return null;
}

// ── Identificar zona a partir del device_id del tótem ─
function getZoneFromDevice(alert) {
  if (alert.location_name) {
    const match = CAMPUS_ZONES.find(z =>
      alert.location_name.toLowerCase().includes(z.name.toLowerCase().split(" ")[0].toLowerCase())
    );
    if (match) return match;
  }
  return null;
}

// ── Geocodificación inversa con OpenStreetMap (fallback) ─
function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const cached   = geoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return resolve(cached.data);
    }

    const url     = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=es`;
    const options = { headers: { "User-Agent": "SmartCampus-AlertSystem/2.0 (seguridad@campus.edu.mx)" } };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json   = JSON.parse(data);
          const addr   = json.address || {};
          const result = {
            display_name: json.display_name || "Campus Universitario",
            street:       addr.road || addr.pedestrian || null,
            neighborhood: addr.neighbourhood || addr.suburb || null,
            city:         addr.city || addr.town || addr.municipality || null,
            state:        addr.state || null,
            country:      addr.country || null,
            postcode:     addr.postcode || null,
          };
          geoCache.set(cacheKey, { data: result, ts: Date.now() });
          resolve(result);
        } catch (e) {
          resolve({ display_name: "Campus Universitario", street: null, neighborhood: null, city: null, state: null, country: null, postcode: null });
        }
      });
    }).on("error", () => {
      resolve({ display_name: "Campus Universitario", street: null, neighborhood: null, city: null, state: null, country: null, postcode: null });
    });
  });
}

// ══════════════════════════════════════════════════════
//  PROCESADOR DE COLA REDIS
//  Flujo: queue:alerts → [geo enrich] → gRPC Priority
//       → queue:notify + queue:history + queue:transcription_input
// ══════════════════════════════════════════════════════
async function processQueue() {
  console.log("[Geolocation] Escuchando cola queue:alerts...");
  console.log(`[Geolocation] Cliente gRPC conectado a Priority → ${PRIORITY_GRPC}`);

  while (true) {
    try {
      const result = await redis.brpop("queue:alerts", 5);
      if (!result) continue;

      const alert  = JSON.parse(result[1]);
      const lat    = parseFloat(alert.latitude);
      const lon    = parseFloat(alert.longitude);
      const tStart = process.hrtime.bigint();

      console.log(`[Geolocation] Procesando: device=${alert.device_id} coords=(${lat}, ${lon})`);

      // ── PASO 1: Enriquecer con zona del campus ──────
      let campusZone = getZoneFromDevice(alert) || findCampusZone(lat, lon);
      let enriched;

      if (campusZone) {
        enriched = {
          ...alert,
          zone:             campusZone.name,
          zone_description: campusZone.description,
          guard_post:       campusZone.guardPost,
          nearby_cameras:   campusZone.cameras,
          address:          campusZone.description,
          neighborhood:     campusZone.name,
          city:             "Campus Universitario",
          geo_source:       "campus_map",
          geo_processed:    true,
          geo_processed_at: new Date().toISOString(),
        };
        console.log(`[Geolocation] ✓ Zona campus: ${campusZone.name} | Caseta: ${campusZone.guardPost}`);
      } else {
        // Fuera del mapa → Nominatim como fallback
        console.log(`[Geolocation] Coordenadas fuera del mapa campus — consultando Nominatim`);
        const geoData = await reverseGeocode(lat, lon);

        enriched = {
          ...alert,
          zone:             geoData.display_name?.substring(0, 80) || "Zona Exterior Campus",
          address:          geoData.display_name,
          street:           geoData.street,
          neighborhood:     geoData.neighborhood,
          city:             geoData.city,
          state:            geoData.state,
          country:          geoData.country,
          postcode:         geoData.postcode,
          guard_post:       "Caseta Principal",
          nearby_cameras:   [],
          geo_source:       "nominatim",
          geo_processed:    true,
          geo_processed_at: new Date().toISOString(),
        };

        // Rate limit de Nominatim: 1 req/seg
        await new Promise(r => setTimeout(r, 1100));
      }

      // ── PASO 2: Llamar a Priority via gRPC ──────────
      //    Geolocation actúa como cliente gRPC de Priority.
      //    Enviamos los datos enriquecidos (incluye zona ya resuelta).
      console.log(`[Geolocation] → gRPC ClassifyAlert: device=${enriched.device_id} tipo="${enriched.emergency_type}" zona="${enriched.zone}"`);

      const grpcRequest = {
        device_id:      enriched.device_id,
        emergency_type: enriched.emergency_type,
        zone:           enriched.zone,
        latitude:       lat,
        longitude:      lon,
        timestamp:      enriched.timestamp || new Date().toISOString(),
      };

      let grpcResponse;
      try {
        grpcResponse = await callClassifyAlert(grpcRequest);
        console.log(`[Geolocation] ← gRPC respuesta: alert_id=${grpcResponse.alert_id} priority=${grpcResponse.priority.toUpperCase()}`);
      } catch (grpcErr) {
        // Si gRPC falla (Priority caído), clasificar localmente como medium
        // y continuar sin perder la alerta
        console.error(`[Geolocation] ✗ gRPC error: ${grpcErr.message} — usando prioridad por defecto`);
        grpcResponse = {
          alert_id:    `ALT-${Date.now()}-${enriched.device_id}`,
          priority:    "medium",
          reason:      "Clasificación de respaldo (gRPC no disponible)",
          processed_at: new Date().toISOString(),
        };
      }

      // ── PASO 3: Combinar geo + clasificación gRPC ───
      const processed = {
        ...enriched,
        alert_id:              grpcResponse.alert_id,
        priority:              grpcResponse.priority,
        priority_reason:       grpcResponse.reason,
        priority_processed_at: grpcResponse.processed_at,
        grpc_classified:       true,   // flag para logs/demo
      };

      const tEnd   = process.hrtime.bigint();
      const totalMs = (Number(tEnd - tStart) / 1_000_000).toFixed(2);

      console.log(
        `[Geolocation] ✓ Procesado en ${totalMs}ms | ` +
        `${processed.alert_id} | ${processed.zone} | ${processed.priority.toUpperCase()}`
      );

      // ── PASO 4: Publicar en paralelo a notify, history y transcripción ─
      await Promise.all([
        redisPub.lpush("queue:notify",              JSON.stringify(processed)),
        redisPub.lpush("queue:history",             JSON.stringify(processed)),
        redisPub.lpush("queue:transcription_input", JSON.stringify(processed)),
      ]);

    } catch (err) {
      console.error("[Geolocation] Error en processQueue:", err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── REST API ──────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({
    status:        "ok",
    service:       "geolocation",
    campus_zones:  CAMPUS_ZONES.length,
    grpc_target:   PRIORITY_GRPC,
  })
);

// Mapa completo de zonas del campus (para el dashboard)
app.get("/campus/zones", (req, res) => {
  res.json({ zones: CAMPUS_ZONES, total: CAMPUS_ZONES.length });
});

// Buscar zona por coordenadas
app.post("/zone", async (req, res) => {
  const { latitude, longitude } = req.body;
  if (!latitude || !longitude)
    return res.status(400).json({ error: "Se requieren latitude y longitude" });

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);

  const campusZone = findCampusZone(lat, lon);
  if (campusZone) {
    return res.json({ latitude, longitude, campus_zone: campusZone, geo_source: "campus_map" });
  }

  const geoData = await reverseGeocode(lat, lon);
  res.json({ latitude, longitude, ...geoData, campus_zone: null, geo_source: "nominatim" });
});

app.get("/zone", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "Se requieren ?lat=&lon=" });

  const campusZone = findCampusZone(parseFloat(lat), parseFloat(lon));
  if (campusZone) return res.json({ lat, lon, campus_zone: campusZone });

  const geoData = await reverseGeocode(parseFloat(lat), parseFloat(lon));
  res.json({ lat, lon, ...geoData });
});

app.listen(PORT, () => {
  console.log(`[Geolocation] Servicio iniciado en puerto ${PORT}`);
  console.log(`[Geolocation] Campus: ${CAMPUS_ZONES.length} zonas registradas`);
  console.log(`[Geolocation] gRPC → Priority en ${PRIORITY_GRPC}`);
  processQueue();
});