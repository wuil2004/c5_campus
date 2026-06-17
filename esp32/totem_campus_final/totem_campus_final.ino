#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

const char* WIFI_SSID     = "SpaceX";
const char* WIFI_PASSWORD = "Isic2026??$";
const char* MQTT_BROKER   = "192.168.2.46";   
const int   MQTT_PORT     = 1883;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     
const char* MQTT_TOPIC    = "c5/alerts/panic";

const char* DEVICE_ID     = "PASILLO";
const char* LOCATION_NAME = "EDIFICIOS";


const float FIXED_LAT = 19.912752379357503;
const float FIXED_LON = -99.57860148464074;

const int BUTTON_PIN = 14;
const int RED_PIN    = 25;
const int GREEN_PIN  = 26;
const int BLUE_PIN   = 27;
const int BUZZER_PIN = 33;

const char* EMERGENCY_TYPES[] = {
  "robo_con_violencia",
  "acoso_violencia",     
  "incendio",            
  "emergencia_medica",   
  "sospechoso"           
};
const int NUM_TYPES = 5;


const char* EMERGENCY_LCD[] = {
  "ROBO / ASALTO",   // Crítico
  "ACOSO/VIOLENCIA", // Alto
  "INCENDIO / GAS",  // Crítico
  "EMERG. MEDICA",   // Alto
  "SOSPECHOSO"       // Medio
};

WiFiClient   espClient;
PubSubClient mqttClient(espClient);

unsigned long lastButtonPress  = 0;
unsigned long pressWindowStart = 0;
bool buttonWasPressed = false;
int  pressCount       = 0;

const unsigned long DEBOUNCE_MS  = 200;
const unsigned long PRESS_WINDOW = 2000;

bool alertaEnRevision = false;
unsigned long lastBlinkTime = 0;
bool blinkState = false;

char TOPIC_STATUS[60];

unsigned long tiempoResolucion = 0;

void actualizarPantalla(String linea1, String linea2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(linea1);
  lcd.setCursor(0, 1);
  lcd.print(linea2);
}

void setColor(bool r, bool g, bool b) {
  digitalWrite(RED_PIN,   !r);
  digitalWrite(GREEN_PIN, !g);
  digitalWrite(BLUE_PIN,  !b);
}

void beep(int duracion_ms) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(duracion_ms);
  digitalWrite(BUZZER_PIN, LOW);
  delay(50);
}

void beepAlertaEnviada() {
  
  beep(100); delay(100);
  beep(100);
}

void beepAtendida() {

  beep(600);
}

void beepError() {
  
  beep(80); delay(80);
  beep(80); delay(80);
  beep(80);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String mensaje = "";
  for (unsigned int i = 0; i < length; i++) mensaje += (char)payload[i];

  Serial.printf("[MQTT] Mensaje recibido en %s: %s\n", topic, mensaje.c_str());

  StaticJsonDocument<200> doc;
  if (deserializeJson(doc, mensaje) != DeserializationError::Ok) return;

  const char* status = doc["status"];
  if (!status) return;

  if (strcmp(status, "reviewing") == 0) {
    Serial.println("[Status] Guardia revisando incidente");
    alertaEnRevision = true;
    actualizarPantalla("GUARDIA:", "REVISANDO...");

  } else if (strcmp(status, "confirmed") == 0) {
    Serial.println("[Status] EMERGENCIA CONFIRMADA — guardia en camino");
    alertaEnRevision = false;
    setColor(0, 1, 0);
    beepAtendida();
    actualizarPantalla("GUARDIA EN CAMINO", "MANTENTE SEGURO");
    tiempoResolucion = millis();

  } else if (strcmp(status, "false_alarm") == 0) {
    Serial.println("[Status] Marcado como falsa alarma");
    alertaEnRevision = false;
    setColor(0, 1, 0);
    beep(200);
    actualizarPantalla("ESTADO:", "FALSA ALARMA");
    tiempoResolucion = millis();
  }
}

void connectWiFi() {
  Serial.print("[WiFi] Conectando a red campus");
  actualizarPantalla("CONECTANDO...", "RED CAMPUS");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500); Serial.print(".");
  }
  Serial.printf("\n[WiFi] ✓ IP: %s\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  int attempts = 0;
  actualizarPantalla("CONECTANDO...", "SERVIDOR C5");

  while (!mqttClient.connected() && attempts < 5) {
    Serial.print("[MQTT] Conectando...");
    if (mqttClient.connect(DEVICE_ID)) {
      Serial.println(" ✓");

      StaticJsonDocument<128> onlineDoc;
      onlineDoc["device_id"]     = DEVICE_ID;
      onlineDoc["location_name"] = LOCATION_NAME;
      onlineDoc["status"]        = "online";
      char onlineBuf[128];
      serializeJson(onlineDoc, onlineBuf);
      mqttClient.publish("c5/devices/online", onlineBuf);

      mqttClient.subscribe(TOPIC_STATUS);
      Serial.printf("[MQTT] Suscrito a: %s\n", TOPIC_STATUS);
    } else {
      Serial.printf(" ✗ rc=%d\n", mqttClient.state());
      delay(2000); attempts++;
    }
  }
}

