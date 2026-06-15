#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ══════════════════════════════════════════════════════
//  CAMPUS UNIVERSITARIO INTELIGENTE — Tótem de Emergencia
//  Cada tótem representa un punto físico del campus.
//  Ajustar DEVICE_ID, LOCATION_NAME y coordenadas 
//  según la ubicación real del tótem instalado.
// ══════════════════════════════════════════════════════

// ── Red del campus (WiFi institucional) ─────────────
const char* WIFI_SSID       = "CAMPUS-SEGURO";      // SSID de la red institucional
const char* WIFI_PASSWORD   = "campus2025";         // Cambiar por credenciales reales

// ── Broker MQTT (servidor de la institución) ────────
const char* MQTT_BROKER     = "192.168.10.1";       // IP del servidor campus
const int   MQTT_PORT       = 1883;
const char* MQTT_TOPIC      = "campus/alerts/panic";

// ── Identidad de este tótem ─────────────────────────
// Cambiar por el ID y nombre del punto físico donde se instala
const char* DEVICE_ID       = "TOTEM-LAB-A1";      // Ej: TOTEM-EST-B2, TOTEM-BIBLIO
const char* LOCATION_NAME   = "Edificio Laboratorios - Ala A"; 

// ── Coordenadas FIJAS del tótem (no cambian) ────────
// Obtener con Google Maps en el punto de instalación real
const float FIXED_LAT       = 19.912752;
const float FIXED_LON       = -99.578601;

// ── Pines hardware ───────────────────────────────────
const int BUTTON_PIN  = 14;   // Botón de pánico (rojo físico)
const int RED_PIN     = 25;   // LED RGB — Rojo
const int GREEN_PIN   = 26;   // LED RGB — Verde  
const int BLUE_PIN    = 27;   // LED RGB — Azul
const int BUZZER_PIN  = 32;   // Buzzer (opcional, -1 para desactivar)

// ── Tipos de emergencia del campus ───────────────────
// 1 pulsación  → robo o asalto
// 2 pulsaciones → accidente o caída
// 3 pulsaciones → incendio o fuga de gas
// 4 pulsaciones → acoso o violencia
// 5 pulsaciones → emergencia médica
const char* EMERGENCY_TYPES[] = {
  "robo_con_violencia",   // 1 pulso  — asalto en campus
  "accidente_grave",      // 2 pulsos — caída, accidente
  "incendio",             // 3 pulsos — incendio, fuga de gas
  "acoso_violencia",      // 4 pulsos — acoso, pelea
  "emergencia_medica"     // 5 pulsos — desmayo, crisis
};
const int NUM_TYPES = 5;

// ── Control interno ──────────────────────────────────
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

unsigned long lastButtonPress  = 0;
unsigned long pressWindowStart = 0;
bool buttonWasPressed = false;
int  pressCount = 0;

const unsigned long DEBOUNCE_MS   = 200;
const unsigned long PRESS_WINDOW  = 2500;   // 2.5s para contar pulsaciones
const unsigned long BLINK_ON_MS   = 150;    // LED confirma cada pulsación

// Estado de feedback MQTT (respuesta del backend)
bool esperandoRespuesta = false;

// ── LED RGB (ánodo común: LOW enciende) ─────────────
void setColor(bool r, bool g, bool b) {
  digitalWrite(RED_PIN,   !r);
  digitalWrite(GREEN_PIN, !g);
  digitalWrite(BLUE_PIN,  !b);
}

// Secuencia de confirmación: blink N veces (azul)
void confirmarPulsaciones(int n) {
  for (int i = 0; i < n; i++) {
    setColor(0, 0, 1); delay(BLINK_ON_MS);
    setColor(0, 0, 0); delay(120);
  }
  setColor(0, 1, 0); // regresa a verde
}

// Feedback de buzzer (si está conectado)
void beep(int ms) {
  if (BUZZER_PIN < 0) return;
  digitalWrite(BUZZER_PIN, HIGH); delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
}

// ── Setup ────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[Campus] Tótem de Emergencia iniciando...");
  Serial.printf("[Campus] ID: %s | Ubicación: %s\n", DEVICE_ID, LOCATION_NAME);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RED_PIN,    OUTPUT);
  pinMode(GREEN_PIN,  OUTPUT);
  pinMode(BLUE_PIN,   OUTPUT);
  if (BUZZER_PIN >= 0) pinMode(BUZZER_PIN, OUTPUT);

  // Parpadeo de inicio (blanco)
  for (int i = 0; i < 3; i++) {
    setColor(1, 1, 1); delay(150);
    setColor(0, 0, 0); delay(150);
  }

  connectWiFi();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(onMQTTMessage);
  connectMQTT();

  setColor(0, 1, 0); // Verde: listo
  Serial.println("[Campus] ✓ Sistema listo — verde activo");
}

