# ============ Dockerfile: imagen del servidor del cooperativo ============
# Se construye desde la raíz del repositorio (hace falta js/data/room-words.js,
# la lista de los códigos, que comparte con el juego):
#   docker build -f relay/Dockerfile .
#   fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile
# relay/Dockerfile.dockerignore deja fuera todo lo demás.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app/relay

COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY js/data/room-words.js /app/js/data/room-words.js
COPY relay/*.js ./

USER node
EXPOSE 8080
CMD ["node", "server.js"]
