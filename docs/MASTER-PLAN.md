# Master Plan — Attest

> **Versión:** 1.0 · 2026-08-07
> **Norte de producto:** [`docs/mockup-futuro.html`](mockup-futuro.html) — 13 páginas, dark mode, i18n, multi-tenant
> **Landing de ventas:** [`docs/landing-page.html`](landing-page.html)
> **MVP actual:** `https://roledict.fly.dev` — backend completo, UI básica con sidebar
>
> ⚠️ Este documento reemplaza al `Plan-Mejora-RoleDictionaryApp.md` original (archivado como referencia histórica de la migración desde GCP).

---

## 🎯 Visión

**Attest** es una plataforma SaaS de Access Certification & Role Governance que permite a equipos de compliance, auditoría interna y seguridad ejecutar campañas de revisión de accesos en horas, con trazabilidad completa y evidencia lista para auditor externo.

El mockup [`mockup-futuro.html`](mockup-futuro.html) **es el plano**. Cada decisión de arquitectura, desarrollo y diseño debe acercar la app real a esa experiencia.

---

## 📐 Lo que YA existe (MVP — Fase 0)

| Capa | Componente | Estado |
|---|---|---|
| **Backend** | `server.js` — Express + JWT auth + todas las API routes | ✅ Producción |
| **Persistencia** | SQLite (`better-sqlite3`) en volumen Fly.io | ✅ Producción |
| **Datos** | `dataStore.js` — lectura Excel local + upload via API | ✅ Producción |
| **Auth** | JWT login/signup (`/api/auth`) + `login.html` | ✅ Producción |
| **Frontend core** | `index.html` — sidebar + tabla de revisión + stats | ✅ Producción |
| **Frontend admin** | `admin.html` — audit trail + filtros + upload Excel | ✅ Producción |
| **Frontend aux** | `activity.html`, `admin-users.html` con sidebar | ✅ Producción |
| **CSS** | Sistema de diseño con variables, light/dark, componentes | ✅ Producción |
| **Deploy** | Fly.io + Docker + volumen persistente | ✅ Producción |

**Lo que NO existe aún** (y el mockup muestra): dashboard analytics, sistema de campañas, SoD engine, multi-tenant, onboarding/offboarding, evidence locker, SSO, notificaciones, i18n, API keys, white-label.

---

## 🗺️ Fases del Master Plan

Cada fase produce una versión desplegable y funcional. No se avanza a la siguiente sin validar la anterior.

```
Fase 1 ░░░░░░░░░░░░ Dashboard & Analytics
Fase 2 ░░░░░░░░░░░░ Campaign Management System
Fase 3 ░░░░░░░░░░░░ SoD Engine + Evidence Locker  
Fase 4 ░░░░░░░░░░░░ Multi-Tenant Architecture
Fase 5 ░░░░░░░░░░░░ Enterprise Features (SSO, i18n, Notifications, API)
Fase 6 ░░░░░░░░░░░░ Polish & Launch
```

---

## Fase 1 — Dashboard & Analytics (3-4 días)

**Objetivo:** Implementar la página de Dashboard del mockup con KPIs reales, gráfico de progreso por sistema, actividad reciente, y campañas activas.

### Backend

| Endpoint | Descripción |
|---|---|
| `GET /api/dashboard/stats` | KPIs agregados: total roles, % certificación, acciones pendientes, SoD conflicts |
| `GET /api/dashboard/progress-by-system` | Progreso de certificación agrupado por sistema (SAP, Oracle, AWS, etc.) |
| `GET /api/dashboard/recent-activity` | Últimos 10 eventos del activity log |
| `GET /api/dashboard/active-campaigns` | Campañas activas con progreso |

### Frontend

- Nueva página `dashboard.html` como landing post-login
- 4 stat cards con datos reales del backend
- Gráfico de barras SVG con progreso por sistema
- Timeline de actividad reciente
- Cards de campañas activas con barra de progreso
- Sidebar actualizado: "Dashboard" como primer ítem activo