// ── Callback MQTT: feedback del sistema ─────────────
void onMQTTMessage(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  Serial.printf("[Campus] MQTT recibido [%s]: %s\n", topic, msg.c_str());

  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, msg) != DeserializationError::Ok) return;

  const char* status = doc["status"];
  if (!status) return;

  if (strcmp(status, "reviewing") == 0) {
    // Guardia revisando — LED ámbar parpadeante
    Serial.println("[Campus] 👁️ Guardia revisando la alerta");
    for (int i = 0; i < 5; i++) {
      setColor(1, 1, 0); delay(300);
      setColor(0, 0, 0); delay(300);
    }
    setColor(0, 1, 0);

  } else if (strcmp(status, "confirmed") == 0) {
    // Emergencia confirmada — LED rojo fijo + buzzer
    Serial.println("[Campus] 🚨 EMERGENCIA CONFIRMADA — unidades en camino");
    setColor(1, 0, 0);
    beep(2000);
    delay(5000);
    setColor(0, 1, 0);

  } else if (strcmp(status, "false_alarm") == 0) {
    // Falsa alarma — LED verde parpadea rápido
    Serial.println("[Campus] ✓ Falsa alarma — sistema normal");
    for (int i = 0; i < 6; i++) {
      setColor(0, 1, 0); delay(120);
      setColor(0, 0, 0); delay(120);
    }
    setColor(0, 1, 0);
  }
}

// ── Enviar alerta al servidor ────────────────────────
void sendAlert(const char* emergencyType) {
  setColor(1, 0, 0); // Rojo: enviando
  beep(500);
  Serial.printf("[Campus] 🚨 Enviando alerta: %s\n", emergencyType);

  StaticJsonDocument<512> doc;
  doc["device_id"]       = DEVICE_ID;
  doc["location_name"]   = LOCATION_NAME;     // nombre legible del punto
  doc["latitude"]        = FIXED_LAT;
  doc["longitude"]       = FIXED_LON;
  doc["emergency_type"]  = emergencyType;
  doc["location_method"] = "totem_fijo";      // identifica que es tótem físico
  doc["campus"]          = true;              // flag para contexto universitario

  char buffer[512];
  serializeJson(doc, buffer);

  if (!mqttClient.connected()) connectMQTT();

  bool ok = mqttClient.publish(MQTT_TOPIC, buffer, true);
  Serial.printf("[Campus] Publicación MQTT: %s\n", ok ? "✓ OK" : "✗ ERROR");

  // Suscribirse al canal de feedback de este tótem específico
  char feedbackTopic[80];
  snprintf(feedbackTopic, sizeof(feedbackTopic), "campus/alerts/status/%s", DEVICE_ID);
  mqttClient.subscribe(feedbackTopic);

  delay(800);
  setColor(1, 1, 0); // Ámbar: esperando confirmación del servidor
}

// ── Loop principal ───────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setColor(1, 0, 1); // Magenta: sin WiFi
    connectWiFi();
  }

  if (!mqttClient.connected()) connectMQTT();
  mqttClient.loop();

  // Detección de pulsaciones con ventana de tiempo
  bool buttonPressed = (digitalRead(BUTTON_PIN) == LOW);

  if (buttonPressed && !buttonWasPressed) {
    unsigned long now = millis();
    if (now - lastButtonPress > DEBOUNCE_MS) {
      lastButtonPress = now;
      buttonWasPressed = true;
      
      if (pressCount == 0) {
        pressWindowStart = now;
      }
      pressCount++;
      
      // Confirmar visualmente cada pulsación con un blink azul rápido
      setColor(0, 0, 1); 
      Serial.printf("[Campus] Pulsación #%d\n", pressCount);
    }
  }

  if (!buttonPressed && buttonWasPressed) {
    buttonWasPressed = false;
    setColor(0, 0, 0); // apaga entre pulsaciones
  }

  // Cuando expira la ventana, determinar el tipo de emergencia
  if (pressCount > 0 && (millis() - pressWindowStart) > PRESS_WINDOW) {
    int index = (pressCount - 1) % NUM_TYPES;
    confirmarPulsaciones(pressCount); // feedback visual
    sendAlert(EMERGENCY_TYPES[index]);
    pressCount = 0;
  }
}

// ── Conexión WiFi ────────────────────────────────────
void connectWiFi() {
  Serial.printf("[Campus] Conectando a WiFi: %s\n", WIFI_SSID);
  setColor(0, 0, 1);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500); attempts++;
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[Campus] ✓ WiFi OK — IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[Campus] ✗ WiFi falló — reintentando en loop");
  }
}

// ── Conexión MQTT ────────────────────────────────────
void connectMQTT() {
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 5) {
    Serial.printf("[Campus] Conectando MQTT como %s...\n", DEVICE_ID);
    if (mqttClient.connect(DEVICE_ID)) {
      // Anunciar que el tótem está online
      StaticJsonDocument<128> doc;
      doc["device_id"]     = DEVICE_ID;
      doc["location_name"] = LOCATION_NAME;
      doc["status"]        = "online";
      doc["campus"]        = true;
      char buf[128];
      serializeJson(doc, buf);
      mqttClient.publish("campus/devices/online", buf);

      // Suscribirse al canal de feedback
      char feedbackTopic[80];
      snprintf(feedbackTopic, sizeof(feedbackTopic), "campus/alerts/status/%s", DEVICE_ID);
      mqttClient.subscribe(feedbackTopic);

      Serial.println("[Campus] ✓ MQTT conectado");
    } else {
      Serial.printf("[Campus] MQTT falló (rc=%d) — reintento\n", mqttClient.state());
      delay(2000);
      attempts++;
    }
  }
}
