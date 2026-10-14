#!/bin/sh
# Linux runner integration and end-to-end checks in a disposable container with a tmpfs /workspaces.
# This is container evidence only; it is not a Codespaces acceptance run. Run `npm run build` first.
set -eu
engine=$(command -v podman || command -v docker) || { echo 'podman or docker is required' >&2; exit 2; }
node_bin=$(dirname "$(readlink -f "$(command -v node)")")
image=${IMAGE:-docker.io/library/python:3.12-bookworm}
exec "$engine" run --rm -v "$PWD:/src" -v "$(dirname "$node_bin"):/opt/node:ro" --security-opt label=disable -w /src --tmpfs /workspaces:rw,exec "$image" \
  sh -c 'export PATH=/opt/node/bin:$PATH && git --version && python3 tests/runner_test.py && node --test tests/e2e_linux.test.mjs'
