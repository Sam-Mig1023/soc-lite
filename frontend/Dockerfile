# =====================================================================
# SOC-Lite · Frontend (build multi-stage + servidor nginx interno)
# =====================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# La URL de la API se inyecta en tiempo de build (Vite la serializa en el bundle).
# Por defecto es relativa (/api/v1) para que funcione detrás del proxy inverso.
ARG VITE_API_URL=/api/v1
ARG VITE_APP_NAME=SOC-Lite
ENV VITE_API_URL=$VITE_API_URL \
    VITE_APP_NAME=$VITE_APP_NAME

COPY package.json ./
# `--no-frozen-lockfile` permite construir aunque el lockfile aún no exista.
RUN npm install --no-audit --no-fund --no-package-lock

COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Configuración propia del SPA (history fallback + caché de estáticos)
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
