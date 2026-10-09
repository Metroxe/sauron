# Sauron — single image, runs the Eye by default, the canary via command override.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
# tsx + typescript are needed at runtime (we run TS directly), so install all deps.
RUN npm install
COPY . .
ENV SAURON_PORT=7777
EXPOSE 7777
# The Eye (dashboard + API + gateway). Override CMD to run the canary.
CMD ["npx", "tsx", "src/server.ts"]
