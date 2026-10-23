#!/bin/sh
# Parcours d'audit arbres boostés sur chaîne Hardhat locale (enclave TDX simulée).
# Usage, depuis la racine du dépôt : sh audit/parcours/run.sh
# Linux ou macOS (ou WSL) : le budget runner exige des permissions POSIX (répertoire 0700).
set -e
cd "$(dirname "$0")/../.."
(cd contracts && npx hardhat compile)
NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/parcours/gbdt-flow.test.ts
