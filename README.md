# Smart waste management system

**Stack:** React + Vite frontend, Django + Channels backend, SQLite database, Eclipse Mosquitto MQTT broker, and four ESP32 boards programmed in Arduino IDE. Node.js is used only to build the React frontend; it is no longer the server.

```text
ESP32 / HC-SR04  --MQTT-->  Mosquitto  --subscribe-->  Django  --> SQLite
                                                       |
                                                       +-- authenticated WebSocket --> React website
                                                       +-- REST API --> React website
```

The browser receives MQTT readings through Django's authenticated WebSocket relay. This keeps broker passwords and bin sensor keys out of browser JavaScript and lets Django enforce manager/staff permissions. The broker itself never sends data directly to the website.

## Structure

```text
smart-waste-management/
  backend/
    config/            Django settings, URLs, ASGI app
    core/              models, API, MQTT subscriber, WebSocket consumer
    tests/             disposable DB integration and live broker checks
    manage.py           Django commands
    requirements.txt    Python packages
  frontend/
    src/main.jsx       React manager and staff pages
    src/Landing.jsx    public municipal home page and tole search
    src/LandingEditor.jsx manager content editor
    src/style.css      responsive styling
    vite.config.js     development proxy to Django
  firmware/
    smart_bin_mqtt/    Arduino IDE ESP32 sketch
  broker/               Mosquitto config and ACL templates
  schema.sql            existing SQLite schema, reused without data migration
  data/                 local database, credentials and logs (ignored by Git)
  legacy-node/          previous Express/HTTP version, kept for reference
```

## Start the project on Windows

For team changes, create a branch and open a pull request into `main`. GitHub Actions builds the React frontend and runs the Django integration test on each pull request. Each teammate should create their own `.env` and broker password files locally; these and the SQLite database are ignored by Git.

This workspace has already been seeded, built and configured. The existing manager username, password and four bin keys are in `data/setup-credentials.txt`. Keep this file private. The backend uses the same `data/waste.sqlite` database as the earlier Node version, so sample bins and prior readings remain available.

For a new installation:

