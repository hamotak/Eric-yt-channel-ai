#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "Please install Node.js 20+ from https://nodejs.org/"
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[INFO] Dependencies not found. Installing first..."
  npm install
fi

echo
echo "===================================="
echo "  Starting Lat Media Ideation Tool..."
echo "  The app will open in your browser."
echo "  Close this window to stop the server."
echo "===================================="
echo

# Open the browser a few seconds after `npm run dev` boots — Next 16's
# cold start is 3-5s and opening too early just shows "site can't be
# reached". The xdg-open / open fallback chain keeps this working on
# Linux too if anyone runs the script there.
(
  sleep 5
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3000"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:3000"
  fi
) &
npm run dev