void sendAlert(const char* emergencyType, const char* lcdLabel) {
  Serial.printf("\n[ALERT] Enviando: %s\n", emergencyType);
  alertaEnRevision = false;
  setColor(1, 0, 0);

  actualizarPantalla(lcdLabel, "ENVIANDO...");

  StaticJsonDocument<512> doc;
  doc["device_id"]       = DEVICE_ID;
  doc["location_name"]   = LOCATION_NAME;
  doc["latitude"]        = FIXED_LAT;
  doc["longitude"]       = FIXED_LON;
  doc["emergency_type"]  = emergencyType;
  doc["location_method"] = "totem_fijo";
  doc["campus"]          = true;

  char buffer[512];
  serializeJson(doc, buffer);

  if (!mqttClient.connected()) connectMQTT();

  if (mqttClient.publish(MQTT_TOPIC, buffer, true)) {
    Serial.println("[ALERT] ✓ Alerta enviada al centro de vigilancia");
    beepAlertaEnviada();
    actualizarPantalla("ALERTA ENVIADA", "ESPERANDO...");
  } else {
    Serial.println("[ALERT] ✗ Error de envío");
    beepError();
    actualizarPantalla("ERROR", "FALLO EL ENVIO");
    for (int i = 0; i < 6; i++) {
      setColor(1, 0, 0); delay(150);
      setColor(0, 0, 0); delay(150);
    }
  }

  setColor(0, 1, 0);
}

void setup() {
  Serial.begin(115200);

  lcd.init();
  lcd.backlight();
  actualizarPantalla("CAMPUS SEGURO", "INICIANDO...");

  Serial.println("\n╔════════════════════════════════════════╗");
  Serial.println("║   Campus Seguro — Tótem de Emergencia  ║");
  Serial.printf( "║   ID: %-33s ║\n", DEVICE_ID);
  Serial.printf( "║   Zona: %-31s ║\n", LOCATION_NAME);
  Serial.println("╚════════════════════════════════════════╝");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RED_PIN,    OUTPUT);
  pinMode(GREEN_PIN,  OUTPUT);
  pinMode(BLUE_PIN,   OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  snprintf(TOPIC_STATUS, sizeof(TOPIC_STATUS), "c5/alerts/status/%s", DEVICE_ID);

  setColor(1, 1, 0);

  connectWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  connectMQTT();

  setColor(0, 1, 0);
  beep(200);

  actualizarPantalla("CAMPUS SEGURO", "SISTEMA LISTO");

  Serial.println("\n[Setup] ✓ Tótem listo");
  Serial.printf("[Setup]   Zona: %s\n", LOCATION_NAME);
  Serial.println("[Setup]   Pulsaciones:");
  Serial.println("    1 → robo_con_violencia  (CRÍTICO — 2 min)");
  Serial.println("    2 → acoso_violencia     (ALTO    — 5 min)");
  Serial.println("    3 → incendio            (CRÍTICO — 2 min)");
  Serial.println("    4 → emergencia_medica   (ALTO    — 5 min)");
  Serial.println("    5 → sospechoso          (MEDIO   — 15 min)\n");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqttClient.connected())        connectMQTT();
  mqttClient.loop();

  if (tiempoResolucion > 0 && (millis() - tiempoResolucion > 5000)) {
    actualizarPantalla("CAMPUS SEGURO", "SISTEMA LISTO");
    tiempoResolucion = 0;
  }

  if (alertaEnRevision) {
    unsigned long now = millis();
    if (now - lastBlinkTime > 500) {
      lastBlinkTime = now;
      blinkState = !blinkState;
      blinkState ? setColor(1, 0, 1) : setColor(0, 0, 0);
    }
  }

  bool buttonPressed = (digitalRead(BUTTON_PIN) == LOW);
  if (buttonPressed && !buttonWasPressed) {
    unsigned long now = millis();
    if (now - lastButtonPress > DEBOUNCE_MS) {
      lastButtonPress  = now;
      buttonWasPressed = true;
      if (pressCount == 0) pressWindowStart = now;
      pressCount++;
      Serial.printf("[Button] Pulsación #%d\n", pressCount);
      setColor(0, 0, 1); delay(100); setColor(0, 0, 0);
    }
  }

  if (!buttonPressed && buttonWasPressed) {
    buttonWasPressed = false;
    if (!alertaEnRevision) setColor(0, 1, 0);
  }

  if (pressCount > 0 && (millis() - pressWindowStart) > PRESS_WINDOW) {
    int idx = (pressCount - 1) % NUM_TYPES;
    Serial.printf("[Button] %d pulsación(es) → %s\n", pressCount, EMERGENCY_TYPES[idx]);
    sendAlert(EMERGENCY_TYPES[idx], EMERGENCY_LCD[idx]);
    pressCount = 0;
  }

  delay(20);
}