1. Install Python 3.12+, Node.js 24+, [Eclipse Mosquitto](https://mosquitto.org/download/) and Arduino IDE. Install the ESP32 board package and **PubSubClient** library in Arduino IDE.
2. In this project folder, create a virtual environment and install packages:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
   cd frontend
   npm install
   npm run build
   cd ..
   ```

3. Copy `.env.example` to `.env`. Set a random `JWT_SECRET` of at least 32 characters, a manager username/password (12+ characters), your LAN IPv4 in `ALLOWED_HOSTS`, and the Mosquitto backend account settings. `.env` is ignored by Git.
4. Copy `broker/acl.example` to `broker/acl`. Create a Mosquitto password file with two users: `waste-device` for the four ESP32 boards and `waste-backend` for Django. For example, from PowerShell (replace the passwords):

   ```powershell
   & 'C:\Program Files\mosquitto\mosquitto_passwd.exe' -c -b broker\passwords waste-device 'DEVICE_PASSWORD'
   & 'C:\Program Files\mosquitto\mosquitto_passwd.exe' -b broker\passwords waste-backend 'BACKEND_PASSWORD'
   ```

   Copy `broker/mosquitto.conf.example` to `broker/mosquitto.conf` and replace both `C:/ABSOLUTE/PATH/smart-waste-management` placeholders with the project's absolute path, using forward slashes. Put the backend account/password in `.env` as `MQTT_USER` and `MQTT_PASSWORD`.
5. Start Mosquitto in one terminal:

   ```powershell
   & 'C:\Program Files\mosquitto\mosquitto.exe' -c "$(Resolve-Path broker\mosquitto.conf)" -v
   ```

6. Start Django in another terminal from the project folder:

   ```powershell
   cd backend
   ..\.venv\Scripts\python.exe manage.py seed
   ..\.venv\Scripts\python.exe -m uvicorn config.asgi:application --host 0.0.0.0 --port 3000
   ```

7. Open `http://127.0.0.1:3000/`. For hot reload during frontend work, run `npm run dev` in `frontend/` and open `http://127.0.0.1:5173/`; Vite proxies `/api` and `/ws` to Django. Rebuild React with `npm run build` to update the page Django serves on port 3000.

Run **one Django ASGI worker** with this local setup. Channels uses an in-memory layer, so multiple workers would not share live events. For deployment beyond a local project, use a shared channel layer such as Redis, TLS, stronger broker identities and monitoring. [Channels documents the in-memory layer as local-development only](https://channels.readthedocs.io/en/latest/topics/channel_layers.html).

## ESP32 setup in Arduino IDE

Open `firmware/smart_bin_mqtt/smart_bin_mqtt.ino`. Set WiFi SSID/password, `MQTT_HOST` to the computer's LAN IPv4 address, the `waste-device` broker password, and the matching `BIN_ID` and `SENSOR_KEY`. Change only `BIN_ID` and `SENSOR_KEY` between the four boards. The bin IDs are `bin1` to `bin4`. Use `ipconfig` on the server PC to find its WiFi adapter's IPv4 address. An ESP32 cannot reach the PC at `localhost` and must use **2.4 GHz WiFi**.

| HC-SR04 | ESP32 |
|---|---|
| VCC | Suitable 5V/VIN supply |
| GND | Shared GND |
| TRIG | GPIO 5 |
| ECHO | GPIO 18 **through a voltage divider** |

Put **1 kΩ** between HC-SR04 ECHO and GPIO 18, and **2 kΩ** between GPIO 18 and GND. This reduces the sensor's 5V ECHO to about 3.33V. Never connect ECHO directly to an ESP32 GPIO. Mount the sensor at the lid pointing down. The default 40 cm height is the measured distance from sensor to empty-bin surface. Match the firmware `BIN_HEIGHT_CM` and the bin height recorded in the manager UI. Open Serial Monitor at **115200 baud**.

Each board publishes a JSON reading every five seconds to `waste/bins/<bin_id>/readings`. The payload includes bin ID, fill percentage and that bin's key. Django rejects unknown bins, incorrect keys and values outside 0–100. The MQTT publish is QoS 0; a disconnected board skips a reading and reconnects automatically. After more than 30 seconds without a reading, the bin shows offline. Default statuses: under 50 normal, 50–80 filling, above 80 full. Each bin's full threshold is editable.

## Accounts, tasks and data

The seeded manager can view history and reports, manage bins and staff, and assign tasks. Staff see only their own tasks, bin locations and current fill levels. They can move pending → in progress → completed. Completing a task records `emptied_at` and suppresses the full alert while the next sensor reading is pending; if the next reading is still full, the alert returns. The app cannot empty a bin physically.

### Public home page

The home page is available without signing in. It uses the supplied Vyas municipal letterhead image for the two seal details and displays the heading **व्यास नगरपालिका / नगर फोहोर व्यवस्थापन विभाग**. The important notice appears immediately below the heading, followed by information about the system, waste-awareness points, and a tole search. A visitor enters a tole name to see registered bins in that tole, their latest fill percentage, status, and last update time. Offline bins show a note that their reading may be old. The lookup refreshes every 15 seconds while a search is active.

Managers can open **Landing content** in their dashboard to edit all public text, including the heading, notice, awareness points, and search instructions. In **Manage bins**, set each bin's **Tole name (public lookup)**. Existing sample bins have placeholder locations but no verified tole assignment, so they stay out of public search until a manager enters real tole names. Public endpoints are `GET /api/public/content` and `GET /api/public/bins?tole=...`; saving content is manager-only at `PUT /api/site-content`.

Passwords use bcrypt. An eight-hour JWT authorizes REST and the WebSocket. The React tab keeps its token in session storage. The manager receives all live events; staff receive their own task events and reading updates for bins in their active tasks. Every reading is stored at five-second resolution for 24 hours; older data is averaged per bin per hour and removed after 30 days.

## Checks and troubleshooting

Run backend tests from `backend/` with `..\.venv\Scripts\python.exe -m pytest -q`. With Mosquitto and Django running, run `..\.venv\Scripts\python.exe tests\live_smoke.py` to create a disposable test bin, publish through the broker, verify SQLite and a live WebSocket event, then remove that test bin. `GET /api/health` reports whether Django is connected to Mosquitto.

| Symptom | Check |
|---|---|
| Bin offline | ESP32 power, 2.4 GHz WiFi, sensor echo, Serial Monitor, broker connection and MQTT topic/key. |
| MQTT connect failed | Broker host/port, `waste-device` username/password, Mosquitto log and Windows Private-network firewall on TCP 1883. |
| Website unreachable from phone | PC IPv4 address, Windows Private-network firewall on TCP 3000, `ALLOWED_HOSTS` including that IP, and WiFi client isolation. |
| Django health says `mqtt_connected: false` | Start Mosquitto and check `.env` backend broker credentials/ACL. |
| Reading rejected | Topic and payload bin IDs must match; bin must be registered; key must match; fill must be an integer 0–100. |
| React change not visible on port 3000 | Run `npm run build` in `frontend/`, then refresh the page. |

Possible later extensions: MQTT over TLS with separate broker identities for each board, GPS coordinates, gas sensors, email or Telegram alerts, and collection-truck route planning.
