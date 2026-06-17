const grpc        = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const Redis       = require("ioredis");
const express     = require("express");
const fs          = require("fs");
const path        = require("path");

const app = express();
app.use(express.json());

const GRPC_PORT  = process.env.GRPC_PORT  || 50051;
const HTTP_PORT  = process.env.HTTP_PORT  || 3003;
const REDIS_URL  = process.env.REDIS_URL  || "redis://localhost:6379";
const RULES_PATH = path.join(__dirname, "rules.json");

const redis = new Redis(REDIS_URL);

// ══════════════════════════════════════════════════════
//  TABLA HASH O(1) — núcleo de la clasificación rápida
//
//  Estructura interna:
//  {
//    "secuestro":          { priority: "critical", ... },
//    "robo_con_violencia": { priority: "critical", ... },
//    "incendio":           { priority: "high",     ... },
//    ...
//  }
//  Un solo lookup por tipo → respuesta en ~0.01ms
// ══════════════════════════════════════════════════════
let lookupTable  = {};
let rulesConfig  = {};
let rulesVersion = "";

function buildLookupTable(rules) {
  const table = {};
  for (const [priority, config] of Object.entries(rules)) {
    if (!config.types) continue;
    for (const type of config.types) {
      table[type.toLowerCase().trim()] = {
        priority,
        label:                 config.label,
        reason:                config.reason,
        response_time_seconds: config.response_time_seconds,
        color:                 config.color,
      };
    }
  }
  return table;
}

function loadRules() {
  try {
    const raw    = fs.readFileSync(RULES_PATH, "utf8");
    const rules  = JSON.parse(raw);

    lookupTable  = buildLookupTable(rules);
    rulesConfig  = rules;
    rulesVersion = rules._version || Date.now().toString();

    const total = Object.keys(lookupTable).length;
    console.log(`[Priority] ✓ Reglas cargadas v${rulesVersion} — ${total} tipos indexados en tabla hash`);
    console.log(`[Priority]   Crítico: ${rules.critical?.types?.length || 0} tipos`);
    console.log(`[Priority]   Alto:    ${rules.high?.types?.length     || 0} tipos`);
    console.log(`[Priority]   Medio:   ${rules.medium?.types?.length   || 0} tipos`);
  } catch (err) {
    console.error("[Priority] Error cargando rules.json:", err.message);
    process.exit(1);
  }
}

// ── Hot-reload: recarga reglas si el archivo cambia ───
fs.watch(RULES_PATH, (event) => {
  if (event === "change") {
    console.log("[Priority] 🔄 rules.json modificado — recargando en caliente...");
    setTimeout(loadRules, 200);
  }
});

// ══════════════════════════════════════════════════════
//  FUNCIÓN DE CLASIFICACIÓN — O(1) lookup
//  Usada tanto por el servidor gRPC como por la HTTP API
// ══════════════════════════════════════════════════════
function classifyAlert(emergencyType) {
  const start = process.hrtime.bigint();

  const key   = (emergencyType || "").toLowerCase().trim();
  const match = lookupTable[key];

  const elapsed = Number(process.hrtime.bigint() - start); // nanosegundos

  if (match) {
    return {
      priority:              match.priority,
      label:                 match.label,
      reason:                match.reason,
      response_time_seconds: match.response_time_seconds,
      color:                 match.color,
      classification_ns:     elapsed,
      matched_type:          key,
    };
  }

  // Tipo desconocido → prioridad por defecto
  return {
    priority:              rulesConfig.default_priority || "medium",
    label:                 "MEDIO",
    reason:                rulesConfig.default_reason,
    response_time_seconds: 1800,
    color:                 "#FFD700",
    classification_ns:     elapsed,
    matched_type:          null,
  };
}

// ══════════════════════════════════════════════════════
//  gRPC SERVER
//  Geolocation lo llama como cliente para clasificar
//  cada alerta después de enriquecerla con la zona.
// ══════════════════════════════════════════════════════
const packageDef = protoLoader.loadSync(
  path.join(__dirname, "priority.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const proto = grpc.loadPackageDefinition(packageDef).priority;

function ClassifyAlert(call, callback) {
  const { device_id, emergency_type, zone } = call.request;
  const result = classifyAlert(emergency_type);

  console.log(
    `[Priority gRPC] ← device=${device_id} | ` +
    `tipo="${emergency_type}" | zona="${zone}" | ` +
    `→ ${result.priority.toUpperCase()} (${result.classification_ns}ns)`
  );

  callback(null, {
    alert_id:     `ALT-${Date.now()}-${device_id}`,
    priority:     result.priority,
    reason:       result.reason,
    processed_at: new Date().toISOString(),
  });
}

const grpcServer = new grpc.Server();
grpcServer.addService(proto.PriorityService.service, { ClassifyAlert });
grpcServer.bindAsync(
  `0.0.0.0:${GRPC_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) { console.error("[Priority] Error gRPC:", err); process.exit(1); }
    console.log(`[Priority] ✓ gRPC servidor escuchando en puerto ${port}`);
    console.log(`[Priority] ✓ Esperando llamadas de Geolocation...`);
  }
);

// ══════════════════════════════════════════════════════
//  REST API — gestión de reglas y diagnóstico
// ══════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({
    status:        "ok",
    service:       "priority",
    grpc_port:     GRPC_PORT,
    rules_version: rulesVersion,
    types_indexed: Object.keys(lookupTable).length,
    technique:     "Hash Table O(1)",
  });
});

// Ver todas las reglas activas en la tabla hash
app.get("/rules", (req, res) => {
  res.json({
    version:      rulesVersion,
    lookup_table: lookupTable,
    total_types:  Object.keys(lookupTable).length,
  });
});

// Probar clasificación de cualquier tipo (útil para la demo)
app.get("/classify", (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: "Se requiere ?type=<tipo>" });

  const result = classifyAlert(type);
  res.json({
    input:             type,
    ...result,
    classification_us: (result.classification_ns / 1000).toFixed(3) + " microsegundos",
  });
});

// Actualizar reglas en caliente vía API (sin reiniciar)
app.put("/rules", (req, res) => {
  try {
    const newRules = req.body;
    fs.writeFileSync(RULES_PATH, JSON.stringify(newRules, null, 2));
    loadRules();
    res.json({ message: "Reglas actualizadas", version: rulesVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  INICIO
// ══════════════════════════════════════════════════════
loadRules();

app.listen(HTTP_PORT, () => {
  console.log(`[Priority] HTTP API en puerto ${HTTP_PORT}`);
  console.log(`[Priority] Técnica: Tabla Hash O(1) — clasificación en ~0.01ms`);
  // NOTA: Ya no consume ninguna cola Redis.
  // El flujo ahora es: Geolocation → gRPC ClassifyAlert() → respuesta directa
});