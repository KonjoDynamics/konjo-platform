FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
