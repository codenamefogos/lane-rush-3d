# Lane Rush 3D — Endless Traffic Dodger

A complete, playable 3D car-driving endless-runner (Subway Surfers–style but with a car),
built on Three.js/WebGL — the same graphics API Unity's WebGL build target uses. No Unity
Editor required to play or test; ready to package for Android & iOS.

## Files
- `index.html` – UI, screens, HUD, styles
- `game.js` – full 3D engine: road generation, traffic/obstacle/coin spawning, physics,
  collisions, camera, input (keyboard + touch swipe + on-screen buttons), audio (synth SFX), save data
- `manifest.json`, `icon-192.png`, `icon-512.png` – PWA/installable app metadata

## How to Play
- **Move**: swipe left/right, A/D, arrow keys, or on-screen arrow buttons
- **Jump**: swipe up, W/Space/Up, or the green button (clears cones & barriers)
- **Duck**: swipe down, S/Down, or the down button (slides under overhead beams)
- Collect coins, dodge traffic & obstacles, speed ramps up over time
- Coins earned unlock new car skins in the Garage

## Run Locally
```bash
cd dist
python3 -m http.server 8080
# open http://localhost:8080
```

---

## Packaging for Android & iOS (no Unity needed)

This is a standard web build, so the fastest path to app stores is **Capacitor**
(Ionic's native wrapper) — it takes this exact `dist/` folder and produces real
Android (.apk/.aab) and iOS (.ipa) projects.

### 1. Set up Capacitor
```bash
npm init -y
npm install @capacitor/core @capacitor/cli
npx cap init "Lane Rush 3D" "com.yourcompany.lanerush3d" --web-dir=dist
```

### 2. Add platforms
```bash
npm install @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios
```

### 3. Sync & open in native IDEs
```bash
npx cap sync
npx cap open android   # opens Android Studio -> Build > Generate Signed Bundle/APK
npx cap open ios       # opens Xcode -> Product > Archive
```

Requirements: Android Studio (Android) and a Mac with Xcode (iOS). Both projects build
this WebGL game inside a native WebView with full-screen, offline-capable behavior.

### 4. Recommended Capacitor config tweaks (`capacitor.config.json`)
```json
{
  "appId": "com.yourcompany.lanerush3d",
  "appName": "Lane Rush 3D",
  "webDir": "dist",
  "android": { "allowMixedContent": false },
  "ios": { "contentInset": "always" },
  "plugins": {
    "SplashScreen": { "launchAutoHide": true, "backgroundColor": "#0B1020" }
  }
}
```

---

## If You Specifically Need a Unity Project

This deliverable is a finished game (Three.js/WebGL), not a `.unity` project — building
the equivalent natively in the Unity Editor (C#, scenes, prefabs, Unity's URP, Unity
WebGL export pipeline) is a multi-day asset-and-editor task that can't be produced as
plain text files here. The structure maps directly if you want to port it later:

| Here (Three.js)              | Unity equivalent                          |
|-------------------------------|--------------------------------------------|
| `game.js` state machine        | `GameManager.cs` (singleton, enum states)  |
| `buildCarMesh()`                | Player car Prefab + `PlayerController.cs`  |
| `createRoadChunk()` + recycling | Pooled road-segment Prefabs + `RoadSpawner.cs` |
| `activeTraffic/Obstacles/Coins` | Object pools + `TrafficSpawner.cs`, `CoinPickup.cs` |
| AABB collision in `checkCollisions()` | Unity `BoxCollider` + `OnTriggerEnter` |
| `LANE_X` lane math               | Same constant-array approach in C#         |
| `localStorage` save               | `PlayerPrefs`                              |
| CSS HUD overlay                   | Unity UI Canvas (uGUI)                     |

Porting: create a 3-lane plane, recreate the box/cylinder primitives as prefabs (or swap
for purchased car/road assets), recreate `CONFIG` values as a `BalanceConfig`
ScriptableObject, then implement the table's C# scripts using this file's logic as the
spec. Unity's **File > Build Settings > WebGL** then produces the same kind of output
this project already is, and Unity's Android/iOS export does the native packaging
Capacitor does above.

## Customization Knobs (in `game.js`, top of file)
- `CONFIG.baseForwardSpeed` / `maxForwardSpeed` / `speedRampPerSec` — difficulty curve
- `CONFIG.laneCount` / `laneWidth` — road layout
- `CAR_SKINS` — add/edit unlockable cars (id, name, price, colors)
- `CONFIG.coinSpawnChance` / `obstacleSpawnChance` / `trafficSpawnChance` — density
