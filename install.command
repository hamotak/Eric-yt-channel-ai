#!/bin/bash
set -e
cd "$(dirname "$0")"

echo
echo "===================================="
echo "  Lat Media Ideation Tool - Installation"
echo "===================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "Please install Node.js 20+ from https://nodejs.org/"
  echo "Then run this script again."
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

echo "Detected $(node -v)"
echo

echo "Installing dependencies. This may take 2-5 minutes..."
echo
if ! npm install; then
  echo
  echo "[ERROR] npm install failed. See messages above."
  echo
  echo "Common fixes:"
  echo "  - Delete the node_modules folder and re-run this script"
  echo "  - Make sure you have a stable internet connection"
  echo "  - On older macOS, you may need Xcode Command Line Tools:"
  echo "      xcode-select --install"
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

echo
echo "===================================="
echo "  Installation complete!"
echo "  Double-click start.command to launch."
echo "===================================="
echo
read -n 1 -s -r -p "Press any key to close..."
