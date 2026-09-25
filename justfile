# justfile — atajos del proyecto. Escribe `just` para ver la lista.
#
# Funciona igual en Windows (PowerShell) que en macOS/Linux (sh): las variables de entorno van como parámetros `$VAR`
# de recetas privadas (las que empiezan por `_`), nunca con la sintaxis de un shell concreto. Los puertos van fijos:
# Ponder lee PORT antes que su --port, así que las recetas le dan PORT; Next atiende a --port antes que a PORT.

set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Receta por defecto: lista las disponibles
default:
    just --list --unsorted

# Instala dependencias y genera lo que el repositorio no guarda: el paquete compartido (@poa/shared), del que
# dependen todos los demás, y los tipos del indexador (ponder-env.d.ts)
[group('preparar')]
install:
    pnpm install
    pnpm --filter @poa/shared build
    pnpm --filter @poa/indexer codegen

# Lint, tipos, tests de la web y de los contratos (no necesita cadena ni servicios)
[group('preparar')]
check:
    pnpm lint
    pnpm typecheck
    pnpm --filter @poa/app test
    pnpm contracts:test

# Frontend con datos de ejemplo en :3000 (no necesita indexador ni cadena)
[group('testnet')]
front: _front

# Stack completo contra Base Sepolia: indexador (:42069) + web (:3000), con datos reales de la testnet
[group('testnet')]
stack: _stack

# Instala, construye todo y arranca el stack completo (Base Sepolia)
[group('testnet')]
up: install
    pnpm build
    just stack

# Cadena local (anvil, id 31337); guarda su estado en .data/ para que sobreviva a un reinicio
[group('local')]
chain:
    node -e "require('fs').mkdirSync('.data', { recursive: true })"
    anvil --chain-id 31337 --block-time 1 --state .data/anvil-state.json --state-interval 30

# Despliega el sistema en la cadena local y siembra los datos de demo (con `just chain` en otra terminal)
[group('local')]
deploy-local:
    pnpm deploy:local

# Los escenarios de demo contra la cadena local, con el enlace de cada transacción
[group('local')]
demo: _demo

# Stack local: indexador (:42070) + web (:3001) contra anvil; puede ir a la vez que `just stack`
[group('local')]
local: _local

# Stack contra Base mainnet, el despliegue real: indexador (:42071) + web (:3002); convive con `stack` y `local`
[group('mainnet')]
mainnet: _mainnet

# Postgres y los servicios (pii-vault, notifier) en Docker
[group('servicios')]
services:
    pnpm services:up

# Para los servicios de Docker
[group('servicios')]
services-down:
    pnpm services:down

# Sin DEMO_NETWORK, pnpm demo:run va contra Base Sepolia: aquí se fija la cadena local.
_demo $DEMO_NETWORK="anvil":
    pnpm demo:run

_front $NEXT_PUBLIC_USE_FIXTURES="1":
    pnpm --filter @poa/app dev --port 3000

_stack $PONDER_NETWORK="base-sepolia" $PORT="42069":
    pnpm dlx concurrently -n "indexer,app" -c "cyan,green" "pnpm --filter @poa/indexer dev --port 42069" "pnpm --filter @poa/app dev --port 3000"

# Carpetas propias (.ponder/anvil, .next-anvil) para no pisar al stack de la testnet. La clave del relayer es la de la
# cuenta #9 de anvil, pública y solo para la cadena local: la de app/.env.local es de la testnet y aquí no tiene fondos.
_local $PONDER_NETWORK="anvil" $PONDER_RPC_URL="http://127.0.0.1:8545" $PONDER_PGLITE_DIR=".ponder/anvil" $NEXT_PUBLIC_CHAIN_ID="31337" $NEXT_PUBLIC_RPC_URL="http://127.0.0.1:8545" $NEXT_PUBLIC_INDEXER_URL="http://localhost:42070" $NEXT_DIST_DIR=".next-anvil" $RELAYER_PRIVATE_KEY="0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" $PORT="42070":
    pnpm dlx concurrently -n "indexer,app" -c "cyan,green" "pnpm --filter @poa/indexer dev --port 42070" "pnpm --filter @poa/app dev --port 3001"

# Carpetas propias (.ponder/base, .next-mainnet) para no pisar a los otros stacks. Sin RELAYER_PRIVATE_KEY los votos
# gratuitos quedan desactivados; todo lo demás funciona con la cartera de cada uno.
_mainnet $PONDER_NETWORK="base" $PONDER_RPC_URL="https://mainnet.base.org" $PONDER_PGLITE_DIR=".ponder/base" $NEXT_PUBLIC_CHAIN_ID="8453" $NEXT_PUBLIC_INDEXER_URL="http://localhost:42071" $NEXT_DIST_DIR=".next-mainnet" $PORT="42071":
    pnpm dlx concurrently -n "indexer,app" -c "cyan,green" "pnpm --filter @poa/indexer dev --port 42071" "pnpm --filter @poa/app dev --port 3002"
