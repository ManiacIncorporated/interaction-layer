#!/bin/bash
# Build nowplaying-monitor as a minimal background .app bundle. MediaRemote only
# grants remote commands (the AirPod play/pause taps) to a real bundled NSApplication,
# so a bare CLI binary won't work — it must live inside this .app.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/nowplaying-monitor.app"
MACOS="$APP/Contents/MacOS"
mkdir -p "$MACOS"
swiftc -O "$HERE/nowplaying-monitor.swift" -o "$MACOS/nowplaying-monitor"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>nowplaying-monitor</string>
  <key>CFBundleIdentifier</key><string>com.maniacincorporated.interaction-layer.nowplaying</string>
  <key>CFBundleName</key><string>Claude Conductor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><false/>
</dict>
</plist>
PLIST
# ad-hoc sign so MediaRemote/Gatekeeper treats it as a real app
codesign --force --deep -s - "$APP" 2>/dev/null || true
echo "built $APP"
