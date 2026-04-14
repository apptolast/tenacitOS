# Branch `apptolast` — TenacitOS adaptado para AppToLast

Esta rama contiene la adaptacion de TenacitOS para el despliegue Kubernetes de **AppToLast** sobre OpenClaw v2026.4.x.

## Diferencias vs `main` (upstream)

| Cambio | Motivo |
|---|---|
| `Dockerfile` (multi-stage Next.js 16 standalone + better-sqlite3 native) | Upstream no tiene Dockerfile; lo necesitamos para correr como sidecar K8s |
| `.dockerignore` | Excluir build artifacts, .git, .env files |
| `next.config.mjs` con `output: 'standalone'` y `serverExternalPackages: ['better-sqlite3']` | Necesario para Docker minimal sin node_modules completo |
| `src/app/(dashboard)/terminal/page.tsx` paths `/root/.openclaw` -> `/home/node/.openclaw` | Nuestro pod openclaw monta el PVC en `/home/node/.openclaw` (uid 1000) |
| `.github/workflows/build-and-push.yml` | Build + push automatico a GHCR (`ghcr.io/apptolast/tenacitos`) en cada push a esta rama |
| `Dockerfile` USER uid 1000:1000 | Mismo uid que el container `openclaw` del pod (compartir filesystem PVC sin lios de permisos) |

## Sincronizacion con upstream

Para traer cambios nuevos del upstream `carlosazaustre/tenacitOS`:

```bash
# Una sola vez: anadir upstream remote
git remote add upstream https://github.com/carlosazaustre/tenacitOS.git

# Cada vez que quieras sincronizar:
git fetch upstream
git checkout apptolast
git rebase upstream/main
# Resolver conflictos manuales si los hay (probable en next.config.mjs y src/lib/paths.ts)
git push --force-with-lease origin apptolast
```

El push a `apptolast` triggerea automaticamente el GitHub Action que hace build+push de la imagen.

## Imagen Docker

Published a **Docker Hub** (no GHCR) usando secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` ya configurados en el repo.

| Tag | Cuando se actualiza |
|---|---|
| `apptolast/tenacitos:apptolast` | En cada push a esta rama (rolling tag) |
| `apptolast/tenacitos:apptolast-<sha7>` | En cada build, immutable, recomendado para K8s |
| `apptolast/tenacitos:latest` | En cada push a esta rama |

## Despliegue en K8s

Ver `apptolast/OpenClawAppToLast/k8s/openclaw/04-deployment.yaml` — el container `tenacitos` se anade como sidecar del pod `openclaw`, comparte el PVC `openclaw-data`, y se expone via Traefik en `control.apptolast.com`.

Variables de entorno requeridas en el container — ver `ENV-VARS.md`.

## Notas

- **Auth**: TenacitOS auth nativa (`ADMIN_PASSWORD` + `AUTH_SECRET`). Quitamos el BasicAuth de Traefik que tenia el viejo Mission Control.
- **PVC**: el sidecar monta `/home/node/.openclaw` desde el mismo PVC que el container openclaw (Longhorn RWO con multi-mount intra-pod).
- **fsGroup**: heredado del pod (`1000`), permite a tenacitos leer/escribir archivos del workspace.
- **Coexistencia**: TenacitOS coexiste con el container `openclaw` y el sidecar `gateway-proxy` (socat). Total 3 containers + N init containers en el pod.