### Validación

- [ ] El dashboard carga con datos reales de la BD
- [ ] Los KPIs reflejan el estado actual de revisiones
- [ ] El gráfico de barras muestra sistemas reales del Excel cargado
- [ ] La actividad reciente coincide con el activity log

---

## Fase 2 — Campaign Management System (4-5 días)

**Objetivo:** Implementar el sistema de campañas de certificación. Este es el core diferenciador de la plataforma.

### Backend

| Endpoint | Descripción |
|---|---|
| `POST /api/campaigns` | Crear campaña (nombre, framework, deadline, approvers, plantilla) |
| `GET /api/campaigns` | Listar campañas con filtros |
| `GET /api/campaigns/:id` | Detalle de campaña con progreso por approver |
| `PATCH /api/campaigns/:id` | Actualizar campaña (estado, deadline) |
| `POST /api/campaigns/:id/send-reminders` | Enviar recordatorios a aprobadores pendientes |

### Tabla SQLite nueva

```sql
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT DEFAULT 'default',
  name TEXT NOT NULL,
  framework TEXT NOT NULL,        -- SOX, ISO27001, SOC2, GDPR, NIST, COBIT
  period TEXT NOT NULL,           -- Q3 2026, H2 2026, Annual 2026
  status TEXT DEFAULT 'draft',    -- draft, active, completed, archived
  deadline TEXT,
  approvers TEXT NOT NULL,        -- JSON array of approver names
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Frontend

- Página `campaigns.html` con tabla de campañas (mockup: "Campaigns")
- Modal "New Campaign" con formulario: nombre, framework, período, deadline, approvers
- Dropdown de plantillas guardables
- Campaña activa → los approvers ven sus roles filtrados por campaña en "My Reviews"
- Progress tracking por campaña en dashboard

### Validación

- [ ] Crear campaña con 5 approvers → cada uno ve solo sus roles asignados
- [ ] Cerrar campaña → las submissions quedan marcadas con campaign_id
- [ ] Dashboard refleja progreso de la campaña activa

---

## Fase 3 — SoD Engine + Evidence Locker (4-5 días)

**Objetivo:** Implementar detección de conflictos de segregación de funciones y el archivado de evidencia para auditores.

### SoD Engine (Backend)

| Endpoint | Descripción |
|---|---|
| `GET /api/sod/rules` | Listar reglas de SoD configuradas |
| `POST /api/sod/rules` | Crear regla (ej: "AP Clerk + GL Accountant = conflicto") |
| `GET /api/sod/conflicts` | Listar conflictos detectados |
| `PATCH /api/sod/conflicts/:id` | Mitigar/resolver conflicto |

### Tabla SQLite

```sql
CREATE TABLE sod_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_a TEXT NOT NULL,
  role_b TEXT NOT NULL,
  severity TEXT DEFAULT 'high',  -- critical, high, medium
  description TEXT,
  framework TEXT DEFAULT 'SOX'
);

