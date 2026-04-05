#!/usr/bin/env bash
set -euo pipefail

REPO="adoroburrito/code-indexer"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS-$ARCH" in
  linux-x86_64)  BINARY="code-indexer-linux-x64" ;;
  darwin-x86_64) BINARY="code-indexer-macos-x64" ;;
  darwin-arm64)  BINARY="code-indexer-macos-arm64" ;;
  *)
    echo "Unsupported platform: $OS/$ARCH"
    echo "Download manually from: https://github.com/$REPO/releases"
    exit 1
    ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$BINARY"
echo "Downloading $BINARY..."
curl -fsSL "$URL" -o /tmp/code-indexer
chmod +x /tmp/code-indexer

if [ -w "$INSTALL_DIR" ]; then
  mv /tmp/code-indexer "$INSTALL_DIR/code-indexer"
else
  sudo mv /tmp/code-indexer "$INSTALL_DIR/code-indexer"
fi

echo "Installed: $(which code-indexer)"
