# justfile — atajos del proyecto. Escribe `just` para ver la lista.

set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Receta por defecto: lista las disponibles
default:
    just --list

# Instala dependencias
install:
    pnpm install

# Frontend con datos de ejemplo (no necesita indexador ni cadena)
front:
    pnpm --filter '@poa/app' dev

# Stack completo contra Base Sepolia: indexador + web, con datos reales de la testnet
stack:
    pnpm dlx concurrently -n indexer,app -c cyan,green "pnpm --filter @poa/indexer dev" "pnpm --filter @poa/app dev"

# Instala, construye todo y arranca el stack completo (Base Sepolia)
up: install
    pnpm build
    just stack