CREATE TABLE sod_conflicts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  approver_name TEXT NOT NULL,
  role_a TEXT NOT NULL,
  role_b TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT DEFAULT 'open'     -- open, mitigated, false_positive
);
```

### Evidence Locker (Backend + Frontend)

- Página `evidence.html` — lista de paquetes de evidencia generados
- `POST /api/evidence/generate` — genera ZIP con PDFs + CSV + audit log
- `GET /api/evidence/:id/download` — descarga paquete
- `POST /api/evidence/:id/share` — genera link temporal para auditor externo

### Frontend

- Página `sod.html` — tabla de conflictos con severidad, mitigación (mockup: "SoD Conflicts")
- Página `evidence.html` — locker de evidencia con acceso compartido (mockup: "Evidence Locker")
- Badges de conflicto en "My Reviews" (rol flageado en rojo)

### Validación

- [ ] Crear regla SoD → se detecta automáticamente al hacer submit de revisión
- [ ] Generar paquete de evidencia → descarga ZIP con PDFs y CSV
- [ ] Compartir con auditor → link temporal funciona

---

## Fase 4 — Multi-Tenant Architecture (5-6 días)

**Objetivo:** Soportar múltiples organizaciones en una sola instancia. Cada tenant ve solo sus datos. Base para el modelo SaaS.

### Backend

- Columna `tenant_id` en TODAS las tablas: `submissions`, `activity`, `admin_users`, `campaigns`, `sod_rules`, `sod_conflicts`
- Tabla `tenants`: id, name, plan (starter/professional/enterprise), status, created_at
- Middleware `tenantMiddleware`: extrae `tenant_id` del JWT o header `X-Tenant-ID`
- Todas las queries agregan `WHERE tenant_id = ?`
- Seed de tenant "default" para migración de datos existentes
- `POST /api/tenants` — crear tenant (admin only)
- `GET /api/tenants` — listar tenants

### Frontend

- Selector de tenant en sidebar (mockup: dropdown "Acme Corporation")
- Página `tenants.html` — gestión de tenants (mockup: "Tenants")
- Cada tenant tiene sus propias campañas, submissions, y configuración
- Admin global puede cambiar entre tenants

### Validación

- [ ] Crear 2 tenants → datos completamente aislados
- [ ] Cambiar de tenant en sidebar → solo se ven datos de ese tenant
- [ ] Las submissions del tenant A no aparecen en tenant B

---

## Fase 5 — Enterprise Features (5-7 días)

**Objetivo:** Completar las capacidades enterprise del mockup: SSO, notificaciones, i18n, API keys, white-label, onboarding/offboarding.

### 5.1 SSO (SAML/OIDC)

- Página `settings.html` con toggles de SSO (mockup: "Configuration")
- `POST /api/settings/sso` — configurar SAML/OIDC
- Integración con Azure AD, Okta, PingID via `passport-saml` / `openid-client`
- Toggles en UI para SAML, OIDC, AD Sync

### 5.2 Notificaciones Email

- `POST /api/settings/notifications` — configurar preferencias
- Envío vía Nodemailer + SMTP (SendGrid free tier como fallback)
- Recordatorios automáticos: 7, 3, 1 día antes del deadline
- Alertas de SoD conflict detectado
- Notificación de paquete de evidencia listo

### 5.3 Internacionalización (i18n)

- Selector de idioma EN/ES en topbar (mockup)
- Archivos `locales/en.json` y `locales/es.json`
- Función `t(key)` en frontend que lee del locale activo
- Traducción completa de UI: sidebar, botones, labels, mensajes

### 5.4 API Keys

- Página `api-keys.html` (mockup: "API Keys")
- `POST /api/api-keys` — generar key (read-only audit, read+write RITM, health check)
- `DELETE /api/api-keys/:id` — revocar key
- Middleware `apiKeyAuth`: verifica `X-API-Key` header

### 5.5 White-Label Branding

- `POST /api/settings/branding` — logo, colores, nombre
- CSS custom properties overridables por tenant
- Dominio custom (CNAME)

### 5.6 Onboarding/Offboarding

- Páginas `onboarding.html` y `offboarding.html` (mockup)
- Asignación de roles sugeridos por departamento
- Revocación de accesos con conteo de días restantes
- Trigger automático desde HR master data (Excel upload)

### Validación

- [ ] Login con Azure AD funciona
- [ ] Recordatorio email se envía 7 días antes del deadline
- [ ] Cambiar idioma a ES → toda la UI se traduce
- [ ] API key permite leer audit trail sin JWT
- [ ] Logo del cliente aparece en self-hosted

---

## Fase 6 — Polish & Launch (3-4 días)

**Objetivo:** Pulido final, pruebas, documentación, y lanzamiento público.

### 6.1 Polish UI

- Transiciones suaves entre páginas
- Skeletons de carga mientras se obtienen datos
- Estados vacíos diseñados para cada página
- Tooltips en iconos y acciones
- Atajos de teclado (Ctrl+K search, Ctrl+Enter submit)
- Responsive: sidebar colapsable en móvil

### 6.2 Testing

- Tests E2E con Playwright para los 7 casos de uso del plan original
- Pruebas de carga: 50 approvers simultáneos
- Pruebas de seguridad: OWASP Top 10 básico

### 6.3 Documentación

- `docs/USER-GUIDE.md` — guía de usuario final
- `docs/ADMIN-GUIDE.md` — guía de administrador
- `docs/API-REFERENCE.md` — documentación de API
- `docs/DEPLOY-GUIDE.md` — guía de despliegue (SaaS + Self-Hosted)

### 6.4 Launch

- Landing page publicada en `attest.app`
- Blog post de lanzamiento
- Listado en AWS Marketplace + GCP Marketplace (self-hosted)
- Demo video de 2 minutos

---

## 📊 Resumen de Fases

| Fase | Qué entrega | Esfuerzo | Depende de |
|---|---|---|---|
| **1** Dashboard | KPIs reales, gráficos, actividad | 3-4 días | Fase 0 (MVP) |
| **2** Campañas | CRUD campañas, workflow, plantillas | 4-5 días | Fase 1 |
| **3** SoD + Evidence | Reglas SoD, conflictos, paquetes evidencia | 4-5 días | Fase 2 |
| **4** Multi-Tenant | Aislamiento datos, selector tenant, tiers | 5-6 días | Fase 3 |
| **5** Enterprise | SSO, i18n, notificaciones, API keys, white-label | 5-7 días | Fase 4 |
| **6** Launch | Polish, tests, docs, lanzamiento | 3-4 días | Fase 5 |
| **Total** | **App completa según mockup** | **24-31 días** | |

---

## 🏗️ Arquitectura técnica objetivo

```
┌─────────────────────────────────────────────────────┐
│                  Frontend (SPA estático)             │
│  dashboard · campaigns · review · sod · evidence    │
│  admin · settings · tenants · api-keys · onboarding │
│  CSS variables · dark mode · i18n · Inter font      │
└──────────────────────┬──────────────────────────────┘
                       │ REST + JWT
