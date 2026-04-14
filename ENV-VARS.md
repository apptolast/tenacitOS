# TenacitOS - Environment Variables (rama apptolast)

Lista de variables de entorno que necesita el container `tenacitos` (sidecar del pod openclaw en el cluster apptolast K8s). Se inyectan via:

- **ConfigMap** `mission-control-tenacitos-config` (valores no sensibles)
- **Secret** `mission-control-tenacitos-credentials` (ADMIN_PASSWORD + AUTH_SECRET)

## Auth (REQUERIDOS - inyectados via Secret)

| Variable | Origen | Notas |
|---|---|---|
| `ADMIN_PASSWORD` | Secret `mission-control-tenacitos-credentials` | Password para login en TenacitOS. **NUNCA en repo ni en imagen.** |
| `AUTH_SECRET` | Secret `mission-control-tenacitos-credentials` | 32-char random string para firmar cookies. Generar con `openssl rand -hex 16`. **NUNCA en repo.** |

## OpenClaw paths (REQUERIDOS - inyectados via ConfigMap)

| Variable | Valor en producción AppToLast | Notas |
|---|---|---|
| `OPENCLAW_DIR` | `/home/node/.openclaw` | Override del default `/root/.openclaw` upstream |
| `OPENCLAW_WORKSPACE` | `/home/node/.openclaw/workspace` | Workspace base (TenacitOS busca `workspace-*` para sub-agentes) |

## Branding AppToLast (NO sensitive - en ConfigMap)

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_AGENT_NAME` | `Kubito` |
| `NEXT_PUBLIC_AGENT_EMOJI` | `☸️` |
| `NEXT_PUBLIC_AGENT_DESCRIPTION` | `AI co-pilot para AppToLast - powered by OpenClaw` |
| `NEXT_PUBLIC_AGENT_LOCATION` | `Hetzner Cluster (RKE2)` |
| `NEXT_PUBLIC_BIRTH_DATE` | `2026-02-18` |
| `NEXT_PUBLIC_OWNER_USERNAME` | `PabloHurtadoGonzalo86` |
| `NEXT_PUBLIC_TWITTER_HANDLE` | `@apptolast` |
| `NEXT_PUBLIC_COMPANY_NAME` | `APPTOLAST` |
| `NEXT_PUBLIC_APP_TITLE` | `Mission Control - AppToLast` |

## Runtime (defaults del Dockerfile)

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `HOSTNAME` | `0.0.0.0` |
| `NEXT_TELEMETRY_DISABLED` | `1` |

## Generación de AUTH_SECRET

```bash
openssl rand -hex 16
# Ejemplo de output: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

## Como crear el Secret en K8s

```bash
kubectl create secret generic mission-control-tenacitos-credentials \
  --from-literal=ADMIN_PASSWORD='<password>' \
  --from-literal=AUTH_SECRET="$(openssl rand -hex 16)" \
  -n openclaw
```

El Secret debe existir ANTES de aplicar el Deployment con el sidecar.

## Como inyectar en el Deployment

Ver `apptolast/OpenClawAppToLast/k8s/openclaw/04-deployment.yaml` seccion `containers[name=tenacitos]`:

```yaml
- name: tenacitos
  image: ghcr.io/apptolast/tenacitos:apptolast
  env:
    - name: OPENCLAW_DIR
      value: /home/node/.openclaw
    - name: OPENCLAW_WORKSPACE
      value: /home/node/.openclaw/workspace
    - name: NEXT_PUBLIC_AGENT_NAME
      value: "Kubito"
    # ... resto de NEXT_PUBLIC_*
    - name: ADMIN_PASSWORD
      valueFrom:
        secretKeyRef:
          name: mission-control-tenacitos-credentials
          key: ADMIN_PASSWORD
    - name: AUTH_SECRET
      valueFrom:
        secretKeyRef:
          name: mission-control-tenacitos-credentials
          key: AUTH_SECRET
  ports:
    - name: tenacitos
      containerPort: 3000
  volumeMounts:
    - name: openclaw-data
      mountPath: /home/node/.openclaw
  livenessProbe:
    httpGet:
      path: /api/health
      port: 3000
    initialDelaySeconds: 30
    periodSeconds: 30
  readinessProbe:
    httpGet:
      path: /api/health
      port: 3000
    initialDelaySeconds: 15
    periodSeconds: 10
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1
      memory: 768Mi
```
