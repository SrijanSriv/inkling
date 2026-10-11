#!/bin/sh
# Run as root once, after downloading the model. Reuses the existing system service.
set -eu
root=${1:?Pass the existing whisper.cpp directory}
case "$root" in *[!a-zA-Z0-9_./-]*) echo 'Unsupported path'; exit 1;; esac
test "$(id -u)" = 0
test -x "$root/build/bin/whisper-server"
test -f "$root/models/ggml-small.bin"
mkdir -p /etc/systemd/system/whisper-server.service.d
cat > /etc/systemd/system/whisper-server.service.d/inkling.conf <<EOF
[Service]
ExecStart=
ExecStart=$root/build/bin/whisper-server -m $root/models/ggml-small.bin --host 127.0.0.1 --port 8081 -l auto -t 4
StandardOutput=null
StandardError=null
EOF
systemctl daemon-reload
systemctl restart whisper-server.service
systemctl is-active whisper-server.service