┌──────────────────────▼──────────────────────────────┐
│              Backend (Node.js + Express)             │
│  server.js — API routes                             │
│  ┌──────────┬──────────┬──────────┬──────────┐      │
│  │ auth     │ campaign │ sod      │ evidence │      │
│  │ review   │ admin    │ tenant   │ settings │      │
│  │ upload   │ activity │ users    │ api-keys │      │
│  └──────────┴──────────┴──────────┴──────────┘      │
│  Middleware: JWT · tenant · admin · upload           │
└──────────────────────┬──────────────────────────────┘
                       │ better-sqlite3
┌──────────────────────▼──────────────────────────────┐
│              SQLite (volumen persistente)            │
│  submissions · activity · admin_users · campaigns   │
│  sod_rules · sod_conflicts · evidence · tenants     │
│  api_keys · settings · audit_log                    │
└─────────────────────────────────────────────────────┘
```

---

## 🚀 Estrategia de despliegue

| Modelo | Infra | Público |
|---|---|---|
| **SaaS** | Fly.io (esta instancia) | Startups, PYMEs, consultoras |
| **Self-Hosted** | Docker en AWS/GCP/Azure del cliente | Banca, seguros, gobierno, healthcare |

Ambos usan el mismo código base. La diferencia es configuración: `MULTI_TENANT=true` para SaaS, `MULTI_TENANT=false` para self-hosted.

---

> **Principio rector:** El mockup [`mockup-futuro.html`](mockup-futuro.html) es el norte. Cada fase acerca la app real a esa experiencia. No se construye nada que no esté en el mockup sin antes actualizar el mockup.
