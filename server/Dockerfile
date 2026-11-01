# ============ Dockerfile: la imagen del servidor (juego, API, cooperativo, SQLite) ============
# Se construye desde la raíz del repositorio (hace falta el juego entero):
#   docker build -f server/Dockerfile --build-arg SITE_URL=https://tu.web -t ps .
#   docker run -p 8787:8787 -v ps-data:/data -e CODE_PEPPER=<secreto> -e SITE_URL=https://tu.web ps
# SITE_URL al construir: la dirección que va en el juego (canonical, «Web oficial»);
# al arrancar: la que mira el servidor (Origin, cookie). La misma en los dos.
# La base de datos vive en el volumen /data. bookworm-slim y no Alpine:
# better-sqlite3 trae binarios ya compilados para glibc.

# ---------- 1: construir el juego e instalar el servidor ----------
FROM node:22-bookworm-slim AS build
WORKDIR /src
# Primero las dependencias: así un cambio en el juego no repite npm ci.
# --ignore-scripts: better-sqlite3 ya trae el binario de linux (prebuilds/) y
# el npm de node 22 intentaría compilarlo (sin Python ni compilador aquí).
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
# tools/build.js usa npx (terser y javascript-obfuscator): necesita red.
ARG SITE_URL=http://localhost:8787
RUN SITE_URL="$SITE_URL" node tools/build.js && node tools/export_data.js

# ---------- 2: la imagen final, sólo lo que se sirve y el servidor ----------
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /src/server ./server
# La fusión de partidas es la del juego (server/http/auth.js la carga de ../js/core).
COPY --from=build /src/js/core/save-merge.js ./js/core/save-merge.js
COPY --from=build /src/index.html /src/version.json /src/sw.js /src/manifest.webmanifest /src/favicon.ico ./public/
COPY --from=build /src/js ./public/js
COPY --from=build /src/css ./public/css
COPY --from=build /src/assets ./public/assets
ENV NODE_ENV=production STATIC_DIR=/app/public DB_PATH=/data/ps.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
CMD ["node", "server/index.js"]
